// Image generation with FLUX.1 [schnell] on a RunPod serverless endpoint, plus storage of
// signed-in users' images in Upstash.
//
//   POST /api/image          { prompt }  -> Server-Sent Events: waking / generating / { image }
//   PUT  /api/image          { data }    -> { id }   (save a JPEG data URL; signed-in users)
//   GET  /api/image?id=...   (&u=user for admins)    -> the image

const crypto = require("crypto");
const { sendJson, readBody, logEvent, checkAccess, clientInfo, RUNPOD_API_KEY } = require("./handlers");
const { currentUser, isAdminAccount } = require("./session");
const store = require("./store");

const IMAGE_ENDPOINT_ID = process.env.RUNPOD_IMAGE_ENDPOINT_ID || "";
const IMAGE_URL = IMAGE_ENDPOINT_ID ? `https://api.runpod.ai/v2/${IMAGE_ENDPOINT_ID}` : "";
const IMAGE_ON = !!(RUNPOD_API_KEY && IMAGE_ENDPOINT_ID);
const DAILY_LIMIT = { user: 25, guest: 5 }; // admins are unlimited
const MAX_WAIT_MS = 280_000; // stay under Vercel's 300 s function limit

// ---------- Safety filter ----------
// A keyword screen, not a guarantee: blocks explicit content, anything sexual involving
// minors, graphic gore, and realistic images of real, named people.
const EXPLICIT = /\b(nude|nudes|nudity|naked|nsfw|porn\w*|sex|sexy|sexual\w*|erotic\w*|topless|bottomless|lingerie|genital\w*|nipples?|hentai|fetish\w*|onlyfans|xxx|undress\w*|strip(per|ping|tease)?)\b/i;
const MINORS = /\b(child|children|kids?|minors?|teens?|teenage\w*|underage|toddlers?|bab(y|ies)|little (girl|boy)|schoolgirls?|schoolboys?|loli\w*|shota\w*|preteen\w*)\b/i;
const SUGGESTIVE = /\b(bikini|swimsuit|seductive|provocative|kissing|in bed|bath(ing)?|shower\w*)\b/i;
const GORE = /\b(gore|gory|decapitat\w*|dismember\w*|behead\w*|mutilat\w*|disembowel\w*|corpse|dead bod(y|ies))\b/i;
const FAMOUS = /\b(trump|biden|obama|kamala|harris|putin|zelensk\w*|xi jinping|netanyahu|trudeau|musk|zuckerberg|bezos|bill gates|taylor swift|beyonc[eé]|rihanna|kardashian|kanye|drake|ariana grande|selena gomez|billie eilish|the rock|dwayne johnson|tom cruise|keanu|messi|ronaldo|lebron|pope francis|king charles|prince harry|meghan markle|mrbeast)\b/i;
const REALISTIC = /\b(photo\w*|realistic|hyper-?realistic|selfie|portrait|candid|cctv|footage|mugshot|news|paparazzi)\b/i;
// "photo of Jane Smith"-style names; common place words are ignored so "realistic photo of New York" is fine.
const NAME = /\b([A-Z][a-z]+) ([A-Z][a-z]+)\b/g;
const PLACE_WORDS = /^(New|York|San|Los|Las|Angeles|Francisco|Vegas|Golden|Gate|Bridge|Park|City|Street|Square|Mount|Lake|River|Tower|Central|Grand|Canyon|Great|Wall|Eiffel|Times|Statue|Liberty|North|South|East|West|United|States|Kingdom|Hong|Kong|Rio|Janeiro|Death|Valley|Niagara|Falls|Big|Ben|Machu|Picchu|Taj|Mahal)$/;

function screenPrompt(prompt) {
  if (EXPLICIT.test(prompt)) return "Explicit images aren't allowed.";
  if (MINORS.test(prompt) && SUGGESTIVE.test(prompt)) return "That prompt isn't allowed.";
  if (GORE.test(prompt)) return "Graphic gore isn't allowed.";
  if (FAMOUS.test(prompt)) return "Images of real, named people aren't allowed.";
  if (REALISTIC.test(prompt)) {
    for (const [, a, b] of prompt.matchAll(NAME)) {
      if (!PLACE_WORDS.test(a) && !PLACE_WORDS.test(b)) return "Realistic images of real, named people aren't allowed.";
    }
  }
  return null;
}

// ---------- RunPod ----------
const auth = () => ({ Authorization: `Bearer ${RUNPOD_API_KEY}`, "Content-Type": "application/json" });

