// API handlers shared by the local dev server (server.js) and the Vercel
// functions (api/*.js). They forward requests to LM Studio's OpenAI-compatible
// API, either directly (local) or through bridge.js over a tunnel (Vercel).

const crypto = require("crypto");
const { currentUser } = require("./session");
const store = require("./store");
const policy = require("./policy");
const { search, fetchPage } = require("./search");
const { runResearch } = require("./research");

const LMSTUDIO_URL = (process.env.LMSTUDIO_URL || "http://localhost:1234/v1").replace(/\/$/, "");
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const DEFAULT_MODEL = process.env.MODEL || "";
// Optional cloud models, each on its own RunPod serverless vLLM endpoint (scales to zero; the first request after idle wakes a GPU).
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || "";
const RUNPOD_CODER_ENDPOINT_ID = process.env.RUNPOD_CODER_ENDPOINT_ID || "";
// Where yAI 3 Coder (the one model left on a cloud GPU) runs: on Modal when MODAL_CODER_URL is set (modal/llm.py),
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
const hasImage = (messages) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
// Where a cloud model's request goes, in order: DeepSeek first for the models it serves (text only), then the entry's
// own Modal host (images, and the fallback).
function hostsFor(entry, messages) {
  if (entry.chain) return entry.chain().filter((h) => h.host);
  const ds = entry.deepseekModel;
  const own = entry.host && (entry.host.deepseek ? { host: entry.host, upstream: ds, price: deepseekPrice(ds) } : { host: entry.host, upstream: entry.upstream, price: entry.price });
  // a message with an image, for a model that reads images: the free image models only, fastest first (2026-10-22,
  // Yousef): Gemini Flash-Lite, then Groq, then Gemini 3.8 Flash. Never Modal (its billing limit left yAI waiting ~20 s
  // for nothing). A host that refuses (429: its quota is used up) passes straight to the next.
  if (hasImage(messages) && entry.vision && (geminiHost || groqHost)) return [
    ...(geminiHost ? [{ host: geminiHost, upstream: GEMINI_LITE_MODEL, price: GEMINI_PRICE }] : []),
    ...(groqHost ? [{ host: groqHost, upstream: GROQ_VISION_MODEL, price: GROQ_PRICE }] : []),
    ...(geminiHost && GEMINI_VISION_MODEL !== GEMINI_LITE_MODEL ? [{ host: geminiHost, upstream: GEMINI_VISION_MODEL, price: GEMINI_PRICE }] : []),
  ];
  if (hasImage(messages) && entry.vision) return []; // no free image model set up: an error, never Modal
  if (!ds || !deepseekHost || entry.host === deepseekHost || hasImage(messages)) return own ? [own] : [];
  return [{ host: deepseekHost, upstream: ds, price: deepseekPrice(ds) }, ...(own ? [own] : [])];
}
// DeepSeek's API turns thinking off with its own switch, not the chat template's. For yAI Code it also takes the
// tools natively (2026-10-22): asked to write its DSML markup as text, the model can't produce the real DSML tokens
// there and writes imitations (<｜｜DSML｜｜ calls>, <DSML｜tool_calls>) that no parser should chase. So the tool list
// goes in `tools`, the text format in the system prompt becomes a short note, earlier steps become tool_calls and
// role "tool" results, and the reply's tool_calls come back as yAI's own <tool> block (toolBlock).
const NATIVE_NOTE = "To use a tool, call it through the function-calling interface: one tool per message, then stop. The result comes back in the next message.";
// Z.ai's API (yAI Lite) takes the same thinking switch and native tools; its documented parameters have no
// stream_options, so that is left out there.
// Thinking (2026-10-23, Yousef: "turn thinking on for crew and team"): yAI Code asks for it with `think` (low, high
// or max) on the planning calls and on /crew's chat and /team's fixer; only DeepSeek's own API gets it, as
// thinking {type: "enabled"} and reasoning_effort (api-docs.deepseek.com/guides/thinking_mode). With tools, DeepSeek
// needs every earlier step's reasoning_content sent back, or it answers 400: yAI Code keeps each step's reasoning
// (`reasoning` on the message) and it goes back as reasoning_content here. The `think` and `reasoning` fields never
// reach any other host.
const stripReasoning = (messages) => (Array.isArray(messages) ? messages.map(({ reasoning, ...m }) => m) : messages);
const bodyFor = (h, body0, native) => {
  const { think, ...body } = body0;
  const thinking = !!think && !!h.host.deepseek;
  if (!(thinking && native)) body.messages = stripReasoning(body.messages);
  // Gemini's OpenAI-compatible endpoint (ai.google.dev/gemini-api/docs/openai): the plain chat fields only; its own
  // reasoning stays at its default ("minimal" on Flash-Lite)
  if (h.host.gemini) { const { chat_template_kwargs, reasoning_effort, stream_options, ...rest } = body; return rest; }
  // Groq (console.groq.com/docs/openai, /docs/reasoning): OpenAI's fields; reasoning_effort "none" turns Qwen's
  // thinking off; no tools here (it only describes images)
  if (h.host.groq) { const { chat_template_kwargs, stream_options, tools, tool_choice, ...rest } = body; return { ...rest, reasoning_effort: "none" }; }
  if (!h.host.native) return body;
  const { chat_template_kwargs, reasoning_effort, ...rest } = body;
  if (h.host.zai) delete rest.stream_options;
  const out = { ...rest, thinking: { type: thinking ? "enabled" : "disabled" }, ...(thinking && { reasoning_effort: think }) };
  if (!native) return out;
  const [sys, ...msgs] = out.messages;
  const system = native.toolFormat && sys.content.includes(native.toolFormat) ? sys.content.replace(native.toolFormat, NATIVE_NOTE) : sys.content;
  return {
    ...out,
    messages: [{ ...sys, content: system }, ...nativeMessages(msgs, thinking)],
    tools: native.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description,
      parameters: { type: "object", properties: Object.fromEntries(t.params.map((p) => [p, { type: "string" }])) } } })),
    tool_choice: "auto",
  };
};
// yAI Code keeps each step as text: the assistant's <tool name="x"><k>v</k></tool>, then a user message starting
// <tool_result name="x">…</tool_result> (with any note the user added after it). As native messages: an assistant
// message with tool_calls, a role "tool" message with the result, then the note as a user message.
// With thinking on, every assistant message carries reasoning_content (its own, or "" for a step that had none).
function nativeMessages(msgs0, thinking = false) {
  const out = [];
  let n = 0, pending = null;
  const why = (m) => (thinking ? { reasoning_content: typeof m.reasoning === "string" ? m.reasoning : "" } : {});
  for (const m0 of msgs0) {
    const { reasoning, ...m } = m0;
    if (pending) {
      const c = typeof m.content === "string" ? m.content : "";
      if (m.role === "user" && c.startsWith("<tool_result")) {
        const end = c.indexOf("</tool_result>");
        const inner = c.slice(c.indexOf(">") + 1, end < 0 ? undefined : end).replace(/^\n|\n$/g, "");
        out.push({ role: "tool", tool_call_id: pending, content: inner || "(no output)" });
        pending = null;
        const rest = end < 0 ? "" : c.slice(end + "</tool_result>".length).trim();
        if (rest) out.push({ role: "user", content: rest });
        continue;
      }
      out.push({ role: "tool", tool_call_id: pending, content: "(no result)" });
      pending = null;
    }
    const call = m.role === "assistant" && typeof m.content === "string" ? parseToolBlock(m.content) : null;
    if (call) {
      pending = `call_${++n}`;
      out.push({ role: "assistant", content: call.before, ...why(m0), tool_calls: [{ id: pending, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
      continue;
    }
    out.push(m.role === "assistant" ? { ...m, ...why(m0) } : m);
  }
  if (pending) out.push({ role: "tool", tool_call_id: pending, content: "(no result)" });
  return out;
}
// <tool name="x"> with <k>\nvalue\n</k> arguments, as yAI Code stores a step (and as toolBlock writes one)
function parseToolBlock(text) {
  const head = /(^|\n)[ \t]*<tool\s+name="([\w-]+)">/.exec(text);
  if (!head) return null;
  const from = head.index + head[0].length;
  const end = text.lastIndexOf("</tool>");
  const body = text.slice(from, end > from ? end : undefined);
  const args = {};
  for (const a of body.matchAll(/<([\w-]+)>\n?([\s\S]*?)\n?<\/\1>/g)) if (!(a[1] in args)) args[a[1]] = a[2];
  return { name: head[2], args, before: text.slice(0, head.index).trim() };
}
// A native tool call back as yAI's own block, the same shape yAI Code's DeepSeek reader produces
function toolBlock(call) {
  let args = {}, cut = false;
  // a JSON string per the OpenAI format; Z.ai's reference also describes it as an object
  if (call.arguments && typeof call.arguments === "object") args = call.arguments;
  else try { args = JSON.parse(call.arguments || "{}") || {}; } catch {
    // Arguments that don't parse were cut off: the reply hit its length limit in the middle of a long file
    // (2026-10-23: write_file kept arriving with no path, so the agent was told "A path is required" and tried the
    // same giant write again). What can be read is kept, and the block is left unclosed, so yAI Code treats it as
    // cut off and asks for the file in parts.
    cut = true;
    const raw = String(call.arguments || "");
    for (const m of raw.matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) { try { args[m[1]] = JSON.parse(`"${m[2]}"`); } catch {} }
    // the value it was in the middle of (usually the file's content), kept open so the call reads as cut off
    const open = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)\\?$/.exec(raw);
    // (cut inside a \u escape, the half escape is dropped first: the whole value failed to parse, and the file was saved
    // with every \n and \" in it written out literally, 2026-10-23)
    const value = open ? open[2].replace(/\\u[0-9a-fA-F]{0,3}$/, "") : "";
    if (open && !(open[1] in args)) { try { cut = { key: open[1], text: JSON.parse(`"${value}"`) }; } catch { cut = { key: open[1], text: value }; } }
  }
  const lines = Object.entries(args).map(([k, v]) => `<${k}>\n${typeof v === "string" ? v : JSON.stringify(v)}\n</${k}>`);
  if (cut && cut.key) lines.push(`<${cut.key}>\n${cut.text}`);
  else if (cut) lines.push("<content>"); // nothing to keep: still an open tag, so it's cut off, not a call missing its file
  return `<tool name="${call.name}">\n${lines.join("\n")}${cut ? "" : "\n</tool>"}`;
}
// The tool list yAI Code sent, checked: at most 80 tools, sensible names, string parameters
function cleanTools(tools) {
  if (!Array.isArray(tools)) return null;
  const ok = tools.slice(0, 80).filter((t) => t && /^[\w-]{1,64}$/.test(t.name) && Array.isArray(t.params))
    .map((t) => ({ name: t.name, description: String(t.description || "").slice(0, 1500), params: t.params.filter((p) => /^[\w-]{1,64}$/.test(p)).slice(0, 20) }));
  return ok.length ? ok : null;
}
// yAI Ultra: a model on a Modal shared endpoint, billed per token, always running (no GPU to wake).
const ULTRA_URL = process.env.MODAL_ULTRA_URL || "", ULTRA_KEY = process.env.MODAL_ULTRA_KEY || "";
const ULTRA_DAILY_USD = Number(process.env.ULTRA_DAILY_USD) || 2; // per user, resets at midnight UTC
const sharedHost = (url, key) => (url && key ? { kind: "shared", base: url.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1", key } : null);
const ultraHost = sharedHost(ULTRA_URL, ULTRA_KEY);
// yAI Ultra Flash (2026-10-21): DeepSeek V4.1 Flash on its own Modal shared endpoint. Any of the workspace's proxy
// tokens works, so it uses yAI Ultra's unless MODAL_FLASH_KEY is set. Its spend counts toward the same daily allowance.
const flashHost = sharedHost(process.env.MODAL_FLASH_URL || "", process.env.MODAL_FLASH_KEY || ULTRA_KEY);
// yAI Ultra Flash through DeepSeek's own API (2026-10-22), when DEEPSEEK_API_KEY is set: the same model, with cached
// input at a fifth of Modal's price and everything at half price off-peak. Modal stays as the fallback (DeepSeek down,
// out of balance) and serves anything with an image, since DeepSeek's API is text-only.
const deepseekHost = process.env.DEEPSEEK_API_KEY
  ? { kind: "shared", deepseek: true, native: true, name: "DeepSeek", base: (process.env.DEEPSEEK_URL || "https://api.deepseek.com").replace(/\/+$/, ""), key: process.env.DEEPSEEK_API_KEY }
  : null;
// yAI Lite (2026-10-22): GLM-4.7-Flash on Z.ai's own API, free (docs.z.ai pricing), when ZAI_API_KEY is set. It is the
// default model (Yousef 2026-10-22). Free models get a small share of Z.ai's capacity, so a busy or refused request goes
// to DeepSeek's Flash (yAI Ultra Flash's model). Text only.
// Images (2026-10-22): DeepSeek's API is text-only, so a message with an image went to Modal, and a Modal billing
// limit left yAI unable to see (the /team judge, check_page). With GEMINI_API_KEY (a free key from Google AI Studio)
// images go to Gemini first, Modal after. Free-tier requests may be used by Google to improve its products.
const geminiHost = process.env.GEMINI_API_KEY
  ? { kind: "shared", gemini: true, name: "Gemini", base: (process.env.GEMINI_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, ""), key: process.env.GEMINI_API_KEY }
  : null;
// Gemini 3.8 Flash: Flash-Lite missed a big first-person hand in a game screenshot (2026-10-22), and the /team judge
// exists to notice what is on screen
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || "gemini-3.8-flash";
// US$ per million tokens: nothing on the free tier; GEMINI_PRICE_IN / _OUT once billing is on
const GEMINI_PRICE = { in: Number(process.env.GEMINI_PRICE_IN) || 0, cached: 0, out: Number(process.env.GEMINI_PRICE_OUT) || 0 };
// a second free image model when Gemini 3.8 Flash's free quota is used up (each model has its own quota)
const GEMINI_LITE_MODEL = process.env.GEMINI_LITE_MODEL || "gemini-3.5-flash-lite";
// Groq (GROQ_API_KEY, free plan): Qwen 3.8 27B reads images (console.groq.com/docs/vision; up to 3 per request,
// 2,048 tokens each), between Gemini Flash and Flash-Lite
const groqHost = process.env.GROQ_API_KEY
  ? { kind: "shared", groq: true, name: "Groq", base: (process.env.GROQ_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, ""), key: process.env.GROQ_API_KEY }
  : null;
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";
const GROQ_PRICE = { in: Number(process.env.GROQ_PRICE_IN) || 0, cached: 0, out: Number(process.env.GROQ_PRICE_OUT) || 0 };
const zaiHost = process.env.ZAI_API_KEY
  ? { kind: "shared", zai: true, native: true, name: "Z.ai", base: (process.env.ZAI_URL || "https://api.z.ai/api/paas/v4").replace(/\/+$/, ""), key: process.env.ZAI_API_KEY }
  : null;
// US$ per million tokens at peak (01:00-04:00 and 06:00-10:00 UTC on weekdays); everything else is half price
const DEEPSEEK_PEAK = { "deepseek-flash": { in: 0.3, cached: 0.006, out: 1.2 }, "deepseek-v4-pro": { in: 1.32, cached: 0.044, out: 3.96 } };
function deepseekPrice(model = "deepseek-flash", at = new Date()) {
  const h = at.getUTCHours(), day = at.getUTCDay();
  const k = day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10)) ? 1 : 0.5;
  const p = DEEPSEEK_PEAK[model] || DEEPSEEK_PEAK["deepseek-flash"];
  return { in: p.in * k, cached: p.cached * k, out: p.out * k };
}
const { features: mediaFeatures } = require("./media-config"); // image/video endpoints (lib/images.js)
const CLOUD_MAX_TOKENS = 2048; // cap answer length: the cloud GPU is billed per second
// The terminal agent (cli/) sends its own system prompt, needs longer tool loops and room to write files.
// Only signed-in users can use agent mode.
const AGENT_MAX_TOKENS = 4096;
// Kimi K3 (yAI Ultra) always thinks before it answers, and the thinking counts against max_tokens: at 4096 it
// sometimes used the whole budget thinking and answered nothing (2026-10-20 benchmark, csv and retry tasks).
const ULTRA_MAX_TOKENS = { agent: 16000, web: 8192 };
// Agent replies on DeepSeek and Z.ai get their providers' full output limit, so a big file fits in one write_file
// instead of being cut off (2026-10-23, Yousef: "remove the cutoff"). DeepSeek V4: 384K out of a 1M context; Z.ai
// GLM-4.7: 128K out of a 200K context, so 96K leaves room for the conversation. Only what's written is billed.
const hostMaxTokens = (h, agent, fallback) => (!agent ? fallback : h.host.deepseek ? 384000 : h.host.zai ? 96000 : fallback);
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
  { id: "qwen3-coder-30b-cloud", match: /^qwen3-coder-30b-cloud$/, label: "yAI 3 Coder", vision: false, cloud: true, // Qwen3 Coder 30B underneath
    host: provider(process.env.MODAL_CODER_URL, RUNPOD_CODER_ENDPOINT_ID), upstream: "qwen3-coder", codeOnly: true,
    // the server's --max-model-len: 64k on Modal (modal/llm.py), 32k on the RunPod endpoint
    context: Number(process.env.CODER_CONTEXT || process.env.RUNPOD_CODER_CONTEXT) || (process.env.MODAL_CODER_URL ? 65536 : 32768),
    desc: "Built for coding · cloud GPU · may take a minute to wake up" },
  // yAI Ultra (2026-10-22): DeepSeek V4 Pro on DeepSeek's API, in place of Kimi K3 (a fifth of the price or less).
  // Kimi K3 on Modal stays behind it for messages with images (DeepSeek's API is text-only) and as the fallback;
  // "kimi-k3-ultra" still resolves here, so saved picks, scheduled tasks and API keys keep working.
  { id: "deepseek-v4-pro", match: /^(deepseek-v4-pro|kimi-k3-ultra)$/, label: "yAI Ultra", vision: true, cloud: true, host: ultraHost || deepseekHost,
    deepseekModel: process.env.DEEPSEEK_PRO_MODEL || "deepseek-v4-pro",
    upstream: process.env.MODAL_ULTRA_MODEL || "moonshotai/Kimi-K3", context: Number(process.env.ULTRA_CONTEXT) || 128000,
    price: { in: 3, cached: 0.3, out: 15 }, // Kimi K3 on Modal, when it answers (US$ per million tokens, 2026-10-20)
    desc: "DeepSeek V4 Pro · the most capable · no waiting · daily limit" },
  { id: "deepseek-v4.1-flash", match: /^deepseek-v4\.1-flash$/, label: "yAI Ultra Flash", vision: true, cloud: true, host: flashHost || deepseekHost,
    deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-flash",
    upstream: process.env.MODAL_FLASH_MODEL || "deepseek-ai/DeepSeek-V4.1-Flash", context: Number(process.env.FLASH_CONTEXT) || 128000,
    price: { in: 0.3, cached: 0.03, out: 1.2 }, // US$ per million tokens (Modal shared endpoint, 2026-10-21)
    desc: "DeepSeek V4.1 Flash · fast and cheap · reads images · no waiting · daily limit" },
  { id: "glm-4.7-flash", match: /^glm-4\.7-flash$/, label: "yAI Lite", vision: false, cloud: true, host: zaiHost,
    upstream: process.env.ZAI_MODEL || "glm-4.7-flash", context: Number(process.env.LITE_CONTEXT) || 128000,
    price: { in: 0, cached: 0, out: 0 },
    chain: () => [
      { host: zaiHost, upstream: process.env.ZAI_MODEL || "glm-4.7-flash", price: { in: 0, cached: 0, out: 0 } },
      { host: deepseekHost, upstream: "deepseek-flash", price: deepseekPrice("deepseek-flash") },
    ],
    desc: "GLM-4.7 Flash · free · text only · can be slower when busy" },
  // yAI Q3.8 Max (2026-10-21): Qwen3.8 Max (2.4T parameters, 95B active) on a Modal shared endpoint, billed per token
  // against the same daily allowance. It replaced Qwen 3.8 27B on a cloud GPU. Modal lists it without image input.
  { id: "qwen3.8-max", match: /^qwen3\.8-max$/, label: "yAI Q3.8 Max", vision: false, cloud: true,
    host: sharedHost(process.env.MODAL_QMAX_URL || "", process.env.MODAL_QMAX_KEY || ULTRA_KEY),
    upstream: process.env.MODAL_QMAX_MODEL || "Qwen/Qwen3.8-2.4T-A95B", context: Number(process.env.QMAX_CONTEXT) || 128000,
    price: { in: 2, cached: 0.25, out: 6 }, // US$ per million tokens (Modal shared endpoint, 2026-10-21)
    desc: "Qwen3.8 Max · 2.4T parameters · strong all-rounder · no waiting · daily limit" },
  // yAI names for the local models (Yousef 2026-10-20): Qwen 3.5 4B Uncensored is yAI Q3.5. Qwen 3.5 2B Distilled was
  // removed then, and yAI P4 (Phi 4 Mini) on 2026-10-22.
  { match: /qwen3\.5-4b.*uncensored/i, label: "yAI Q3.5", vision: true, desc: "Fast and capable · reads images" },
];
// The default: yAI Lite when it's set up, else yAI Ultra Flash
const defaultCloud = () => (cloudOn(modelEntry("glm-4.7-flash")) ? "glm-4.7-flash" : "deepseek-v4.1-flash");
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
  const user = currentUser(req);
  if (user && (await policy.isBlocked(user))) {
    sendJson(res, 403, { error: "This account has been paused by an admin. Email yousefkkamel@gmail.com if you think that's a mistake.", blocked: true });
    return false;
  }
  if (user) return true;
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
    .map((m) => ({ id: m.id, label: m.label, vision: m.vision, desc: m.desc, codeOnly: m.codeOnly, context: m.context, price: hostsFor(m, [])[0]?.price || m.price, cloud: true }));
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
    // Cloud models are listed first (strongest). On the website a local model stays the default (yAI Q3.5).
    const models = [...cloud, ...local];
    // yAI Lite is the default on both the website and yAI Code when it's set up (Yousef 2026-10-22), else yAI Ultra Flash.
    const flash = cloud.find((m) => m.id === defaultCloud());
    const fallback = flash || (code
      ? usable[0] || local[0]
      : models.find((m) => m.id === DEFAULT_MODEL && !m.codeOnly) || local[0] || usable[0] || cloud[0]);
    sendJson(res, 200, { models, default: fallback ? fallback.id : "", ...mediaFeatures() });
  } catch (err) {
    if (cloud.length) return sendJson(res, 200, { models: cloud, default: (cloud.find((m) => m.id === defaultCloud()) || usable[0] || cloud[0]).id, localOffline: true, ...mediaFeatures() });
    sendJson(res, 502, { error: unreachable(err) });
  }
}

