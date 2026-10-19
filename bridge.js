// Runs on the PC with LM Studio. Exposes LM Studio's /v1 API to the tunnel,
// but only for requests carrying `Authorization: Bearer <BRIDGE_TOKEN>`.
// Point your tunnel (cloudflared / ngrok) at this port, never at LM Studio itself.
// Also stores the site's activity log (activity.jsonl) and user accounts and
// their saved chats (data/), so everything stays on this PC.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.BRIDGE_PORT) || 8787;
const LMSTUDIO_ORIGIN = (process.env.LMSTUDIO_ORIGIN || "http://localhost:1234").replace(/\/$/, "");
const TOKEN = process.env.BRIDGE_TOKEN;
const ACTIVITY_FILE = process.env.ACTIVITY_FILE || path.join(__dirname, "activity.jsonl");
const PROXIED = new Set(["GET /v1/models", "POST /v1/chat/completions"]);
const MAX_EVENT_BYTES = 1024 * 1024; // chat events can carry attachment thumbnails
const MAX_EVENTS_RETURNED = 5000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CHATS_DIR = path.join(DATA_DIR, "chats");
const MAX_CHAT_BYTES = 3 * 1024 * 1024;
const MAX_CHATS_PER_USER = 300;
fs.mkdirSync(CHATS_DIR, { recursive: true });

if (!TOKEN || TOKEN.length < 24) {
  console.error("Set BRIDGE_TOKEN to a long random secret (24+ chars). Generate one with:");
  console.error(`  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
  process.exit(1);
}
const expected = Buffer.from(`Bearer ${TOKEN}`);

function authorized(header = "") {
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

async function saveEvent(req, res) {
  let event;
  try {
    event = JSON.parse(await readBody(req, MAX_EVENT_BYTES));
  } catch {
    return sendJson(res, 400, { error: "Invalid event" });
  }
  fs.appendFile(ACTIVITY_FILE, JSON.stringify(event) + "\n", (err) =>
    err ? sendJson(res, 500, { error: err.message }) : sendJson(res, 200, { ok: true })
  );
}

function listEvents(res) {
  fs.readFile(ACTIVITY_FILE, "utf8", (err, text) => {
    if (err && err.code !== "ENOENT") return sendJson(res, 500, { error: err.message });
    const events = [];
    for (const line of (text || "").split("\n").slice(-MAX_EVENTS_RETURNED)) {
      try {
        if (line) events.push(JSON.parse(line));
      } catch {}
    }
    sendJson(res, 200, { events });
  });
}

// ---------- Accounts and saved chats ----------
// users.json maps lowercase usernames to { username, salt, hash, createdAt } (scrypt hashes).
// Each user's chats live in chats/<sha256(username)>.json as { [chatId]: chat }.
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; // write-then-rename so a crash can't leave half a file
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString("hex");
const chatsFile = (username) =>
  path.join(CHATS_DIR, crypto.createHash("sha256").update(username.toLowerCase()).digest("hex") + ".json");

async function jsonBody(req, limit = 64 * 1024) {
  return JSON.parse((await readBody(req, limit)).toString("utf8"));
}

async function registerUser(req, res) {
  let body;
  try { body = await jsonBody(req); } catch { return sendJson(res, 400, { error: "Invalid request" }); }
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!USERNAME_RE.test(username)) {
    return sendJson(res, 400, { error: "Username must be 3–24 letters, numbers, dots, dashes or underscores" });
  }
  if (password.length < 8 || password.length > 200) return sendJson(res, 400, { error: "Password must be at least 8 characters" });
  const users = readJson(USERS_FILE, {});
  const key = username.toLowerCase();
  if (users[key]) return sendJson(res, 409, { error: "That username is taken" });
  const salt = crypto.randomBytes(16).toString("hex");
  users[key] = { username, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
  writeJson(USERS_FILE, users);
  sendJson(res, 200, { username });
}

async function verifyUser(req, res) {
  let body;
  try { body = await jsonBody(req); } catch { return sendJson(res, 400, { error: "Invalid request" }); }
  const user = readJson(USERS_FILE, {})[String(body.username || "").trim().toLowerCase()];
  const given = Buffer.from(hashPassword(String(body.password || ""), user ? user.salt : "no-user"), "hex");
  const ok = user && crypto.timingSafeEqual(given, Buffer.from(user.hash, "hex"));
  if (!ok) return sendJson(res, 401, { error: "Wrong username or password" });
  sendJson(res, 200, { username: user.username });
}

function listUsers(res) {
  const users = Object.values(readJson(USERS_FILE, {})).map((u) => ({
    username: u.username,
    createdAt: u.createdAt,
    chats: Object.keys(readJson(chatsFile(u.username), {})).length,
  }));
  sendJson(res, 200, { users });
}

async function chatsRoute(req, res, params) {
  const username = params.get("user") || "";
  if (!readJson(USERS_FILE, {})[username.toLowerCase()]) return sendJson(res, 404, { error: "Unknown user" });
  const file = chatsFile(username);
  const chats = readJson(file, {});
  const id = params.get("id");

  if (req.method === "GET" && !id) {
    const list = Object.values(chats)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return sendJson(res, 200, { chats: list });
  }
  if (req.method === "GET") return chats[id] ? sendJson(res, 200, { chat: chats[id] }) : sendJson(res, 404, { error: "Chat not found" });
  if (req.method === "DELETE") {
    delete chats[id];
    writeJson(file, chats);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "PUT") {
    let chat;
    try { chat = await jsonBody(req, MAX_CHAT_BYTES); } catch { return sendJson(res, 400, { error: "Chat too large or invalid" }); }
    if (!chat.id || typeof chat.id !== "string" || !Array.isArray(chat.messages)) return sendJson(res, 400, { error: "Invalid chat" });
    chats[chat.id] = { id: chat.id, title: String(chat.title || "New chat").slice(0, 120), messages: chat.messages, updatedAt: new Date().toISOString() };
    // Keep the newest chats if a user goes over the limit.
    const ids = Object.values(chats).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => c.id);
    for (const old of ids.slice(MAX_CHATS_PER_USER)) delete chats[old];
    writeJson(file, chats);
    return sendJson(res, 200, { ok: true });
  }
  sendJson(res, 405, { error: "Method not allowed" });
}

// ---------- Model warm-up with live load progress ----------
// LM Studio only reports load progress on its native /api/v1/chat stream, so a warm-up is a
// 1-token chat that makes LM Studio load the model. One warm-up runs per model at a time;
// everyone who asks while it's loading watches the same progress.
const warmups = new Map(); // model -> { progress, listeners: Set<fn> }

async function modelState(model) {
  const r = await fetch(`${LMSTUDIO_ORIGIN}/api/v1/models`, { signal: AbortSignal.timeout(5000) });
  const m = ((await r.json()).models || []).find((x) => x.key === model);
  return m ? (m.loaded_instances?.length ? "loaded" : "not-loaded") : "missing";
}

function startWarmup(model) {
  const job = { progress: 0, listeners: new Set() };
  const notify = (ev) => job.listeners.forEach((fn) => fn(ev));
  warmups.set(model, job);
  (async () => {
    try {
      const r = await fetch(`${LMSTUDIO_ORIGIN}/api/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: ".", stream: true, max_output_tokens: 1 }),
      });
      if (!r.ok || !r.body) throw new Error(`LM Studio returned ${r.status}`);
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev.type === "model_load.progress") { job.progress = ev.progress; notify({ state: "loading", progress: ev.progress }); }
          else if (ev.type === "error") throw new Error(ev.error?.message || "load failed");
        }
      }
      notify({ state: "loaded", progress: 1 });
    } catch (err) {
      notify({ state: "error", error: err.message });
    } finally {
      warmups.delete(model);
    }
  })();
  return job;
}