// Pulls a base64 image out of the worker's output, whatever shape it comes in
// (vLLM-Omni returns OpenAI-style { data: [{ b64_json }], output_format }).
function extractImage(output) {
  const mime = { jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp", png: "image/png" }[output?.output_format] || "image/png";
  const found = [];
  const walk = (v) => {
    if (typeof v === "string") {
      if (/^data:image\//.test(v)) found.push(v);
      else if (v.length > 1000 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 200))) found.push(`data:${mime};base64,${v.replace(/\s/g, "")}`);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(output);
  return found[0] || null;
}

async function generate(req, res) {
  if (!(await checkAccess(req, res))) return;
  if (!IMAGE_ON) return sendJson(res, 503, { error: "Image generation isn't set up right now." });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid request" }); }
  const prompt = String(body.prompt || "").trim().slice(0, 1000);
  if (!prompt) return sendJson(res, 400, { error: "Describe the image you want." });

  const blocked = screenPrompt(prompt);
  if (blocked) {
    await logEvent(req, { type: "image", prompt, blocked: true, conversationId: String(body.conversationId || "").slice(0, 64) || undefined });
    return sendJson(res, 400, { error: blocked, blocked: true });
  }

  const user = currentUser(req);
  if (store.STORE_ON && !isAdminAccount(user)) {
    const who = user ? `img:u:${user.toLowerCase()}` : `img:g:${clientInfo(req).visitorId || clientInfo(req).ip}`;
    const limit = user ? DAILY_LIMIT.user : DAILY_LIMIT.guest;
    const used = await store.countToday(who).catch(() => 0); // if the count fails, don't block anyone
    if (used > limit) {
      return sendJson(res, 429, { error: `You've reached today's limit of ${limit} images${user ? "" : ". Create an account for more"}.` });
    }
  }

  const job = await fetch(`${IMAGE_URL}/run`, {
    method: "POST",
    headers: auth(),
    // schnell is distilled for 4 steps (~4 s on an A40; the worker's default is far slower).
    // WebP keeps the image ~150–250 KB on the way back.
    body: JSON.stringify({
      input: { prompt, size: "1024x1024", seed: crypto.randomInt(1, 2 ** 31), num_inference_steps: 4, output_format: "webp" },
    }),
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json()).catch(() => null);
  if (!job?.id) return sendJson(res, 502, { error: "Couldn't reach the image GPU. Try again in a moment." });

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const started = Date.now();
  let closed = false;
  res.on("close", () => {
    if (!closed) fetch(`${IMAGE_URL}/cancel/${job.id}`, { method: "POST", headers: auth() }).catch(() => {}); // user left: don't pay for it
    closed = true;
  });

  while (!closed) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (Date.now() - started > MAX_WAIT_MS) {
      fetch(`${IMAGE_URL}/cancel/${job.id}`, { method: "POST", headers: auth() }).catch(() => {});
      send({ error: "The image GPU is still starting. Try again in a minute." });
      break;
    }
    const s = await fetch(`${IMAGE_URL}/status/${job.id}`, { headers: auth(), signal: AbortSignal.timeout(15000) })
      .then((r) => r.json()).catch(() => null);
    if (s?.status === "COMPLETED") {
      const image = extractImage(s.output);
      if (image) {
        send({ image, ms: Date.now() - started });
        await logEvent(req, { type: "image", prompt, ms: Date.now() - started, conversationId: String(body.conversationId || "").slice(0, 64) || undefined });
      } else send({ error: "The image GPU returned no image." });
      break;
    }
    if (s && ["FAILED", "CANCELLED", "TIMED_OUT"].includes(s.status)) {
      send({ error: "Image generation failed. Try a different prompt." });
      break;
    }
    send({ state: s?.status === "IN_PROGRESS" ? "generating" : "waking", elapsed });
    await new Promise((r) => setTimeout(r, 1500));
  }
  closed = true;
  res.end();
}

async function save(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "Not signed in" });
  if (!store.STORE_ON) return sendJson(res, 503, { error: "Image saving isn't available right now" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid request" }); }
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(body.data || ""))) return sendJson(res, 400, { error: "Invalid image" });
  const id = crypto.randomUUID();
  const r = await store.putImage(user, id, body.data);
  sendJson(res, r.error ? r.status : 200, r.error ? { error: r.error } : { id });
}

async function serve(req, res) {
  const params = new URL(req.url, "http://x").searchParams;
  const user = currentUser(req);
  // Owners see their own images; admins can view anyone's (from the dashboard).
  const owner = isAdminAccount(user) && params.get("u") ? params.get("u") : user;
  const id = params.get("id") || "";
  if (!owner || !/^[0-9a-f-]{36}$/.test(id) || !store.STORE_ON) return sendJson(res, 404, { error: "Not found" });
  const dataUrl = await store.getImage(owner, id).catch(() => null);
  if (!dataUrl) return sendJson(res, 404, { error: "Not found" });
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": buf.length, "Cache-Control": "private, max-age=31536000, immutable" });
  res.end(buf);
}

async function handleImage(req, res) {
  try {
    if (req.method === "POST") return await generate(req, res);
    if (req.method === "PUT") return await save(req, res);
    if (req.method === "GET") return await serve(req, res);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong. Try again." });
    else { res.write(`data: ${JSON.stringify({ error: "Something went wrong. Try again." })}\n\n`); res.end(); }
  }
}

module.exports = { handleImage, screenPrompt, extractImage, IMAGE_ON };