// yAI Ultra (Modal's shared Kimi K3 endpoint) is asked for whole replies, not streams. Its streams were unreliable
// (2026-10-20): about half ended at once, some after the thinking had started, often carrying {"error": "The request
// queue is full."} inside an HTTP 200; whole replies never failed that way. Each try that comes back with an error or
// with nothing in it is made again, up to 6 times with growing waits (about 15 s in all). The reply is then handed on
// as a two-chunk stream (text, then usage) so it goes through the same reading code as every other model.
async function fetchWhole(doFetch, label = "yAI Ultra") {
  let lastError = "";
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, (attempt - 1) * 1000));
    let data;
    try {
      const r = await doFetch();
      if (r.final) return r; // refused for good (billing, a bad request): no more tries
      const text = await r.text();
      data = JSON.parse(text);
      if (!r.ok && !data.error) data.error = { message: `HTTP ${r.status}` };
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastError = err.message;
      continue;
    }
    if (data.error) {
      lastError = data.error.message || String(data.error);
      continue;
    }
    const msg = data.choices?.[0]?.message || {};
    const call = (msg.tool_calls || []).find((c) => c?.function?.name);
    const content = (msg.content || "") + (call ? `${msg.content?.trim() ? "\n\n" : ""}${toolBlock(call.function)}` : "");
    const reasoning = msg.reasoning_content || msg.reasoning || "";
    if (!content.trim() && !reasoning.trim()) {
      lastError = "an empty reply";
      continue;
    }
    const sse = (o) => Buffer.from(`data: ${JSON.stringify(o)}\n\n`);
    const body = (async function* () {
      yield sse({ choices: [{ delta: { reasoning_content: reasoning, content } }] });
      if (data.usage) yield sse({ choices: [], usage: data.usage });
    })();
    return { ok: true, status: 200, body, text: async () => "" };
  }
  const message = /queue is full/i.test(lastError)
    ? `${label} is busy right now: Modal's queue for it is full`
    : `${label} didn't answer${lastError ? ` (${lastError})` : ""}`;
  return { ok: false, status: 503, body: null, text: async () => JSON.stringify({ error: { message } }) };
}

