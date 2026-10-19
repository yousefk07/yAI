// Image and video generation on RunPod serverless ComfyUI endpoints (see lib/media-config.js),
// plus storage of signed-in users' results in Upstash.
//
// A job is started, then polled by the browser, so a slow video never runs into Vercel's
// function time limit:
//   POST   /api/image          { kind: "image"|"video", prompt, image?, aspect? } -> { job }
//   GET    /api/image?job=...  -> { state: "waking"|"generating", elapsed } | { image } | { video: { id } }
//   DELETE /api/image?job=...  cancels the job (the user pressed stop or left)
//   PUT    /api/image          { data, job }  -> { id }   (save a JPEG data URL; signed-in users)
//   GET    /api/image?id=...   the saved image (&u=user for admins)
//   GET    /api/image?video=... the saved video, streamed

const crypto = require("crypto");
const { sendJson, readBody, logEvent, checkAccess, clientInfo } = require("./handlers");
const { currentUser, isAdminAccount, safeEqual } = require("./session");
const { RUNPOD_API_KEY, WORKFLOWS, ENDPOINTS, enabled } = require("./media-config");
const store = require("./store");

// Per day. Admins are unlimited; guests can't make videos (they need an account to store them).
const DAILY_LIMIT = { image: { user: 25, guest: 5 }, video: { user: 2, guest: 0 } };
const JOB_TTL_MS = { image: 6 * 60_000, video: 20 * 60_000 }; // give up after this, including a cold start
const LABELS = { image: "Qwen-Image 2.1", edit: "Qwen-Image 2.1 Edit", video: "MiniMax H3" };
// Output sizes per shape (multiples of 32). Videos stay around 0.4 MP so every shape costs about the same.
// Edits follow the input photo's shape on their own.
const SIZES = {
  image: { "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344] },
  video: { "16:9": [864, 480], "9:16": [480, 864], "1:1": [640, 640] },
};

// ---------- Safety filter ----------
// A keyword screen, not a guarantee: blocks explicit content, anything sexual involving
// minors, graphic gore, and realistic images of real, named people.
const EXPLICIT = /\b(nude|nudes|nudity|naked|nsfw|porn\w*|sex|sexy|sexual\w*|erotic\w*|topless|bottomless|lingerie|genital\w*|nipples?|hentai|fetish\w*|onlyfans|xxx|undress\w*|strip(per|ping|tease)?)\b/i;
const MINORS = /\b(child|children|kids?|minors?|teens?|teenage\w*|underage|toddlers?|bab(y|ies)|little (girl|boy)|schoolgirls?|schoolboys?|loli\w*|shota\w*|preteen\w*)\b/i;
const SUGGESTIVE = /\b(bikini|swimsuit|seductive|provocative|kissing|in bed|bath(ing)?|shower\w*)\b/i;
const GORE = /\b(gore|gory|decapitat\w*|dismember\w*|behead\w*|mutilat\w*|disembowel\w*|corpse|dead bod(y|ies))\b/i;
const FAMOUS = /\b(trump|biden|obama|kamala|harris|putin|zelensk\w*|xi jinping|netanyahu|trudeau|musk|zuckerberg|bezos|bill gates|taylor swift|beyonc[eé]|rihanna|kardashian|kanye|drake|ariana grande|selena gomez|billie eilish|the rock|dwayne johnson|tom cruise|keanu|messi|ronaldo|lebron|pope francis|king charles|prince harry|meghan markle|mrbeast)\b/i;
const REALISTIC = /\b(photo\w*|realistic|hyper-?realistic|selfie|portrait|candid|cctv|footage|mugshot|news|paparazzi)\b/i;
const DEEPFAKE = /\b(deep ?fakes?|face ?swap\w*|swap (his|her|their|the) face)\b/i;
// "photo of Jane Smith"-style names; common place words are ignored so "realistic photo of New York" is fine.
const NAME = /\b([A-Z][a-z]+) ([A-Z][a-z]+)\b/g;
const PLACE_WORDS = /^(New|York|San|Los|Las|Angeles|Francisco|Vegas|Golden|Gate|Bridge|Park|City|Street|Square|Mount|Lake|River|Tower|Central|Grand|Canyon|Great|Wall|Eiffel|Times|Statue|Liberty|North|South|East|West|United|States|Kingdom|Hong|Kong|Rio|Janeiro|Death|Valley|Niagara|Falls|Big|Ben|Machu|Picchu|Taj|Mahal)$/;

function screenPrompt(prompt) {
  if (EXPLICIT.test(prompt)) return "Explicit content isn't allowed.";
  if (MINORS.test(prompt) && SUGGESTIVE.test(prompt)) return "That prompt isn't allowed.";
  if (GORE.test(prompt)) return "Graphic gore isn't allowed.";
  if (DEEPFAKE.test(prompt)) return "Face swaps and deepfakes aren't allowed.";
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
const endpointUrl = (endpoint) => `https://api.runpod.ai/v2/${ENDPOINTS[endpoint]}`;

// Fills a workflow: "$prompt" and "$image" placeholders, a fresh random seed and, if given, the
// output size. Without an input image, the image loader is removed along with every link to it
// (text → video).
function buildWorkflow(endpoint, prompt, hasImage, size) {
  const wf = structuredClone(WORKFLOWS[endpoint]);
  const dropped = new Set();
  for (const [id, node] of Object.entries(wf)) {
    if (!hasImage && node.class_type === "LoadImage" && node.inputs?.image === "$image") dropped.add(id);
  }
  for (const id of dropped) delete wf[id];
  for (const node of Object.values(wf)) {
    if (size && typeof node.inputs?.width === "number" && typeof node.inputs?.height === "number") {
      [node.inputs.width, node.inputs.height] = size;
    }
    for (const [k, v] of Object.entries(node.inputs || {})) {
      if (v === "$prompt") node.inputs[k] = prompt;
      else if (v === "$image") node.inputs[k] = "input.jpg";
      else if ((k === "seed" || k === "noise_seed") && typeof v === "number") node.inputs[k] = crypto.randomInt(1, 2 ** 47);
      else if (Array.isArray(v) && dropped.has(String(v[0]))) delete node.inputs[k];
    }
  }
  return wf;
}

// Identifies a base64 file by its first bytes.
function sniff(b64) {
  const b = Buffer.from(b64.slice(0, 24), "base64");
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("latin1", 4, 8) === "ftyp") return "video/mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return null;
}

// Pulls every base64 file out of the worker's output, whatever shape it comes in.
function extractMedia(output) {
  const found = [];
  const walk = (v) => {
    if (typeof v === "string") {
      const m = v.match(/^data:([\w/+.-]+);base64,(.+)$/s);
      if (m) found.push({ mime: m[1], b64: m[2] });
      else if (v.length > 1000 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 200))) {
        const b64 = v.replace(/\s/g, ""), mime = sniff(b64);
        if (mime) found.push({ mime, b64 });
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(output);
  return found;
}

// ---------- Job tokens ----------
// The browser holds a signed token naming the job, its endpoint and its owner, so nobody
// can poll or cancel someone else's job.
const KEY = crypto.createHmac("sha256", process.env.SESSION_SECRET || `${process.env.BRIDGE_TOKEN || ""}:${process.env.ADMIN_PASSWORD || ""}`)
  .update("yai-media-jobs").digest();
const sign = (data) => crypto.createHmac("sha256", KEY).update(data).digest("base64url");
const ownerOf = (req) => { const u = currentUser(req); return u ? `u:${u}` : `g:${clientInfo(req).visitorId || clientInfo(req).ip}`; };

function makeToken(job) {
  const data = Buffer.from(JSON.stringify(job)).toString("base64url");
  return `${data}.${sign(data)}`;
}
function readToken(req, token) {
  const [data, sig] = String(token || "").split(".");
  if (!data || !sig || !safeEqual(sig, sign(data))) return null;
  try {
    const job = JSON.parse(Buffer.from(data, "base64url").toString());
    return job.o === ownerOf(req) ? job : null;
  } catch { return null; }
}

// Saved results are keyed by an id derived from the job id, so it's known when the job starts
// (the activity log records it for the admin dashboard) and saving twice saves once.
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const videoIdFor = (jobId) => sha(jobId).slice(0, 32);
const imageIdFor = (jobId) => sha(`img:${jobId}`).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");

// ---------- Handlers ----------
async function start(req, res) {
  if (!(await checkAccess(req, res))) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid request" }); }
  const kind = body.kind === "video" ? "video" : "image";
  const prompt = String(body.prompt || "").trim().slice(0, 2000);
  const image = String(body.image || "");
  const hasImage = !!image;
  if (hasImage && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) return sendJson(res, 400, { error: "Invalid image" });
  if (hasImage && image.length > 3_000_000) return sendJson(res, 413, { error: "That image is too large." });
  // Photo → video crashed ComfyUI on the 48 GB worker (likely out of memory) and left it unable to
  // serve any video until restarted, so it's off until that's fixed.
  if (kind === "video" && hasImage) return sendJson(res, 400, { error: "Animating a photo is turned off for now. Describe the video instead." });
  const endpoint = kind === "video" ? "video" : hasImage ? "edit" : "image";
  if (!enabled(endpoint)) {
    return sendJson(res, 503, { error: endpoint === "edit" ? "Photo editing isn't set up yet." : `${kind === "video" ? "Video" : "Image"} generation isn't set up right now.` });
  }
  if (!prompt) return sendJson(res, 400, { error: kind === "video" ? "Describe the video you want." : hasImage ? "Describe how to change the image." : "Describe the image you want." });

  const conversationId = String(body.conversationId || "").slice(0, 64) || undefined;
  const blocked = screenPrompt(prompt);
  if (blocked) {
    await logEvent(req, { type: endpoint, prompt, blocked: true, conversationId });
    return sendJson(res, 400, { error: blocked, blocked: true });
  }

  const user = currentUser(req);
  if (!isAdminAccount(user)) {
    const limit = DAILY_LIMIT[kind][user ? "user" : "guest"];
    if (!limit) return sendJson(res, 403, { error: "Log in or create an account to make videos." });
    if (store.STORE_ON) {
      const used = await store.countToday(`${kind}:${ownerOf(req)}`).catch(() => 0); // if the count fails, don't block anyone
      if (used > limit) {
        return sendJson(res, 429, { error: `You've reached today's limit of ${limit} ${kind}s${user ? "" : ". Create an account for more"}.` });
      }
    }
  }

  const size = endpoint === "edit" ? null : SIZES[kind][body.aspect] || Object.values(SIZES[kind])[0];
  const input = { workflow: buildWorkflow(endpoint, prompt, hasImage, size) };
  if (hasImage) input.images = [{ name: "input.jpg", image: image.split(",")[1] }];
  const job = await fetch(`${endpointUrl(endpoint)}/run`, {
    method: "POST", headers: auth(), body: JSON.stringify({ input }), signal: AbortSignal.timeout(15000),
  }).then((r) => r.json()).catch(() => null);
  if (!job?.id) return sendJson(res, 502, { error: `Couldn't reach the ${kind} GPU. Try again in a moment.` });

  // Only signed-in users' results are saved, so only they get a viewable mediaId.
  const mediaId = user ? (kind === "video" ? videoIdFor(job.id) : imageIdFor(job.id)) : undefined;
  await logEvent(req, { type: endpoint, prompt, conversationId, withImage: hasImage || undefined, mediaId });
  sendJson(res, 200, { job: makeToken({ j: job.id, e: endpoint, k: kind, o: ownerOf(req), t: Date.now() }), label: LABELS[endpoint] });
}

async function poll(req, res, token) {
  const job = readToken(req, token);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  const url = endpointUrl(job.e);
  const elapsed = Math.round((Date.now() - job.t) / 1000);
  if (Date.now() - job.t > JOB_TTL_MS[job.k]) {
    fetch(`${url}/cancel/${job.j}`, { method: "POST", headers: auth() }).catch(() => {});
    return sendJson(res, 200, { error: `The ${job.k} GPU is taking too long. Try again in a minute.` });
  }
  const s = await fetch(`${url}/status/${job.j}`, { headers: auth(), signal: AbortSignal.timeout(20000) })
    .then((r) => r.json()).catch(() => null);
  if (!s?.status || s.status === "IN_QUEUE") return sendJson(res, 200, { state: "waking", elapsed });
  if (s.status === "IN_PROGRESS") return sendJson(res, 200, { state: "generating", elapsed });
  if (s.status !== "COMPLETED") return sendJson(res, 200, { error: `${job.k === "video" ? "Video" : "Image"} generation failed. Try a different prompt.` });

  const media = extractMedia(s.output);
  const ms = Date.now() - job.t;
  if (job.k === "video") {
    const video = media.find((m) => m.mime.startsWith("video/"));
    const user = currentUser(req);
    if (!video) return sendJson(res, 200, { error: "The video GPU returned no video." });
    if (!user || !store.STORE_ON) return sendJson(res, 200, { error: "Videos can only be made while signed in." });
    const id = videoIdFor(job.j);
    const saved = await store.putVideo(user, id, video.mime, video.b64).catch(() => ({ error: "Couldn't save the video" }));
    if (saved.error) return sendJson(res, 200, { error: saved.error });
    return sendJson(res, 200, { video: { id }, ms });
  }
  const image = media.find((m) => m.mime.startsWith("image/"));
  if (!image) return sendJson(res, 200, { error: "The image GPU returned no image." });
  sendJson(res, 200, { image: `data:${image.mime};base64,${image.b64}`, ms });
}

async function cancel(req, res, token) {
  const job = readToken(req, token);
  if (job) await fetch(`${endpointUrl(job.e)}/cancel/${job.j}`, { method: "POST", headers: auth() }).catch(() => {});
  sendJson(res, 200, { ok: true });
}

async function save(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "Not signed in" });
  if (!store.STORE_ON) return sendJson(res, 503, { error: "Image saving isn't available right now" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid request" }); }
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(body.data || ""))) return sendJson(res, 400, { error: "Invalid image" });
  const job = body.job && readToken(req, body.job);
  const id = job ? imageIdFor(job.j) : crypto.randomUUID();
  const r = await store.putImage(user, id, body.data);
  sendJson(res, r.error ? r.status : 200, r.error ? { error: r.error } : { id });
}