async function warmup(req, res, model) {
  if (!model) return sendJson(res, 400, { error: "model is required" });
  let state;
  try {
    state = await modelState(model);
  } catch {
    return sendJson(res, 503, { error: "LM Studio's server isn't running on the host PC", lmstudioDown: true });
  }
  if (state === "missing") return sendJson(res, 404, { error: "Unknown model" });

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" });
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (state === "loaded" && !warmups.has(model)) {
    send({ state: "loaded", progress: 1 });
    return res.end();
  }
  const job = warmups.get(model) || startWarmup(model);
  send({ state: "loading", progress: job.progress });
  const listener = (ev) => {
    send(ev);
    if (ev.state !== "loading") { job.listeners.delete(listener); res.end(); }
  };
  job.listeners.add(listener);
  // A viewer leaving doesn't cancel the load; others may be waiting on it.
  res.on("close", () => job.listeners.delete(listener));
}

async function proxy(req, res, pathname) {
  const abort = new AbortController();
  res.on("close", () => abort.abort()); // propagate Stop / disconnects to LM Studio
  try {
    const body = req.method === "POST" ? await readBody(req, 8_000_000) : undefined; // images inline
    const upstream = await fetch(LMSTUDIO_ORIGIN + pathname, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body,
      signal: abort.signal,
    });
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-cache, no-transform",
    });
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (err) {
    if (abort.signal.aborted) return;
    // 503, not 502: Cloudflare swaps origin 502s for its own HTML error page.
    if (!res.headersSent) {
      sendJson(res, 503, { error: "LM Studio's server isn't running on the host PC", lmstudioDown: true });
    } else res.end();
  }
}

function route(req, res) {
  const { pathname, searchParams } = new URL(req.url, "http://x");
  if (!authorized(req.headers.authorization)) return sendJson(res, 401, { error: "Unauthorized" });
  const route = `${req.method} ${pathname}`;
  if (route === "POST /v1/activity") return saveEvent(req, res);
  if (route === "GET /v1/activity") return listEvents(res);
  if (route === "GET /v1/warmup") return warmup(req, res, searchParams.get("model"));
  if (route === "POST /v1/users/register") return registerUser(req, res);
  if (route === "POST /v1/users/verify") return verifyUser(req, res);
  if (route === "GET /v1/users") return listUsers(res);
  if (pathname === "/v1/chats") return chatsRoute(req, res, searchParams);
  if (PROXIED.has(route)) return proxy(req, res, pathname);
  sendJson(res, 404, { error: "Not found" });
}

http
  .createServer((req, res) => {
    // Any unexpected error gets a response instead of leaving the request hanging.
    Promise.resolve()
      .then(() => route(req, res))
      .catch((err) => {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong on the host PC" });
        else res.end();
      });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`Bridge listening on http://127.0.0.1:${PORT} -> ${LMSTUDIO_ORIGIN}`);
    console.log(`Activity log: ${ACTIVITY_FILE}`);
  });