// yAI Ultra streamed (2026-10-20, Yousef: "proper streaming for yAI Ultra"). The bad streams fetchWhole works around
// all go wrong before the answer starts: they end at once, end during the hidden thinking, or carry {"error": …} in
// an HTTP 200. So each stream is held back until its first piece of answer text (or a clean finish) arrives — the
// thinking in front of it is never shown anyway — and a stream that fails before then is quietly asked again. Once
// text is flowing it is passed on as it comes. After 3 failed streams it falls back to fetchWhole's whole replies.
// ULTRA_STREAM=0 turns streaming off.
async function fetchStream(doFetch, label) {
  if (process.env.ULTRA_STREAM === "0") return fetchWhole(() => doFetch(false), label);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, (attempt - 1) * 1000));
    let r;
    try {
      r = await doFetch(true);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      continue;
    }
    if (!r.ok || !r.body) {
      if (r.final) return r; // refused for good (billing, a bad request): no more tries
      await r.text().catch(() => "");
      continue;
    }
    const it = r.body[Symbol.asyncIterator]();
    const held = [];
    const decoder = new TextDecoder();
    let buf = "", started = false, failed = false;
    try {
      while (!started && !failed) {
        const { value, done } = await it.next();
        if (done) break;
        held.push(value);
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:") || line === "data: [DONE]") continue;
          let chunk;
          try {
            chunk = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (chunk.error) failed = true;
          else if (chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.delta?.tool_calls || chunk.choices?.[0]?.finish_reason) started = true;
        }
      }
    } catch (err) {
      if (err.name === "AbortError") throw err;
      failed = true;
    }
    if (!started) {
      it.return?.().catch?.(() => {});
      continue;
    }
    const body = (async function* () {
      yield* held;
      for (;;) {
        const { value, done } = await it.next();
        if (done) return;
        yield value;
      }
    })();
    return { ok: true, status: 200, body, text: async () => "" };
  }
  return fetchWhole(() => doFetch(false), label);
}