async function serve(req, res, params) {
  const user = currentUser(req);
  // Owners see their own images and videos; admins can view anyone's (from the dashboard).
  const owner = isAdminAccount(user) && params.get("u") ? params.get("u") : user;
  if (!owner || !store.STORE_ON) return sendJson(res, 404, { error: "Not found" });

  const videoId = params.get("video");
  if (videoId) {
    if (!/^[0-9a-f]{32}$/.test(videoId)) return sendJson(res, 404, { error: "Not found" });
    const video = await store.getVideo(owner, videoId).catch(() => null);
    if (!video) return sendJson(res, 404, { error: "Not found" });
    // Streamed chunk by chunk, which also keeps it under the 4.5 MB limit for buffered responses.
    res.writeHead(200, { "Content-Type": video.mime, "Cache-Control": "private, max-age=2592000, immutable" });
    for (let i = 0; i < video.n; i++) res.write(Buffer.from((await video.chunk(i)) || "", "base64"));
    return res.end();
  }

  const id = params.get("id") || "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return sendJson(res, 404, { error: "Not found" });
  const dataUrl = await store.getImage(owner, id).catch(() => null);
  if (!dataUrl) return sendJson(res, 404, { error: "Not found" });
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": buf.length, "Cache-Control": "private, max-age=31536000, immutable" });
  res.end(buf);
}

async function handleImage(req, res) {
  try {
    const params = new URL(req.url, "http://x").searchParams;
    if (req.method === "POST") return await start(req, res);
    if (req.method === "PUT") return await save(req, res);
    if (req.method === "DELETE") return await cancel(req, res, params.get("job"));
    if (req.method === "GET") return params.get("job") ? await poll(req, res, params.get("job")) : await serve(req, res, params);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong. Try again." });
    else res.end();
  }
}

module.exports = { handleImage, screenPrompt, extractMedia, buildWorkflow };
