// Public API keys (2026-10-20): people call yAI's models from their own code with an OpenAI-style API, under their
// own daily limits. Keys are shown once; only their SHA-256 is stored.
//
//   POST https://<site>/v1/chat/completions   { model, messages, stream?, temperature? }   (Authorization: Bearer yai_…)
//   GET  https://<site>/v1/models
//
//   apikeys:<name>      hash  id -> JSON { id, name, prefix, createdAt }
//   apikey:<sha256>     JSON { user, id }
//   apikeyuse:<name>    hash  id -> requests, and id:last -> ISO time of the last one
//
// Hub ops (signed in on the website):  GET ?op=apikeys   POST ?op=apikey { name }   DELETE ?op=apikey&id=…

const crypto = require("crypto");
const store = require("./store");
const { sendJson, readBody, handleChat, handleModels, MODELS, modelEntry } = require("./handlers");

const MAX_KEYS = 10;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const lower = (u) => String(u).toLowerCase();
// Friendly names for the API, besides the models' own ids.
const ALIASES = { "yai-ultra": "kimi-k3-ultra", "yai-ultra-flash": "deepseek-v4.1-flash", "yai-q3.8-max": "qwen3.8-27b-cloud", "yai-max": "qwen3.8-27b-cloud" };

const isApiRequest = (req) => /^Bearer\s+yai_/i.test(req.headers.authorization || "");

async function resolve(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!/^yai_[A-Za-z0-9_-]{20,80}$/.test(token) || !store.STORE_ON) return null;
  const found = store.parse(await store.redis("GET", `apikey:${sha(token)}`).catch(() => null));
  if (!found) return null;
  store.pipeline([
    ["HINCRBY", `apikeyuse:${lower(found.user)}`, found.id, 1],
    ["HSET", `apikeyuse:${lower(found.user)}`, `${found.id}:last`, new Date().toISOString()],
  ]).catch(() => {});
  return found;
}

const ops = {
  "GET apikeys": async ({ res, user, noStore }) => {
    const [flat, use] = await Promise.all([store.redis("HGETALL", `apikeys:${lower(user)}`), store.redis("HGETALL", `apikeyuse:${lower(user)}`)]);
    const usage = {};
    for (let i = 0; use && i < use.length; i += 2) usage[use[i]] = use[i + 1];
    const keys = [];
    for (let i = 0; flat && i < flat.length; i += 2) {
      const k = store.parse(flat[i + 1]);
      if (k) keys.push({ ...k, requests: Number(usage[k.id]) || 0, lastUsed: usage[`${k.id}:last`] || null });
    }
    return sendJson(res, 200, { keys: keys.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }, noStore);
  },
  "POST apikey": async ({ res, user, body }) => {
    const name = String((await body()).name || "").trim().slice(0, 60) || "My key";
    if (((await store.redis("HLEN", `apikeys:${lower(user)}`)) || 0) >= MAX_KEYS) return sendJson(res, 400, { error: `You can have ${MAX_KEYS} keys. Delete one first.` });
    const token = "yai_" + crypto.randomBytes(30).toString("base64url");
    const id = crypto.randomBytes(6).toString("hex");
    const meta = { id, name, prefix: token.slice(0, 10), createdAt: new Date().toISOString() };
    await store.pipeline([
      ["HSET", `apikeys:${lower(user)}`, id, JSON.stringify(meta)],
      ["SET", `apikey:${sha(token)}`, JSON.stringify({ user, id, hash: sha(token) })],
      ["SET", `apikeyhash:${id}`, sha(token)],
    ]);
    return sendJson(res, 200, { key: { ...meta, token } });
  },
  "DELETE apikey": async ({ res, user, url }) => {
    const id = String(url.searchParams.get("id") || "");
    const hash = await store.redis("GET", `apikeyhash:${id}`);
    const owned = await store.redis("HGET", `apikeys:${lower(user)}`, id);
    if (!owned) return sendJson(res, 404, { error: "Key not found" });
    await store.pipeline([["HDEL", `apikeys:${lower(user)}`, id], ["DEL", `apikey:${hash}`], ["DEL", `apikeyhash:${id}`]]);
    return sendJson(res, 200, { ok: true });
  },
};

// ---------- The OpenAI-style endpoints ----------
function openaiError(res, status, message, code = null) {
  sendJson(res, status, { error: { message, type: status === 401 ? "invalid_request_error" : status === 429 ? "rate_limit_error" : "api_error", code } });
}

