// Sign-up / log-in / log-out, and each user's saved chats. Stored in Upstash Redis when
// it's configured (works even when the host PC is off), otherwise by bridge.js on the PC.

const { sendJson, readBody, logEvent, LMSTUDIO_URL, BRIDGE_TOKEN, upstreamHeaders } = require("./handlers");
const { currentUser, signInCookie, signOutCookie, safeEqual, isAdminAccount } = require("./session");
const store = require("./store");

const ACCESS_CODE = process.env.ACCESS_CODE || "";
const MAX_CHAT_BYTES = 2_500_000;

async function bridge(path, opts = {}) {
  const r = await fetch(`${LMSTUDIO_URL}${path}`, {
    ...opts,
    headers: upstreamHeaders,
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

// The same operations over either backend, each returning { status, data }.
const backend = {
  async register(username, password) {
    if (!store.STORE_ON) return bridge("/users/register", { method: "POST", body: JSON.stringify({ username, password }) });
    const r = await store.registerUser(username, password);
    return r.error ? { status: r.status, data: { error: r.error } } : { status: 200, data: { username: r.username } };
  },
  async verify(username, password) {
    if (!store.STORE_ON) return bridge("/users/verify", { method: "POST", body: JSON.stringify({ username, password }) });
    const name = await store.verifyUser(username, password);
    return name ? { status: 200, data: { username: name } } : { status: 401, data: {} };
  },
  async chats(method, user, id, raw) {
    if (!store.STORE_ON) {
      const query = `?user=${encodeURIComponent(user)}${id ? `&id=${encodeURIComponent(id)}` : ""}`;
      return bridge(`/chats${query}`, { method, body: raw });
    }
    if (method === "GET" && !id) return { status: 200, data: { chats: await store.listChats(user) } };
    if (method === "GET") {
      const chat = await store.getChat(user, id);
      return chat ? { status: 200, data: { chat } } : { status: 404, data: { error: "Chat not found" } };
    }
    if (method === "DELETE") return { status: 200, data: await store.deleteChat(user, id) };
    let chat;
    try { chat = JSON.parse(raw); } catch {}
    if (!chat || typeof chat.id !== "string" || !Array.isArray(chat.messages)) return { status: 400, data: { error: "Invalid chat" } };
    const r = await store.putChat(user, chat);
    return r.error ? { status: r.status, data: { error: r.error } } : { status: 200, data: r };
  },
};

const unavailable = (res) =>
  sendJson(res, 503, {
    error: store.STORE_ON
      ? "Accounts are temporarily unavailable. Try again in a moment."
      : "Accounts are unavailable right now because the host PC is offline. Try again soon.",
  });

async function parse(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    return null;
  }
}

// /api/auth?action=me|register|login|logout
async function handleAuth(req, res) {
  const action = new URL(req.url, "http://x").searchParams.get("action");
  if (action === "me") {
    const user = currentUser(req);
    return sendJson(res, 200, { user, admin: isAdminAccount(user) }, { "Cache-Control": "no-store" });
  }
  if (action === "logout") return sendJson(res, 200, { ok: true }, { "Set-Cookie": signOutCookie(req) });
  if (req.method !== "POST" || !["register", "login"].includes(action)) return sendJson(res, 400, { error: "Unknown action" });
  if (!store.STORE_ON && !BRIDGE_TOKEN) return sendJson(res, 503, { error: "Accounts need Upstash or the bridge" });

  const body = await parse(req);
  if (!body) return sendJson(res, 400, { error: "Invalid request" });

  if (action === "register") {
    if (ACCESS_CODE && !safeEqual(String(body.code || "").trim().toLowerCase(), ACCESS_CODE.toLowerCase())) {
      if (body.code) await logEvent(req, { type: "denied", codeTried: String(body.code).slice(0, 60), during: "signup" });
      return sendJson(res, 401, { error: "That access code isn't right", field: "code" });
    }
    let result;
    try { result = await backend.register(body.username, body.password); } catch { return unavailable(res); }
    if (result.status !== 200) return sendJson(res, result.status === 409 ? 409 : 400, { error: result.data.error || "Couldn't create the account" });
    await logEvent(req, { type: "signup", user: result.data.username });
    return sendJson(res, 200, { user: result.data.username, admin: isAdminAccount(result.data.username) }, { "Set-Cookie": signInCookie(req, result.data.username) });
  }

  let result;
  try { result = await backend.verify(body.username, body.password); } catch { return unavailable(res); }
  if (result.status !== 200) {
    await new Promise((r) => setTimeout(r, 800)); // slow down password guessing
    return sendJson(res, 401, { error: "Wrong username or password" });
  }
  await logEvent(req, { type: "login", user: result.data.username });
  sendJson(res, 200, { user: result.data.username, admin: isAdminAccount(result.data.username) }, { "Set-Cookie": signInCookie(req, result.data.username) });
}

// /api/chats            GET: list   PUT: save {id, title, messages}
// /api/chats?id=...     GET: one    DELETE: remove
async function handleChats(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "Not signed in" });
  if (!store.STORE_ON && !BRIDGE_TOKEN) return sendJson(res, 503, { error: "Saved chats need Upstash or the bridge" });
  const id = new URL(req.url, "http://x").searchParams.get("id");

  let raw;
  if (req.method === "PUT") {
    raw = await readBody(req).catch(() => null);
    if (!raw || raw.length > MAX_CHAT_BYTES) return sendJson(res, 413, { error: "Chat too large to save" });
  } else if (!["GET", "DELETE"].includes(req.method)) {
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  try {
    const result = await backend.chats(req.method, user, id, raw);
    sendJson(res, result.status, result.data, { "Cache-Control": "no-store" });
  } catch {
    unavailable(res);
  }
}

module.exports = { handleAuth, handleChats };