const connectors = () => require("./connectors");

// "Search the web" on the website: the question is searched, the top pages are read, and the model answers from them
// with [n] citations. Returns { block, sources } for the system prompt and the sources list the page shows.
const SEARCH_DAILY = 150;
async function webContext(question, contextTokens) {
  const results = await search(question.slice(0, 300), { count: 6 });
  if (!results.length) return { block: "\n\n# Web search\nThe search found nothing. Say so, then answer from what you know.", sources: [] };
  const budget = Math.max(3000, Math.floor(contextTokens * 3.6 * 0.35));
  const perPage = Math.min(3500, Math.floor(budget / 4));
  const pages = await Promise.all(results.slice(0, 3).map((x) => fetchPage(x.url, { maxChars: perPage, timeout: 6000 }).catch(() => null)));
  const parts = results.map((x, i) => {
    const page = pages[i];
    return `[${i + 1}] ${x.title} (${x.url})\n${page && page.text.length > x.snippet.length ? page.text : x.snippet}`;
  });
  let block = parts.join("\n\n");
  if (block.length > budget) block = block.slice(0, budget) + "\n…";
  return {
    block:
      `\n\n# Web search results (searched ${new Date().toDateString()})\n` +
      "Answer from these results. After each sentence that uses one, cite it like [1] or [2][4]. Prefer the newest information. " +
      "If they don't answer the question, say so and answer from what you know, without citations.\n\n" + block,
    // text: what the model read from it (an excerpt), so hovering a [n] can quote the sentence it used (2026-10-21)
    sources: results.map((x, i) => ({ n: i + 1, title: x.title, url: x.url, site: x.site, text: String(pages[i] && pages[i].text.length > x.snippet.length ? pages[i].text : x.snippet || "").slice(0, 1800) })),
  };
}

// The quick check before an answer (2026-10-21): does this need the web, or one of the person's connected tools
// (weather, maps, papers, their GitHub, LEARN…)? searchAllowed is false when Search was already pressed.
function searchRouterPrompt(toolLines = "", searchAllowed = true) {
  return `Today is ${new Date().toDateString()}. You decide what to look up before the assistant answers the user's latest message.\n` +
    (searchAllowed
      ? "A web search helps for: news and current events; prices, scores, schedules, releases and versions; anything that changes over time or happened recently; " +
        "facts about specific lesser-known people, companies, products or places; and whenever the user asks to look something up or check online.\n" +
        "Don't search for: coding help, math, writing or rewriting, translations, explaining well-known ideas, opinions, chit-chat, or questions about the user's own files.\n"
      : "") +
    (toolLines
      ? `These tools are connected and give exact, live answers; prefer a tool over a web search when one fits (weather -> weather.forecast, stock or crypto prices -> stocks.quote, scores and games -> sports.scores, directions -> maps.route, exact maths or conversions -> wolfram.ask, papers -> arxiv.search or scholar.search, a YouTube link -> youtube.transcript, the user's own repos or courses -> their tool):\n${toolLines}\n`
      : "") +
    "Reply with exactly NO if nothing is needed. Otherwise reply with up to 3 lines, each either " +
    (searchAllowed ? "SEARCH: a short search query (under 10 words), or " : "") +
    (toolLines ? 'TOOL: name {json args}, for example TOOL: weather.forecast {"place":"Waterloo, ON"}. ' : "") +
    "Nothing else.";
}

// Diagrams and charts on the website (2026-10-21, public/viz.js draws them).
const VIZ_RULES =
  "\n\nWhen a diagram would explain something better than words (a process, flow, sequence, structure, timeline), draw it " +
  "in a ```mermaid block (Mermaid syntax; keep labels short). When the answer has numbers worth comparing or a trend, " +
  "add a ```chart block holding only JSON like {\"type\":\"bar\",\"title\":\"Sales by year\",\"labels\":[\"2023\",\"2024\"]," +
  "\"series\":[{\"name\":\"Sales\",\"data\":[12,19]}],\"unit\":\"$M\"}; type is bar, line, area, pie or scatter, with at " +
  "most 8 series (use pie only for parts of one whole, with few slices). Use real numbers you're confident in or that " +
  "the user gave, and only when the visual helps; most answers need neither.";

