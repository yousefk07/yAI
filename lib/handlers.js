// API handlers shared by the local dev server (server.js) and the Vercel
// functions (api/*.js). They forward requests to LM Studio's OpenAI-compatible
// API, either directly (local) or through bridge.js over a tunnel (Vercel).

const crypto = require("crypto");
const { currentUser } = require("./session");
const store = require("./store");

const LMSTUDIO_URL = (process.env.LMSTUDIO_URL || "http://localhost:1234/v1").replace(/\/$/, "");
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const DEFAULT_MODEL = process.env.MODEL || "";
// Optional cloud model on a RunPod serverless vLLM endpoint (scales to zero; the first request after idle wakes a GPU).
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || "";
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID || "";
const RUNPOD_URL = RUNPOD_ENDPOINT_ID ? `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}` : "";
const CLOUD_ON = !!(RUNPOD_API_KEY && RUNPOD_ENDPOINT_ID);
const { features: mediaFeatures } = require("./media-config"); // image/video endpoints (lib/images.js)
const CLOUD_MAX_TOKENS = 2048; // cap answer length: the cloud GPU is billed per second
// The terminal agent (cli/) sends its own system prompt, needs longer tool loops and room to write files.
// Only signed-in users can use agent mode.
const AGENT_MAX_TOKENS = 4096;
const AGENT_MAX_HISTORY = 400;
const AGENT_MAX_SYSTEM = 60000;
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "Your name is yAI. Only mention your name if the user asks who you are or what you're called. " +
    "Always reply in the same language the user writes in; if they write in English, reply only in English " +
    "(no greetings or words from other languages). " +
    "Never introduce yourself, and don't open replies with greetings like \"Hello!\" or \"Hi there!\". " +
    "If the user greets you, greet them back warmly in a few words. Otherwise get straight to the answer. Be friendly, clear and concise, " +
    "and use Markdown formatting (lists, bold, code blocks, tables) when it helps readability. " +
    "Write math in LaTeX: $...$ for inline math and $$...$$ on its own line for display equations.";
// Models offered to users, in menu order (the first available one is the default),
// matched against LM Studio's model ids. Anything not listed is hidden and can't be requested.
// `desc` is shown under the name in the model menu (speeds measured on the host PC).
const MODELS = [
  { id: "qwen3.8-27b-cloud", match: /^qwen3\.8-27b-cloud$/, label: "Qwen 3.8 27B Max", vision: true, cloud: true,
    desc: "Strongest · cloud GPU · may take a minute to wake up" },
  { match: /qwen3\.5-4b.*uncensored/i, label: "Qwen 3.5 4B Uncensored", vision: true, desc: "Fast and capable · reads images" },
  { match: /phi-4-mini/i, label: "Phi 4 Mini", vision: false, desc: "Fastest · text only" },
  { match: /^gemma-4-e2b/i, label: "Gemma 4 E2B Uncensored", vision: true, desc: "Fast · reads images · shaky on facts" },
  { match: /qwen3\.5-2b/i, label: "Qwen 3.5 2B Distilled", vision: true, desc: "Very fast · thinks briefly first" },
  { match: /^qwen3\.5-0\.8b/i, label: "Qwen 3.5 0.8B", vision: true, desc: "Tiny · simple questions only" },
  { match: /^qwen3\.5-9b-uncensored-hauhaucs-aggressive$/, label: "Qwen 3.5 9B Uncensored", vision: true, desc: "Smarter · slow on this PC" },];
const FALLBACK_MODEL = "qwen3.5-9b-uncensored-hauhaucs-aggressive";
const modelEntry = (id) => (typeof id === "string" ? MODELS.find((m) => m.match.test(id)) : undefined);
const MAX_HISTORY = 40; // messages kept per request, to stay inside the context window
const MAX_BODY = 6_000_000; // images are inlined as base64; Vercel itself caps bodies at 4.5 MB
const MAX_IMAGES = 8;
const IMAGE_URL = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const THUMB_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

const upstreamHeaders = {
  "Content-Type": "application/json",
  "ngrok-skip-browser-warning": "1",
  ...(BRIDGE_TOKEN && { Authorization: `Bearer ${BRIDGE_TOKEN}` }),
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : undefined);

