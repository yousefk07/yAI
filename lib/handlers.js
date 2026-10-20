// API handlers shared by the local dev server (server.js) and the Vercel
// functions (api/*.js). They forward requests to LM Studio's OpenAI-compatible
// API, either directly (local) or through bridge.js over a tunnel (Vercel).

const crypto = require("crypto");
const { currentUser } = require("./session");
const store = require("./store");

const LMSTUDIO_URL = (process.env.LMSTUDIO_URL || "http://localhost:1234/v1").replace(/\/$/, "");
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const DEFAULT_MODEL = process.env.MODEL || "";
// Optional cloud models, each on its own RunPod serverless vLLM endpoint (scales to zero; the first request after idle wakes a GPU).
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || "";
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID || "";
const RUNPOD_CODER_ENDPOINT_ID = process.env.RUNPOD_CODER_ENDPOINT_ID || "";
// Where each cloud chat model runs: on Modal when its URL is set (MODAL_CODER_URL / MODAL_MAX_URL, see modal/llm.py),
// otherwise on a RunPod serverless endpoint. Both speak the OpenAI chat API.
const MODAL_API_KEY = process.env.MODAL_API_KEY || "";
function provider(modalUrl, runpodId) {
  if (modalUrl && MODAL_API_KEY) return { kind: "modal", base: modalUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1", key: MODAL_API_KEY };
  if (runpodId && RUNPOD_API_KEY) {
    const root = `https://api.runpod.ai/v2/${runpodId}`;
    return { kind: "runpod", base: `${root}/openai/v1`, health: `${root}/health`, key: RUNPOD_API_KEY };
  }
  return null;
}
const cloudOn = (entry) => !!entry.host;
// yAI Ultra: a model on a Modal shared endpoint, billed per token, always running (no GPU to wake).
const ULTRA_URL = process.env.MODAL_ULTRA_URL || "", ULTRA_KEY = process.env.MODAL_ULTRA_KEY || "";
const ULTRA_DAILY_USD = Number(process.env.ULTRA_DAILY_USD) || 2; // per user, resets at midnight UTC
const ultraHost = ULTRA_URL && ULTRA_KEY ? { kind: "shared", base: ULTRA_URL.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1", key: ULTRA_KEY } : null;
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
// Cloud models: `endpoint` is the RunPod endpoint, `upstream` the name vLLM serves the model as.
// `context` is the model's window in tokens (yAI Code sizes the conversation to it; local models default to 8192).
// `codeOnly` models are listed on the website but only yAI Code (agent mode) can use them;
// `webOnly` models are left out of yAI Code. The coder is yAI Code's default.
const MODELS = [
  { id: "qwen3-coder-30b-cloud", match: /^qwen3-coder-30b-cloud$/, label: "Qwen3 Coder 30B", vision: false, cloud: true,
    host: provider(process.env.MODAL_CODER_URL, RUNPOD_CODER_ENDPOINT_ID), upstream: "qwen3-coder", codeOnly: true,
    // the server's --max-model-len: 64k on Modal (modal/llm.py), 32k on the RunPod endpoint
    context: Number(process.env.CODER_CONTEXT || process.env.RUNPOD_CODER_CONTEXT) || (process.env.MODAL_CODER_URL ? 65536 : 32768),
    desc: "Built for coding · cloud GPU · may take a minute to wake up" },
  { id: "kimi-k3-ultra", match: /^kimi-k3-ultra$/, label: "yAI Ultra", vision: true, cloud: true, host: ultraHost,
    upstream: process.env.MODAL_ULTRA_MODEL || "moonshotai/Kimi-K3", context: Number(process.env.ULTRA_CONTEXT) || 128000,
    price: { in: 3, cached: 0.3, out: 15 }, // US$ per million tokens (Modal shared endpoint, 2026-10-20)
    desc: "Kimi K3 · the most capable · no waiting · daily limit" },
  { id: "qwen3.8-27b-cloud", match: /^qwen3\.8-27b-cloud$/, label: "Qwen 3.8 27B Max", vision: true, cloud: true,
    host: provider(process.env.MODAL_MAX_URL, RUNPOD_ENDPOINT_ID), upstream: "qwen3.8-27b-cloud", context: 24000,
    desc: "Strong · reads images · cloud GPU · may take a minute to wake up" },
  { match: /qwen3\.5-4b.*uncensored/i, label: "Qwen 3.5 4B Uncensored", vision: true, desc: "Fast and capable · reads images" },
  { match: /phi-4-mini/i, label: "Phi 4 Mini", vision: false, desc: "Fastest · text only" },
  { match: /qwen3\.5-2b/i, label: "Qwen 3.5 2B Distilled", vision: true, webOnly: true, desc: "Very fast · thinks briefly first" },];
const FALLBACK_MODEL = "qwen3.8-27b-cloud";
const isCodeClient = (req) => /^yai-code\//.test(req.headers["user-agent"] || ""); // cli/api.js sends this
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
// Everything needs an account (Yousef 2026-10-19: no more guest access). The access code is only
// used to create an account (lib/accounts.js); people without one request it from the sign-in page.
async function checkAccess(req, res) {
  if (currentUser(req)) return true;
  sendJson(res, 401, { error: "Log in to use yAI", needsLogin: true });
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
  const code = isCodeClient(req);
  const offered = MODELS.filter((m) => !(code && m.webOnly));
  const cloud = offered.filter((m) => m.cloud && cloudOn(m))
    .map(({ id, label, vision, desc, codeOnly, context }) => ({ id, label, vision, desc, codeOnly, context, cloud: true }));
  // yAI Code defaults to the coder; the website can't use code-only models, so they're never its default.
  const usable = code ? cloud : cloud.filter((m) => !m.codeOnly);
  try {
    const r = await fetch(`${LMSTUDIO_URL}/models`, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`upstream returned ${r.status}`);
    const data = await r.json();
    const ids = (data.data || []).map((m) => m.id);
    const local = offered.filter((m) => !m.cloud).map((entry) => {
      // Prefer a plain edition over a "-reasoning" one: those always think, which is slow.
      const id = ids.filter((i) => entry.match.test(i)).sort((a, b) => /reasoning/i.test(a) - /reasoning/i.test(b))[0];
      return id && { id, label: entry.label, vision: entry.vision, desc: entry.desc, context: 8192 };
    }).filter(Boolean);
    // Cloud models are listed first (strongest). On the website a local model stays the default (Qwen 3.5 4B).
    const models = [...cloud, ...local];
    const fallback = code
      ? usable[0] || local[0]
      : models.find((m) => m.id === DEFAULT_MODEL && !m.codeOnly) || local[0] || usable[0] || cloud[0];
    sendJson(res, 200, { models, default: fallback ? fallback.id : "", ...mediaFeatures() });
  } catch (err) {
    if (cloud.length) return sendJson(res, 200, { models: cloud, default: (usable[0] || cloud[0]).id, localOffline: true, ...mediaFeatures() });
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
  if (allowed.cloud && !cloudOn(allowed)) return sendJson(res, 503, { error: "The cloud model isn't set up right now." });
  // yAI Ultra is billed per token: each person gets a daily allowance.
  if (allowed.price && store.STORE_ON) {
    const spent = await store.getSpendToday(currentUser(req) || "anon").catch(() => 0);
    if (spent >= ULTRA_DAILY_USD * 1e6) {
      return sendJson(res, 429, { error: `You've used today's $${ULTRA_DAILY_USD} of ${allowed.label}. It resets at midnight UTC; the other models still work.` });
    }
  }
  if (allowed.codeOnly && !agent) return sendJson(res, 403, { error: `${allowed.label} is only available in yAI Code.` });
  if (allowed.webOnly && agent) return sendJson(res, 403, { error: `${allowed.label} isn't available in yAI Code. Pick another model with /model.` });
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

  // yAI Code on a cloud model: open the stream straight away and report RunPod's real state (queued,
  // starting a GPU...) until the reply starts, so the terminal doesn't say "thinking" while it waits.
  const sse = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" };
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const live = allowed.cloud && agent;
  let statusTimer;
  if (live) {
    res.writeHead(200, sse);
    let last;
    const poll = async () => {
      const status = await cloudStatus(allowed, started);
      if (status && status !== last && !upstreamAbort.signal.aborted) emit({ status: (last = status) });
    };
    poll();
    statusTimer = setInterval(poll, 3000);
  }
  const fail = async (status, error, logged) => {
    clearInterval(statusTimer);
    await record({ error: logged });
    if (!live) return sendJson(res, status, { error });
    emit({ error });
    res.end();
  };

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
      ? await fetch(`${allowed.host.base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${allowed.host.key}` },
          signal: upstreamAbort.signal,
          body: JSON.stringify({ ...base, model: allowed.upstream, max_tokens: agent ? AGENT_MAX_TOKENS : CLOUD_MAX_TOKENS }),
        })
      : await fetch(`${LMSTUDIO_URL}/chat/completions`, {
          method: "POST",
          headers: upstreamHeaders,
          signal: upstreamAbort.signal,
          // LM Studio also needs reasoning_effort to turn thinking off for some models.
          body: JSON.stringify({ ...base, reasoning_effort: "none" }),
        });
  } catch (err) {
    if (upstreamAbort.signal.aborted) return fail(499, "Stopped", "stopped");
    return fail(502, unreachable(err), "model unreachable");
  }
  clearInterval(statusTimer);

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
    return fail(502, `${msg || "The model returned an error"}. Please try again in a moment.`, `model error ${upstream.status}`);
  }

  // Re-emit the model's SSE stream as a simpler stream of our own events.
  if (!live) res.writeHead(200, sse);
  else emit({ status: "thinking" });

  // If a model thinks anyway, drop its reasoning: never forward reasoning_content,
  // and strip inline <think>…</think> blocks, holding back a partial "<think" tag.
  // Each streamed delta is one token, so `t` gives the UI a live count (including any hidden
  // thinking); LM Studio's exact usage replaces it at the end.
  let raw = "", sent = 0, tokens = 0, usage, thinking = "";
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
          if (agent && (delta.reasoning_content || delta.reasoning)) thinking += delta.reasoning_content || delta.reasoning;
        } catch {}
      }
    }
    // Kimi K3 thinks first (it can't be switched off), and now and then writes its tool call inside the thinking,
    // which is never shown. In yAI Code that step would be lost, so a tool call found there is passed on.
    if (agent && !/<\|open\|>tools|(^|\n)[ \t]*<tool[\s>]/.test(raw)) {
      const at = thinking.search(/<\|open\|>tools|<tool\s+name=/);
      if (at >= 0) pushContent("\n" + thinking.slice(at));
    }
    emit({ done: true, usage: { in: usage?.prompt_tokens, out: usage?.completion_tokens ?? tokens } });
  } catch (err) {
    if (!upstreamAbort.signal.aborted) {
      streamError = err.message;
      emit({ error: `Stream interrupted: ${err.message}` });
    }
  }
  // What this reply cost, for the per-token models' daily allowance (cached prompt tokens are cheaper).
  if (allowed.price && usage && store.STORE_ON) {
    const cached = usage.prompt_tokens_details?.cached_tokens || 0;
    const micros = ((usage.prompt_tokens || 0) - cached) * allowed.price.in + cached * allowed.price.cached + (usage.completion_tokens || 0) * allowed.price.out;
    await store.addSpendToday(currentUser(req) || "anon", micros).catch(() => {});
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

// What the cloud GPU is doing, in words for the yAI Code spinner. RunPod reports its workers (/health); Modal has
// nothing to ask, so a reply that hasn't started after a few seconds is most likely a GPU starting up.
// Undefined when there's nothing to say, so the spinner keeps its last text.
async function cloudStatus(entry, started = Date.now()) {
  if (entry.host.kind === "shared") return undefined; // always running
  if (entry.host.kind === "modal") return Date.now() - started > 4000 ? "waiting for the GPU (it may be starting up, about a minute)" : undefined;
  const health = await fetch(entry.host.health, { headers: { Authorization: `Bearer ${entry.host.key}` }, signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!health) return undefined;
  // Judged by the workers, not the queue count: requests to RunPod's OpenAI route don't always
  // show in jobs.inQueue, but with no worker up nothing can be thinking yet.
  const w = health.workers || {}, queued = health.jobs?.inQueue || 0;
  if (!(w.running || w.ready || w.idle)) {
    if (w.initializing) return "starting a GPU and loading the model (can take a few minutes)";
    if (w.throttled) return "waiting for a free GPU (RunPod is short on this GPU type)";
    return "in RunPod's queue, waiting for a GPU";
  }
  if (queued && !w.ready && !w.idle) return `in RunPod's queue (${queued} waiting)`;
  return "thinking";
}

// Wakes the cloud GPU if it's asleep, streaming elapsed time (RunPod gives no load percentage).
// A worker that's already up answers instantly; otherwise a 1-token request starts one.
async function warmupCloud(res, entry) {
  if (entry.host.kind === "shared") return sendJson(res, 200, { state: "loaded", progress: 1 }); // nothing to wake
  const auth = { Authorization: `Bearer ${entry.host.key}` };
  const health = entry.host.health
    ? await fetch(entry.host.health, { headers: auth, signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null)
    : null;
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
    // Modal: listing the models is enough to start a container and wait until the server inside is up.
    const r = entry.host.kind === "modal"
      ? await fetch(`${entry.host.base}/models`, { headers: auth, signal: AbortSignal.timeout(280000) })
      : await fetch(`${entry.host.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ model: entry.upstream, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
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
  if (entry.cloud) return cloudOn(entry) ? warmupCloud(res, entry) : sendJson(res, 503, { error: "The cloud model isn't set up right now." });
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