// Study mode's tutor (2026-10-20).
const STUDY_BLOCK =
  "\n\n# Study mode\nYou are the user's tutor. Help them learn instead of handing over finished answers: find out what they " +
  "already know, explain one idea at a time, ask a short question to check understanding, and give hints (a smaller step, " +
  "a worked example of a similar problem) before solutions. If they ask for the answer outright after trying, show it " +
  "step by step and explain why each step works. Keep each reply short and end with one question for them. For homework " +
  "or assignments, guide them to do it themselves. Be encouraging, and correct mistakes plainly.";

// Canvas (2026-10-20): the page shows one document or file beside the chat. With the canvas open, its current text is
// sent along so the model can change it.
const CANVAS_RULES =
    "\n\n# Canvas\nThe user is working in a canvas (an editor beside the chat). When they ask you to write or change a " +
    "document, essay, email or a whole file of code, put the complete text in ONE block that starts with a line " +
    "```canvas <kind> <title>` and ends with ```. <kind> is doc for writing (Markdown), or the language for code " +
    "(html, javascript, python, css, ...). Always write the whole thing, never a diff or \"rest unchanged\". Before the " +
    "block say in one sentence what you wrote or changed; after it, nothing more than a short note. Short answers and " +
    "questions don't need a canvas. If the canvas is open, its current text comes with the message.";
function canvasText(c) {
  const title = clip(String(c.title || ""), 120) || "";
  const text = clip(String(c.text || ""), 60000) || "";
  let out = "";
  if (text.trim()) out += `\n\nThe canvas is open now with \"${title || "untitled"}\" (${c.kind || "doc"}):\n<canvas>\n${text}\n</canvas>\nWhen they ask for changes, change this text and send it back whole in a canvas block with the same title.`;
  return out;
}

// Memory (2026-10-20): the facts yAI keeps about a person, and how it notes new ones. The notes are hidden from the
// reply and saved after it (see where the stream ends).
function memoryBlock(items) {
  let out = "";
  if (items.length) {
    out += "\n\n# What you remember about this user (from earlier chats)\nUse these when they help; don't bring them up otherwise.\n";
    out += items.slice(-60).map((m) => `- ${m.text}`).join("\n");
  }
  out +=
    "\n\n# Remembering\nIf the user tells you a lasting fact about themselves that would help in future chats (their name, " +
    "studies, work, location, tools, ongoing projects, how they like answers), end your reply with it on its own line as " +
    "<remember>one short fact, in the third person</remember>. Only new facts, never passwords or other secrets, at most " +
    "two, and most replies need none.";
  return out;
}

// One non-streamed model call (the research planner). Ultra's spend is added to the person's daily allowance.
async function completeOnce(entry, modelId, messages, maxTokens, signal, user) {
  const hosts = entry.cloud ? hostsFor(entry, messages) : [null];
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 1000));
    // the first try goes to the first host; later tries fall back down the list
    const h = hosts[Math.min(attempt, hosts.length - 1)];
    const url = h ? `${h.host.base}/chat/completions` : `${LMSTUDIO_URL}/chat/completions`;
    const headers = h ? { "Content-Type": "application/json", Authorization: `Bearer ${h.host.key}` } : upstreamHeaders;
    const body = { model: h ? h.upstream : modelId, messages, temperature: 0.3, max_tokens: maxTokens, stream: false,
      chat_template_kwargs: { enable_thinking: false }, ...(!h && { reasoning_effort: "none" }) };
    let r;
    try { r = await fetch(url, { method: "POST", headers, body: JSON.stringify(h ? bodyFor(h, body) : body), signal }); }
    catch (err) { if (err.name === "AbortError") throw err; lastError = err.message; continue; } // the next try, the next host
    const data = await r.json().catch(() => ({}));
    const price = h?.price || entry.price;
    if (price && data.usage && store.STORE_ON) {
      const u = data.usage;
      const cached = u.prompt_tokens_details?.cached_tokens || 0;
      await store.addSpendToday(user || "anon", ((u.prompt_tokens || 0) - cached) * price.in + cached * (price.cached ?? price.in) + (u.completion_tokens || 0) * price.out).catch(() => {});
    }
    const text = data.choices?.[0]?.message?.content || "";
    if (r.ok && text.trim()) return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    lastError = data.error?.message || data.error || `HTTP ${r.status}`;
  }
  throw new Error(String(lastError));
}