// A user message is plain text, or OpenAI-style parts: text plus inline (data:) images.
function cleanContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || !content.length) return null;
  const parts = [];
  for (const p of content) {
    if (p?.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text });
    else if (p?.type === "image_url" && typeof p.image_url?.url === "string" && IMAGE_URL.test(p.image_url.url)) {
      parts.push({ type: "image_url", image_url: { url: p.image_url.url } });
    } else return null;
  }
  return parts;
}
const textOf = (c) => (typeof c === "string" ? c : c.filter((p) => p.type === "text").map((p) => p.text).join("\n"));
const imagesIn = (c) => (typeof c === "string" ? 0 : c.filter((p) => p.type === "image_url").length);

// Attachment summaries (name, page count, small thumbnail) kept in the activity log.
function cleanAttachments(list) {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list.slice(0, 8).map((a) => ({
    kind: a?.kind === "pdf" ? "pdf" : "image",
    name: clip(String(a?.name || ""), 200),
    pages: Number.isInteger(a?.pages) ? a.pages : undefined,
    thumb: typeof a?.thumb === "string" && a.thumb.length < 60000 && THUMB_URL.test(a.thumb) ? a.thumb : undefined,
  }));
}

function clientInfo(req) {
  const h = req.headers;
  let city = h["x-vercel-ip-city"];
  try {
    city = city && decodeURIComponent(city);
  } catch {}
  return {
    visitorId: clip(h["x-visitor-id"], 64),
    ip: (h["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim(),
    country: h["x-vercel-ip-country"],
    region: h["x-vercel-ip-country-region"],
    city,
    ua: clip(h["user-agent"], 300),
  };
}

// Activity is stored by bridge.js on the LM Studio PC. Without a bridge
// (plain local dev) there is nowhere to store it, so logging is skipped.
// Stored in Upstash when configured (works with the PC off), otherwise by the bridge.
async function logEvent(req, event) {
  const record = { ts: new Date().toISOString(), ...clientInfo(req), user: currentUser(req) || undefined, ...event };
  try {
    if (store.STORE_ON) return await store.addEvent(record);
    if (!BRIDGE_TOKEN) return;
    await fetch(`${LMSTUDIO_URL}/activity`, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

// Returns true if the request may proceed; otherwise responds with 401.
async function checkAccess(req, res) {
  if (currentUser(req)) return true; // signed-in users never need the access code
  const code = req.headers["x-access-code"] || "";
  if (!ACCESS_CODE || safeEqual(code.trim().toLowerCase(), ACCESS_CODE.toLowerCase())) return true;
  if (code) await logEvent(req, { type: "denied", codeTried: clip(code, 60) });
  sendJson(res, 401, { error: "Access code required", needsCode: true });
  return false;
}

function readBody(req) {
  // Vercel's Node runtime pre-parses JSON bodies onto req.body.
  if (req.body !== undefined) {
    return Promise.resolve(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const unreachable = (err) =>
  `Can't reach the local model. Is LM Studio running${BRIDGE_TOKEN ? " with the bridge and tunnel up" : ""}? (${err.message})`;

async function handleModels(req, res) {
  if (!(await checkAccess(req, res))) return;
  if (new URL(req.url, "http://x").searchParams.has("visit")) await logEvent(req, { type: "visit" });
  // Cloud models are listed even when the PC (and so every local model) is offline.
  const cloud = CLOUD_ON
    ? MODELS.filter((m) => m.cloud).map(({ id, label, vision, desc }) => ({ id, label, vision, desc }))
    : [];
  try {
    const r = await fetch(`${LMSTUDIO_URL}/models`, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`upstream returned ${r.status}`);
    const data = await r.json();
    const ids = (data.data || []).map((m) => m.id);
    const local = MODELS.filter((m) => !m.cloud).map((entry) => {
      // Prefer a plain edition over a "-reasoning" one: those always think, which is slow.
      const id = ids.filter((i) => entry.match.test(i)).sort((a, b) => /reasoning/i.test(a) - /reasoning/i.test(b))[0];
      return id && { id, label: entry.label, vision: entry.vision, desc: entry.desc };
    }).filter(Boolean);
    // The cloud model is listed first (strongest), but a local model stays the default (Qwen 3.5 4B).
    const models = [...cloud, ...local];
    const fallback = models.find((m) => m.id === DEFAULT_MODEL) || local[0] || cloud[0];
    sendJson(res, 200, { models, default: fallback ? fallback.id : "", ...mediaFeatures() });
  } catch (err) {
    if (cloud.length) return sendJson(res, 200, { models: cloud, default: cloud[0].id, localOffline: true, ...mediaFeatures() });
    sendJson(res, 502, { error: unreachable(err) });
  }
}

async function handleChat(req, res) {
  if (!(await checkAccess(req, res))) return;
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  const agent = payload.agent === true && typeof payload.system === "string" && !!currentUser(req);
  if (payload.agent === true && !agent) return sendJson(res, 401, { error: "Sign in to use yAI Code" });
  const history = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = history
    .filter((m) => m && ["user", "assistant"].includes(m.role))
    .map((m) => ({ role: m.role, content: m.role === "user" ? cleanContent(m.content) : m.content }))
    .filter((m) => typeof m.content === "string" || Array.isArray(m.content))
    .slice(-(agent ? AGENT_MAX_HISTORY : MAX_HISTORY));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return sendJson(res, 400, { error: "Last message must be from the user" });
  }
  if (messages.reduce((n, m) => n + imagesIn(m.content), 0) > MAX_IMAGES) {
    return sendJson(res, 400, { error: `Too many images (${MAX_IMAGES} max per message)` });
  }

  const temperature = Number.isFinite(payload.temperature)
    ? Math.min(Math.max(payload.temperature, 0), 2)
    : 0.7;
  const model = modelEntry(payload.model) ? payload.model : modelEntry(DEFAULT_MODEL) ? DEFAULT_MODEL : FALLBACK_MODEL;
  const allowed = modelEntry(model);
  if (allowed.cloud && !CLOUD_ON) return sendJson(res, 503, { error: "The cloud model isn't set up right now." });
  if (!allowed.vision) {
    if (imagesIn(messages[messages.length - 1].content)) {
      return sendJson(res, 400, { error: `${allowed.label} can't read images. Switch to a Qwen or Bonsai model, or remove the image.` });
    }
    // Images from earlier in the chat are dropped so text-only models can still follow up.
    for (const m of messages) if (Array.isArray(m.content)) m.content = textOf(m.content);
  }
  const started = Date.now();
  let answer = "";

  const record = (extra) =>
    logEvent(req, {
      type: "chat",
      conversationId: clip(payload.conversationId, 64),
      model: allowed.label,
      agent: agent || undefined,
      // The typed question only; PDF text appended by the client is left out of the log.
      question: clip(textOf(messages[messages.length - 1].content).split("\n\n[Attached ")[0], 20000),
      attachments: cleanAttachments(payload.attachments),
      answer: clip(answer, 50000),
      turn: messages.filter((m) => m.role === "user").length,
      ms: Date.now() - started,
      ...extra,
    });

  // Abort the upstream request if the browser disconnects (e.g. user hits Stop).
  const upstreamAbort = new AbortController();
  res.on("close", () => upstreamAbort.abort());

  let upstream;
  try {
    const base = {
      model,
      messages: [{ role: "system", content: agent ? payload.system.slice(0, AGENT_MAX_SYSTEM) : SYSTEM_PROMPT }, ...messages],
      temperature,
      chat_template_kwargs: { enable_thinking: false }, // thinking is always off: it's far slower
      stream: true,
      stream_options: { include_usage: true }, // exact token counts in the final chunk
    };
    upstream = allowed.cloud
      ? await fetch(`${RUNPOD_URL}/openai/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RUNPOD_API_KEY}` },
          signal: upstreamAbort.signal,
          body: JSON.stringify({ ...base, max_tokens: agent ? AGENT_MAX_TOKENS : CLOUD_MAX_TOKENS }),
        })
      : await fetch(`${LMSTUDIO_URL}/chat/completions`, {
          method: "POST",
          headers: upstreamHeaders,
          signal: upstreamAbort.signal,
          // LM Studio also needs reasoning_effort to turn thinking off for some models.
          body: JSON.stringify({ ...base, reasoning_effort: "none" }),
        });
  } catch (err) {
    await record({ error: "model unreachable" });
    return sendJson(res, 502, { error: unreachable(err) });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    let msg;
    try {
      const parsed = JSON.parse(text);
      msg = parsed.error?.message || parsed.error;
    } catch {
      // Tunnel/proxy error pages are HTML; never show them to users.
      msg = /<html/i.test(text) ? "The host PC isn't reachable right now" : text.slice(0, 300);
    }
    await record({ error: `model error ${upstream.status}` });
    return sendJson(res, 502, { error: `${msg || "The model returned an error"}. Please try again in a moment.` });
  }

  // Re-emit LM Studio's SSE stream as a simpler stream of our own events.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // If a model thinks anyway, drop its reasoning: never forward reasoning_content,
  // and strip inline <think>…</think> blocks, holding back a partial "<think" tag.
  // Each streamed delta is one token, so `t` gives the UI a live count (including any hidden
  // thinking); LM Studio's exact usage replaces it at the end.
  let raw = "", sent = 0, tokens = 0, usage;
  const pushContent = (piece) => {
    raw += piece;
    tokens++;
    answer = raw.replace(/<think>[\s\S]*?(<\/think>\s*|$)/g, "");
    let safe = answer.length;
    for (let i = Math.max(0, answer.length - 6); i < answer.length; i++) {
      if ("<think>".startsWith(answer.slice(i))) { safe = i; break; }
    }
    if (safe > sent) {
      emit({ content: answer.slice(sent, safe), t: tokens });
      sent = safe;
    } else if (tokens % 8 === 0) emit({ t: tokens });
  };

  const decoder = new TextDecoder();
  let buffer = "";
  let streamError;
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta || {};
          if (delta.content) pushContent(delta.content);
        } catch {}
      }
    }
    emit({ done: true, usage: { in: usage?.prompt_tokens, out: usage?.completion_tokens ?? tokens } });
  } catch (err) {
    if (!upstreamAbort.signal.aborted) {
      streamError = err.message;
      emit({ error: `Stream interrupted: ${err.message}` });
    }
  }
  // Log before ending: serverless functions may be frozen once the response closes.
  await record({
    stopped: upstreamAbort.signal.aborted || undefined,
    error: streamError,
    tokensIn: usage?.prompt_tokens,
    tokensOut: usage?.completion_tokens ?? tokens,
  });
  res.end();
}

// Wakes the cloud GPU if it's asleep, streaming elapsed time (RunPod gives no load percentage).
// A worker that's already up answers instantly; otherwise a 1-token request starts one.
async function warmupCloud(res) {
  const auth = { Authorization: `Bearer ${RUNPOD_API_KEY}` };
  const health = await fetch(`${RUNPOD_URL}/health`, { headers: auth, signal: AbortSignal.timeout(8000) })
    .then((r) => r.json())
    .catch(() => null);
  const w = health?.workers || {};
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if ((w.idle || 0) + (w.ready || 0) > 0) {
    send({ state: "loaded", progress: 1 });
    return res.end();
  }
  const started = Date.now();
  send({ state: "waking", elapsed: 0 });
  const tick = setInterval(() => send({ state: "waking", elapsed: Math.round((Date.now() - started) / 1000) }), 2000);
  try {
    const r = await fetch(`${RUNPOD_URL}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ model: "qwen3.8-27b-cloud", max_tokens: 1, messages: [{ role: "user", content: "." }] }),
      signal: AbortSignal.timeout(280000), // stay under Vercel's 300 s function limit
    });
    send(r.ok ? { state: "loaded", progress: 1 } : { state: "error", error: `cloud GPU returned ${r.status}` });
  } catch (err) {
    send({ state: "error", error: err.name === "TimeoutError" ? "the cloud GPU is still starting; try again in a minute" : err.message });
  } finally {
    clearInterval(tick);
    res.end();
  }
}

// Streams a model's load progress (via the bridge's /warmup) so the UI can show a loading bar.
async function handleWarmup(req, res) {
  if (!(await checkAccess(req, res))) return;
  const model = new URL(req.url, "http://x").searchParams.get("model") || "";
  const entry = modelEntry(model);
  if (!entry) return sendJson(res, 400, { error: "Unknown model" });
  if (entry.cloud) return CLOUD_ON ? warmupCloud(res) : sendJson(res, 503, { error: "The cloud model isn't set up right now." });
  if (!BRIDGE_TOKEN) return sendJson(res, 200, { state: "loaded", progress: 1 }); // local dev: LM Studio loads on demand

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let upstream;
  try {
    upstream = await fetch(`${LMSTUDIO_URL}/warmup?model=${encodeURIComponent(model)}`, {
      headers: upstreamHeaders,
      signal: abort.signal,
    });
  } catch (err) {
    return sendJson(res, 502, { error: unreachable(err) });
  }
  if (!upstream.ok || !upstream.body) {
    const data = await upstream.json().catch(() => ({}));
    return sendJson(res, 502, { error: data.error || "Couldn't load the model" });
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch {}
  res.end();
}

module.exports = {
  logEvent,
  checkAccess,
  clientInfo,
  RUNPOD_API_KEY,
  handleModels,
  handleChat,
  handleWarmup,
  sendJson,
  readBody,
  safeEqual,
  LMSTUDIO_URL,
  BRIDGE_TOKEN,
  upstreamHeaders,
};