// Runs handleChat with a stand-in response that turns yAI's own stream into OpenAI's format.
async function chatCompletions(req, res) {
  const who = await resolve(req);
  if (!who) return openaiError(res, 401, "Invalid API key. Create one at /developers.", "invalid_api_key");
  req.yaiApiUser = who.user;
  let p;
  try { p = JSON.parse(await readBody(req)); } catch { return openaiError(res, 400, "The body must be JSON."); }
  const wanted = String(p.model || "qwen3.8-27b-cloud");
  const model = ALIASES[wanted] || wanted;
  const entry = modelEntry(model);
  if (!entry || entry.codeOnly) return openaiError(res, 404, `Unknown model "${wanted}". GET /v1/models lists them.`, "model_not_found");
  // System messages become instructions at the top of the first user message (yAI keeps its own system prompt).
  const msgs = Array.isArray(p.messages) ? p.messages : [];
  const system = msgs.filter((m) => m && m.role === "system").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n\n").trim();
  const messages = msgs.filter((m) => m && (m.role === "user" || m.role === "assistant"));
  if (system && messages[0]?.role === "user" && typeof messages[0].content === "string") {
    messages[0] = { ...messages[0], content: `Instructions:\n${system}\n\n${messages[0].content}` };
  }
  req.body = JSON.stringify({ messages, model, temperature: p.temperature, conversationId: `api-${who.id}` });

  const stream = p.stream === true;
  const id = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null, extra = {}) => ({ id, object: "chat.completion.chunk", created, model: wanted, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  let status = 200, isJson = false, buf = "", text = "", usage = null, error = null, opened = false, finished = false;
  const open = () => {
    if (opened || !stream) return;
    opened = true;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }))}\n\n`);
  };
  const onEvent = (ev) => {
    if (ev.error) error = ev.error;
    if (ev.content) {
      text += ev.content;
      if (stream) { open(); res.write(`data: ${JSON.stringify(chunk({ content: ev.content }))}\n\n`); }
    }
    if (ev.done) usage = { prompt_tokens: ev.usage?.in || 0, completion_tokens: ev.usage?.out || 0, total_tokens: (ev.usage?.in || 0) + (ev.usage?.out || 0) };
  };
  const finish = (body) => {
    if (finished) return;
    finished = true;
    if (isJson || status !== 200) {
      let e = {};
      try { e = JSON.parse(body || "{}"); } catch {}
      return openaiError(res, status === 200 ? 502 : status, e.error || "Something went wrong");
    }
    if (stream) {
      open();
      if (error && !text) res.write(`data: ${JSON.stringify({ error: { message: error, type: "api_error" } })}\n\n`);
      else res.write(`data: ${JSON.stringify(chunk({}, "stop", usage ? { usage } : {}))}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    if (error && !text) return openaiError(res, 502, error);
    sendJson(res, 200, { id, object: "chat.completion", created, model: wanted,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: usage || undefined });
  };
  const fake = {
    writeHead(s, headers = {}) { status = s; isJson = /json/.test(headers["Content-Type"] || ""); return fake; },
    setHeader() {},
    write(piece) {
      buf += String(piece);
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const ev = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (ev.startsWith("data: ")) try { onEvent(JSON.parse(ev.slice(6))); } catch {}
      }
      return true;
    },
    end(piece) {
      if (isJson || status !== 200) return finish(piece);
      if (piece) fake.write(piece);
      finish();
    },
    on(ev, fn) { res.on(ev, fn); return fake; },
  };
  await handleChat(req, fake);
  if (!finished) finish();
}

async function listModels(req, res) {
  const who = await resolve(req);
  if (!who) return openaiError(res, 401, "Invalid API key. Create one at /developers.", "invalid_api_key");
  req.yaiApiUser = who.user;
  let out = null;
  await handleModels(req, { writeHead() {}, setHeader() {}, end(body) { try { out = JSON.parse(body); } catch {} }, on() {} });
  const names = Object.fromEntries(Object.entries(ALIASES).map(([a, id]) => [id, a]));
  const data = (out?.models || []).filter((m) => !m.codeOnly).map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "yai", name: m.label, alias: names[m.id] }));
  sendJson(res, 200, { object: "list", data });
}

module.exports = { ops, isApiRequest, chatCompletions, listModels, MODELS };