// A Project's instructions and files, added to the system prompt of chats started in it (cut to fit the model).
function projectBlock(project, contextTokens) {
  const budget = Math.max(4000, Math.floor(contextTokens * 3.6 * 0.45));
  let out = `\n\n# Project: ${project.name}\n`;
  if (project.instructions?.trim()) out += `The user's instructions for this project:\n${project.instructions.trim()}\n`;
  if (project.files?.length) {
    out += "\nThe project's files, for reference (quote and use them when they're relevant):\n";
    const per = Math.floor((budget - out.length) / project.files.length);
    for (const f of project.files) {
      const text = f.text.length > per ? f.text.slice(0, per) + `\n… (the rest of ${f.name} didn't fit)` : f.text;
      out += `\n<file name="${String(f.name).replace(/"/g, "'")}">\n${text}\n</file>\n`;
    }
  }
  return out.slice(0, budget + 2000);
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
  const native = agent && cleanTools(payload.tools) ? { tools: cleanTools(payload.tools), toolFormat: typeof payload.toolFormat === "string" ? payload.toolFormat : "" } : null;
  if (payload.agent === true && !agent) return sendJson(res, 401, { error: "Sign in to use yAI Code" });
  const history = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = history
    .filter((m) => m && ["user", "assistant"].includes(m.role))
    .map((m) => ({ role: m.role, content: m.role === "user" ? cleanContent(m.content) : m.content, ...(agent && m.role === "assistant" && typeof m.reasoning === "string" && { reasoning: m.reasoning.slice(0, 40000) }) }))
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
  let model = modelEntry(payload.model) ? payload.model : modelEntry(DEFAULT_MODEL) ? DEFAULT_MODEL : defaultCloud();
  let allowed = modelEntry(model);
  // Deep research runs on yAI Ultra when it's set up and today's allowance isn't used up (Yousef 2026-10-20).
  const research = !agent && payload.research === true && !!currentUser(req);
  // Each person's limits: the defaults, or what an admin set for them on /people.
  const limits = await policy.limitsFor(currentUser(req));
  const ultraUsd = limits.ultraUsd;
  // Bursts and the same message over and over raise a flag for the admins; a burst far past normal use is refused.
  const tooFast = await policy.watch(currentUser(req), { text: textOf(messages[messages.length - 1].content).slice(0, 2000), api: !!req.yaiApiUser });
  if (tooFast) return sendJson(res, 429, { error: tooFast });
  if (research && model !== "deepseek-v4-pro") {
    const ultra = modelEntry("deepseek-v4-pro");
    const spent = store.STORE_ON ? await store.getSpendToday(currentUser(req)).catch(() => 0) : 0;
    if (ultra && cloudOn(ultra) && spent < ultraUsd * 1e6) {
      model = "deepseek-v4-pro";
      allowed = ultra;
    }
  }
  if (allowed.cloud && !cloudOn(allowed)) return sendJson(res, 503, { error: "The cloud model isn't set up right now." });
  // yAI Ultra is billed per token: each person gets a daily allowance.
  // yAI Lite keeps working past the allowance on its free model alone (no paid fallbacks).
  let freeOnly = false;
  if (allowed.price && store.STORE_ON) {
    const spent = await store.getSpendToday(currentUser(req) || "anon").catch(() => 0);
    if (spent >= ultraUsd * 1e6 && allowed.chain) freeOnly = true;
    else if (spent >= ultraUsd * 1e6) {
      await policy.flag(currentUser(req), "limits", `${allowed.label}: $${ultraUsd} a day`, 86400);
      return sendJson(res, 429, { error: `You've used today's $${ultraUsd} of ${allowed.label}. It resets at midnight UTC; the other models still work.` });
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
  const user = currentUser(req);
  const contextTokens = allowed.context || 8192;

  // The website's extras: a Project's files and instructions, and "Search the web" with numbered sources.
  let system = agent ? payload.system.slice(0, AGENT_MAX_SYSTEM) : SYSTEM_PROMPT + VIZ_RULES;
  let sources = null, searched = 0, searchNote = "";
  // Prompt caching (2026-10-21): the hosted models bill a prompt's repeated beginning at about a tenth of the price,
  // but only if it is exactly the same as last time. So the system prompt keeps only what stays put for the whole
  // conversation, and what changes from one message to the next (web results, research, Google, the canvas text,
  // yAI Code's environment) goes at the end of the newest message instead.
  let late = "";
  if (agent && typeof payload.context === "string") late += "\n\n" + payload.context.slice(0, 12000);
  if (!agent && user && typeof payload.projectId === "string" && store.STORE_ON) {
    const project = await store.getProject(user, payload.projectId.slice(0, 64)).catch(() => null);
    if (project) system += projectBlock(project, contextTokens);
  }
  // Study mode (2026-10-20): a tutor that guides instead of handing over answers.
  if (!agent && payload.study === true) system += STUDY_BLOCK;
  // Canvas (2026-10-20): long documents and code go in one canvas block the page opens beside the chat.
  if (!agent && payload.canvas) { system += CANVAS_RULES; late += canvasText(payload.canvas); }
  // Calendar and email (2026-10-20): the person's Google calendar and inbox, when they connected them and turned it on.
  if (!agent && user && payload.google === true) {
    try {
      late += await require("./google").contextBlock(user, textOf(messages[messages.length - 1].content));
    } catch (err) {
      searchNote = `Couldn't read your Google account just now (${err.message}).`;
    }
  }
  // Memory: what yAI remembers about this person, and how it saves new facts (stripped from the reply below).
  let memoryOn = false;
  if (!agent && user && store.STORE_ON) {
    const mem = await store.getMemory(user).catch(() => null);
    if (mem && mem.enabled !== false) {
      memoryOn = true;
      system += memoryBlock(mem.items || []);
    }
  }
  if (research && limits.searches != null && store.STORE_ON && (await store.peekToday(`search:u:${user}`).catch(() => 0)) > limits.searches - 6) {
    return sendJson(res, 429, { error: `Deep research needs about 6 web searches, and today's ${limits.searches} are nearly used up. Try again tomorrow.` });
  }
  if (!agent && !research && payload.webSearch === true) {
    if (limits.searches != null && store.STORE_ON && (await store.countToday(`search:u:${user}`).catch(() => 0)) > limits.searches) {
      await policy.flag(user, "limits", `web searches: ${limits.searches} a day`, 86400);
      return sendJson(res, 429, { error: `You've used today's ${limits.searches} web searches. Turn off Search the web, or try again tomorrow.` });
    }
    const question = textOf(messages[messages.length - 1].content).split("\n\n[Attached ")[0];
    try {
      const web = await webContext(question, contextTokens);
      late += web.block;
      sources = web.sources;
      searched = 1;
      if (!sources.length) searchNote = "The web search found nothing for this, so the answer is from the model alone.";
    } catch (err) {
      // Said on the page too: small models often ignore the instruction, and the failure was invisible (2026-10-20).
      console.warn("web search failed:", err.message);
      searchNote = "Couldn't search the web just now, so the answer is from the model alone.";
      late += `\n\n# Web search\nThe web search failed (${err.message}). Tell the user it couldn't search right now, then answer from what you know.`;
    }
  }
  // Searching and using tools on its own (2026-10-21): a quick check by yAI Ultra Flash (a few tokens, about a second)
  // decides whether the question needs the web (when Search isn't pressed) or one of the person's connected tools
  // (connections: weather, maps, Wolfram Alpha, papers, YouTube, their GitHub, LEARN). Searches count
  // against the limits as if Search had been pressed; tool results come with their sources.
  let toolsUsed = [];
  const cards = []; // live data cards (weather, stocks, scores) the page draws above the answer
  let openedEarly = false; // the stream opened while the tools ran (live steps)
  if (!agent && !research && payload.autoSearch !== false && user) {
    const question = textOf(messages[messages.length - 1].content).split("\n\n[Attached ")[0].trim();
    const router = modelEntry("deepseek-v4.1-flash");
    const room = !searched && (limits.searches == null || !store.STORE_ON || (await store.peekToday(`search:u:${user}`).catch(() => 0)) < limits.searches);
    const tools = store.STORE_ON ? await connectors().available(user).catch(() => []) : [];
    system += connectors().actionsBlock(tools);
    const toolLines = connectors().routerLines(tools);
    if (question.split(/\s+/).length >= 2 && router && cloudOn(router) && (room || toolLines)) {
      try {
        const earlier = messages.slice(-3, -1).map((m) => `${m.role}: ${textOf(m.content).slice(0, 300)}`).join("\n");
        const verdict = String(await completeOnce(router, router.id, [
          { role: "system", content: searchRouterPrompt(toolLines, room) },
          { role: "user", content: `${earlier ? `Earlier in the chat:\n${earlier}\n\n` : ""}Latest message:\n${question.slice(0, 1500)}` },
        ], 200, AbortSignal.timeout(7000), user) || "");
        const calls = [...verdict.matchAll(/^\s*TOOL:\s*([\w.]+)\s*(\{.*\})?\s*$/gim)].slice(0, 3)
          .map((m) => { let args = {}; try { args = JSON.parse(m[2] || "{}"); } catch {} return { name: m[1], args }; })
          .filter((c) => tools.some((t) => t.name === c.name && !t.write));
        const s = room && /SEARCH:\s*(.+)/i.exec(verdict);
        // Live steps (2026-10-21): the page shows what's being looked up while it happens, in place of the dots.
        const { describe, labelOf } = require("./connectors/describe");
        const toolSteps = [
          ...(s ? [{ label: labelOf("web"), text: describe("web.search", { query: s[1].trim() }), state: "running" }] : []),
          ...calls.map((c) => ({ label: labelOf(c.name), text: describe(c.name, c.args), state: "running" })),
        ];
        if (toolSteps.length) {
          if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
          openedEarly = true;
          res.write(`data: ${JSON.stringify({ toolSteps })}\n\n`);
        }
        const settle = (i, ok) => { toolSteps[i].state = ok ? "done" : "failed"; res.write(`data: ${JSON.stringify({ toolSteps })}\n\n`); };
        const [web, ...results] = await Promise.all([
          s ? (store.STORE_ON ? store.countToday(`search:u:${user}`).catch(() => 0) : 0).then(() => webContext(s[1].trim().slice(0, 200), contextTokens))
            .then((w) => (settle(0, true), w), (err) => { settle(0, false); throw err; }) : null,
          ...calls.map((c, k) => Promise.race([
            connectors().runTool(user, c.name, c.args),
            new Promise((_, no) => setTimeout(() => no(new Error("took too long")), 20000)),
          ]).then((r) => (settle(k + (s ? 1 : 0), true), r), (err) => (settle(k + (s ? 1 : 0), false), { tool: c.name, error: err.message }))),
        ]);
        if (web) { late += web.block; sources = web.sources; searched = 1; if (calls.length) toolsUsed.push("Web search"); }
        if (results.length) {
          const list = sources ? [...sources] : [];
          late += "\n\n# Results from the user's connected tools (fetched just now)\nAnswer from these. When you use a numbered source, cite it like [n].";
          for (const r of results) {
            if (r.error) { late += `\n\n## ${r.tool} failed\n${r.error}. Tell the user briefly if it matters.`; continue; }
            const first = list.length + 1;
            for (const src of r.sources) list.push({ n: list.length + 1, ...src, text: String(r.text || "").slice(0, 1800) });
            late += `\n\n## ${r.label}: ${r.tool}${r.sources.length ? ` (sources [${first}]${r.sources.length > 1 ? `–[${list.length}]` : ""})` : ""}\n${r.text}`;
            toolsUsed.push(r.label);
            if (r.card) cards.push(r.card);
          }
          if (list.length) sources = list;
          if (store.STORE_ON) await store.trackUsage(user, { tools: results.length }).catch(() => {});
        }
      } catch (err) {
        console.warn("auto search/tools skipped:", err.message);
      }
    }
  }

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
  // Deep research also opens the stream straight away, so the page can show each step while it works.
  const live = (allowed.cloud && agent) || research || openedEarly;
  let statusTimer;
  if (live && !res.headersSent) res.writeHead(200, sse);
  if (live && agent) {
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

  // Deep research: plan, search, read, fill gaps; the sources go into the system prompt for the report.
  if (research) {
    const question = textOf(messages[messages.length - 1].content).split("\n\n[Attached ")[0];
    try {
      const r = await runResearch({
        question,
        contextTokens,
        deadline: started + 250000, // /api/chat may run 300 s; the report needs the rest
        search,
        fetchPage,
        onStatus: (s) => !upstreamAbort.signal.aborted && emit({ status: s }),
        complete: (msgs, maxTokens) => completeOnce(allowed, model, msgs, allowed.price ? 3000 : maxTokens, upstreamAbort.signal, user),
      });
      late += r.block;
      sources = r.sources;
      searched = r.searches;
      if (store.STORE_ON) for (let i = 0; i < r.searches; i++) await store.countToday(`search:u:${user}`).catch(() => 0);
      if (!sources.length) searchNote = "The research found no sources, so the report is from the model alone.";
    } catch (err) {
      if (upstreamAbort.signal.aborted) return fail(499, "Stopped", "stopped");
      console.warn("research failed:", err.message);
      searchNote = "The research step failed, so the answer is from the model alone.";
    }
  }

  // The changing context rides on the newest message, after a marker the model is told about.
  if (late) {
    const last = messages[messages.length - 1];
    const note = "\n\n<context for this message only>" + late + "\n</context>";
    last.content = typeof last.content === "string" ? last.content + note : [...last.content, { type: "text", text: note }];
  }
  const promptChars = JSON.stringify(messages).length + system.length;
  let upstream;
  let served = null; // the host that answered, for what the reply cost
  let servedFallback = false; // it was a fallback, not the model's first host (shown on the /team board)
  // what each skipped host said, added to the error when the last one fails too (2026-10-22: images fell from Gemini
  // to Modal, and only Modal's billing error showed); `tries` for the same message
  const skipped = [];
  let tries = [];
  // thinking, when yAI Code asks for it (see bodyFor); dropped for the rest of the request if DeepSeek refuses it
  let think = agent && ["low", "high", "max"].includes(payload.think) ? payload.think : null, thinkDropped = false;
  try {
    const base = {
      model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature,
      chat_template_kwargs: { enable_thinking: false }, // thinking is always off: it's far slower
      stream: true,
      stream_options: { include_usage: true }, // exact token counts in the final chunk
    };
    const shared = allowed.cloud && allowed.host.kind === "shared";
    const maxTokens = shared ? ULTRA_MAX_TOKENS[agent ? "agent" : "web"] : agent || research ? AGENT_MAX_TOKENS : CLOUD_MAX_TOKENS;
    // Ultra (Modal's shared endpoint) streams through fetchStream; stream=false asks for a whole reply (fetchWhole).
    tries = allowed.cloud ? hostsFor(allowed, base.messages).filter((h) => !freeOnly || !h.price.in) : [];
    if (allowed.cloud && !tries.length) return fail(503, hasImage(base.messages) ? "No image model is set up: add GEMINI_API_KEY or GROQ_API_KEY on Vercel." : `${allowed.label} has no host set up right now.`, "no host");
    // A host that refused (a used-up quota, billing, a bad request) is left out for the rest of this request, and a
    // refusal from the last one is final (2026-10-22 review: every retry started again at the first host, 36 requests
    // and 24 s before an image request failed). Only server errors and time-outs are worth trying again.
    const out = new Set();
    const refused = (status) => status >= 400 && status < 500 && status !== 408;
    const cloudFetch = async (stream = true) => {
      const left = tries.filter((h) => !out.has(h));
      for (let i = 0; i < left.length; i++) {
        const h = left[i], last = i === left.length - 1;
        const who = `${h.host.name || "Modal"} (${h.upstream})`;
        try {
          let r = await fetch(`${h.host.base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.host.key}` },
            signal: upstreamAbort.signal,
            body: JSON.stringify(bodyFor(h, { ...base, think, model: h.upstream, max_tokens: hostMaxTokens(h, agent, maxTokens), ...(!stream && { stream: false, stream_options: undefined }) }, native)),
          });
          // thinking refused (most likely an earlier step's reasoning_content that DeepSeek wanted back and didn't get):
          // the same host again without thinking, and yAI Code is told so it stops asking for it in this chat
          if (!r.ok && think && h.host.deepseek && r.status === 400) {
            const said = await r.text().catch(() => "");
            if (/reasoning|thinking/i.test(said)) {
              console.warn(`${allowed.label}: thinking refused, again without it:`, said.slice(0, 200));
              think = null; thinkDropped = true; i--;
              continue;
            }
            r = new Response(said, { status: r.status, headers: r.headers }); // read once: the usual handling below
          }
          if (r.ok || last) {
            served = h; servedFallback = tries.indexOf(h) > 0;
            if (!r.ok && refused(r.status) && r.status !== 429) r.final = true; // billing or a bad request: retrying won't help
            return r;
          }
          const said = (await r.text().catch(() => "")).slice(0, 200);
          if (refused(r.status)) out.add(h);
          if (!skipped.some((x) => x.startsWith(who))) skipped.push(`${who}: HTTP ${r.status} ${said.replace(/\s+/g, " ").slice(0, 140)}`);
          console.warn(`${allowed.label} via ${who}: HTTP ${r.status}, trying the next host`, said);
        } catch (err) {
          if (err.name === "AbortError" || last) throw err;
          if (!skipped.some((x) => x.startsWith(who))) skipped.push(`${who}: ${String(err.message).slice(0, 140)}`);
          console.warn(`${allowed.label} via ${who} failed, trying the next host:`, err.message);
        }
      }
    };
    upstream = allowed.cloud
      ? shared ? await fetchStream(cloudFetch, allowed.label) : await cloudFetch()
      : await fetch(`${LMSTUDIO_URL}/chat/completions`, {
          method: "POST",
          headers: upstreamHeaders,
          signal: upstreamAbort.signal,
          // LM Studio also needs reasoning_effort to turn thinking off for some models.
          body: JSON.stringify({ ...base, messages: stripReasoning(base.messages), reasoning_effort: "none" }),
        });
  } catch (err) {
    if (upstreamAbort.signal.aborted) return fail(499, "Stopped", "stopped");
    return fail(502, `${unreachable(err)}${skipped.length ? ` [before that: ${skipped.join("; ")}]` : ""}`, "model unreachable");
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
    return fail(502, `${msg || "The model returned an error"}${skipped.length ? ` [before that: ${skipped.join("; ")}]` : tries.length ? ` [tried: ${tries.map((h) => h.host.name || "Modal").join(", ")}]` : ""}. Please try again in a moment.`, `model error ${upstream.status}`);
  }

  // Re-emit the model's SSE stream as a simpler stream of our own events.
  if (!live) res.writeHead(200, sse);
  else emit({ status: "thinking" });
  if (servedFallback && served) emit({ fallback: served.upstream }); // first: yAI Code stops reading at a tool call
  if (thinkDropped) emit({ thinkingOff: true }); // DeepSeek refused thinking for this chat: yAI Code stops asking
  if (sources?.length) emit({ sources });
  if (toolsUsed.length) emit({ toolsUsed: [...new Set(toolsUsed)] });
  if (cards.length) emit({ cards });
  if (searchNote) emit({ searchNote });

  // If a model thinks anyway, drop its reasoning: never forward reasoning_content,
  // and strip inline <think>…</think> blocks, holding back a partial "<think" tag.
  // Each streamed delta is one token, so `t` gives the UI a live count (including any hidden
  // thinking); LM Studio's exact usage replaces it at the end.
  let raw = "", sent = 0, tokens = 0, usage, thinking = "";
  const calls = []; // native tool calls (DeepSeek's API), by index: { name, arguments }
  const pushContent = (piece) => {
    raw += piece;
    tokens++;
    answer = raw.replace(/<think>[\s\S]*?(<\/think>\s*|$)/g, "");
    // Memory notes (<remember>…</remember>) are saved, never shown; a partial tag is held back like <think>.
    if (memoryOn) answer = answer.replace(/\s*<remember>[\s\S]*?(<\/remember>|$)/g, "");
    let safe = answer.length;
    for (let i = Math.max(0, answer.length - 10); i < answer.length; i++) {
      const tail = answer.slice(i);
      if ("<think>".startsWith(tail) || (memoryOn && "<remember>".startsWith(tail))) { safe = i; break; }
    }
    if (safe > sent) {
      emit({ content: answer.slice(sent, safe), t: tokens });
      sent = safe;
    } else if (tokens % 8 === 0) emit({ t: tokens });
  };

  const decoder = new TextDecoder();
  let buffer = "";
  let streamError;
  // /api/chat may run 300 s (vercel.json). A reply still going at 280 s is ended here and sent as it is, with a tool
  // call's arguments as far as they got: otherwise the function is killed, and a native tool call (held until the
  // end) never reached yAI Code at all ("the model sent back nothing", 2026-10-23, a 400-line file on Ultra Flash).
  // yAI Code then saves the complete lines of a cut-off file and asks the model to go on.
  const STREAM_UNTIL = started + 280000;
  // A reply stuck repeating itself is ended too (2026-10-23: 300,000 characters of "oak_leaves_1829, …" inside one
  // native tool call, for nearly 5 minutes; the same recipe lines 50 times in a file): lib/loops.js, every 4,000
  // characters past 10,000. yAI Code sees it cut off and tells the model why.
  let loopAt = 0, callTokens = 0;
  const looping = () => {
    const all = raw + calls.map((c) => c?.arguments || "").join("");
    if (all.length < 10000 || all.length - loopAt < 4000) return false;
    loopAt = all.length;
    return !!require("./loops").looping(all);
  };
  try {
    for await (const chunk of upstream.body) {
      if (Date.now() > STREAM_UNTIL || looping()) break; // leaving the loop closes the stream, so the model stops too
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
          if (delta.reasoning_content || delta.reasoning) {
            const r = delta.reasoning_content || delta.reasoning;
            thinking += r;
            // asked-for thinking goes to yAI Code, which sends it back with the next steps (see bodyFor); the count
            // keeps moving while it thinks
            if (think) { tokens++; emit({ r, ...(tokens % 8 === 0 && { t: tokens + callTokens }) }); }
          }
          for (const tc of delta.tool_calls || []) {
            const c = (calls[tc.index ?? 0] ||= { name: "", arguments: "" });
            if (tc.function?.name) c.name = tc.function.name;
            const a = tc.function?.arguments;
            if (a) c.arguments += typeof a === "string" ? a : JSON.stringify(a);
            // a token count while a native call is written, so yAI Code shows it writing, not "thinking" for minutes
            if (a && ++callTokens % 8 === 0) emit({ t: tokens + callTokens });
          }
        } catch {}
      }
    }
    // one step per reply: the first native tool call, as yAI Code's own block
    const first = calls.find((c) => c && c.name);
    if (first) pushContent(`${raw.trim() ? "\n\n" : ""}${toolBlock(first)}`);
    // Kimi K3 thinks first (it can't be switched off), and now and then writes its tool call inside the thinking,
    // which is never shown. In yAI Code that step would be lost, so a tool call found there is passed on.
    // DeepSeek (yAI Ultra Flash) can do the same with its own <｜DSML｜ …> markup.
    // (DeepSeek's own API doubles the bars: <｜｜DSML｜｜ …>)
    if (agent && !think && !/<\|open\|>tools|<｜+DSML｜+|(^|\n)[ \t]*<tool[\s>]/.test(raw)) {
      const at = thinking.search(/<\|open\|>tools|<｜+DSML｜+\s*(?:function_|tool_)?calls>|<tool\s+name=/);
      if (at >= 0) pushContent("\n" + thinking.slice(at));
    }
    // New memories the model noted, saved for later chats (at most 3 a reply).
    if (memoryOn) {
      const facts = [...raw.matchAll(/<remember>([\s\S]*?)<\/remember>/g)].map((m) => m[1].replace(/\s+/g, " ").trim()).filter((f) => f.length > 3 && f.length < 300).slice(0, 3);
      if (facts.length) {
        const added = await store.addMemories(user, facts).catch(() => []);
        if (added.length) emit({ memory: added });
      }
    }
  } catch (err) {
    if (!upstreamAbort.signal.aborted) {
      streamError = err.message;
      emit({ error: `Stream interrupted: ${err.message}` });
    }
  }
  // What this reply cost, for the per-token models' daily allowance (cached prompt tokens are cheaper). Ultra's
  // stream carries no usage (see where it is requested), so it is estimated from the text at ~3.6 characters a
  // token, counting the whole prompt at the full price so the estimate errs high.
  let micros = 0;
  if (allowed.price) {
    const price = served?.price || allowed.price;
    const u = usage || { prompt_tokens: Math.round(promptChars / 3.6), completion_tokens: Math.round((raw.length + thinking.length) / 3.6) };
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    micros = ((u.prompt_tokens || 0) - cached) * price.in + cached * price.cached + (u.completion_tokens || 0) * price.out;
    if (store.STORE_ON) await store.addSpendToday(user || "anon", micros).catch(() => {});
  }
  // The end, with what the reply cost (yAI Code's status line shows the session's spend).
  if (!streamError && !upstreamAbort.signal.aborted) {
    const spentToday = allowed.price && store.STORE_ON && user ? await store.getSpendToday(user).catch(() => 0) : 0;
    emit({ done: true, usage: { in: usage?.prompt_tokens, out: usage?.completion_tokens ?? tokens, cached: usage?.prompt_tokens_details?.cached_tokens || undefined },
      ...(allowed.price && { costUsd: micros / 1e6, ultraTodayUsd: spentToday / 1e6, ultraLimitUsd: ultraUsd }) });
  }
  // Each person's counters for the /usage page.
  if (store.STORE_ON && user) {
    await store.trackUsage(user, {
      [agent ? "codeMessages" : req.yaiApiUser ? "apiMessages" : "messages"]: 1,
      tokensIn: usage?.prompt_tokens || Math.round(promptChars / 3.6),
      tokensOut: usage?.completion_tokens ?? tokens,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens || 0,
      ultraMicros: micros,
      searches: searched,
      [`m:${allowed.label}`]: 1,
    }).catch(() => {});
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
  hostsFor, // where a request goes (tests)
  toolBlock, // a native tool call as yAI's own block (test/crew-team)
  bodyFor, // what each host is sent, thinking included (test/crew-team)
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
  ULTRA_DAILY_USD,
  SEARCH_DAILY,
  MODELS,
  modelEntry,
  completeOnce,
  cloudOn,
  webContext,
  searchRouterPrompt,
};
