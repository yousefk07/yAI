// Accounts, saved chats and the activity log in Upstash Redis (via its REST API, so no
// npm dependency). Used whenever the Upstash env vars are set; otherwise the site falls
// back to storing everything on the PC through bridge.js.
//
// Keys:
//   user:<name>            JSON { username, salt, hash, createdAt }   (scrypt password hash)
//   users                  set of lowercase usernames
//   chatmeta:<name>        hash  chatId -> JSON { id, title, updatedAt }
//   chat:<name>:<chatId>   JSON { id, title, messages, updatedAt }
//   activity               list of JSON events, newest first
//   img:<name>:<id>        JPEG data URL of a generated image
//   vid:<name>:<id>[:<i>]  generated video, in chunks (see putVideo)

const crypto = require("crypto");

const URL_BASE = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
const STORE_ON = !!(URL_BASE && TOKEN);

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const MAX_CHATS_PER_USER = 300;
const MAX_CHAT_BYTES = 900_000; // stay well under Upstash's request size limit
const MAX_EVENTS = 1000;

async function call(path, body) {
  const r = await fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`Upstash: ${data.error || r.status}`);
  return data;
}
const redis = async (...cmd) => (await call("", cmd)).result;
const pipeline = async (cmds) => (await call("/pipeline", cmds)).map((x) => x.result);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---------- Accounts ----------
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString("hex");

// Returns { username } or { error, status }.
async function registerUser(username, password) {
  username = String(username || "").trim();
  password = String(password || "");
  if (!USERNAME_RE.test(username)) {
    return { status: 400, error: "Username must be 3–24 letters, numbers, dots, dashes or underscores" };
  }
  if (password.length < 8 || password.length > 200) return { status: 400, error: "Password must be at least 8 characters" };
  const key = username.toLowerCase();
  const salt = crypto.randomBytes(16).toString("hex");
  const record = { username, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
  const created = await redis("SET", `user:${key}`, JSON.stringify(record), "NX"); // NX: never overwrite
  if (created !== "OK") return { status: 409, error: "That username is taken" };
  await redis("SADD", "users", key);
  return { username };
}

// Returns the stored username (original casing) or null.
async function verifyUser(username, password) {
  const user = parse(await redis("GET", `user:${String(username || "").trim().toLowerCase()}`));
  const given = Buffer.from(hashPassword(String(password || ""), user ? user.salt : "no-user"), "hex");
  return user && crypto.timingSafeEqual(given, Buffer.from(user.hash, "hex")) ? user.username : null;
}

async function listUsers() {
  const keys = (await redis("SMEMBERS", "users")) || [];
  if (!keys.length) return [];
  const rows = await pipeline(keys.flatMap((k) => [["GET", `user:${k}`], ["HLEN", `chatmeta:${k}`]]));
  return keys.map((k, i) => {
    const u = parse(rows[i * 2]) || {};
    return { username: u.username || k, createdAt: u.createdAt, chats: rows[i * 2 + 1] || 0 };
  });
}

// ---------- Saved chats ----------
async function listChats(username) {
  const flat = (await redis("HGETALL", `chatmeta:${username.toLowerCase()}`)) || [];
  const list = [];
  for (let i = 1; i < flat.length; i += 2) { const m = parse(flat[i]); if (m) list.push(m); }
  return list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

async function getChat(username, id) {
  return parse(await redis("GET", `chat:${username.toLowerCase()}:${id}`));
}

// Big chats (long PDFs, many images) drop attachment text and thumbnails from older
// messages until they fit; the conversation text itself is always kept.
function compact(chat) {
  let json = JSON.stringify(chat);
  for (let i = 0; json.length > MAX_CHAT_BYTES && i < chat.messages.length; i++) {
    const m = chat.messages[i];
    if (m.attachments) m.attachments = m.attachments.map(({ text, thumb, ...rest }) => rest);
    json = JSON.stringify(chat);
  }
  return json.length > MAX_CHAT_BYTES ? null : json;
}

async function putChat(username, { id, title, messages }) {
  const key = username.toLowerCase();
  const updatedAt = new Date().toISOString();
  const chat = { id, title: String(title || "New chat").slice(0, 120), messages, updatedAt };
  const json = compact(chat);
  if (!json) return { status: 413, error: "Chat too large to save" };
  await pipeline([
    ["SET", `chat:${key}:${id}`, json],
    ["HSET", `chatmeta:${key}`, id, JSON.stringify({ id, title: chat.title, updatedAt })],
  ]);
  // Keep only the newest chats if a user goes over the limit.
  const all = await listChats(username);
  const extra = all.slice(MAX_CHATS_PER_USER);
  if (extra.length) {
    await pipeline(extra.flatMap((c) => [["DEL", `chat:${key}:${c.id}`], ["HDEL", `chatmeta:${key}`, c.id]]));
  }
  return { ok: true };
}

async function deleteChat(username, id) {
  const key = username.toLowerCase();
  await pipeline([["DEL", `chat:${key}:${id}`], ["HDEL", `chatmeta:${key}`, id]]);
  return { ok: true };
}

// ---------- Generated images ----------
// Stored as JPEG data URLs under img:<user>:<id> (the browser compresses them to ~200 KB first).
const MAX_IMAGE_BYTES = 900_000;

async function putImage(username, id, dataUrl) {
  if (dataUrl.length > MAX_IMAGE_BYTES) return { status: 413, error: "Image too large to save" };
  await redis("SET", `img:${username.toLowerCase()}:${id}`, dataUrl);
  return { ok: true };
}

const getImage = (username, id) => redis("GET", `img:${username.toLowerCase()}:${id}`);

// Videos are a few MB, over Upstash's per-request limit, so they're stored as base64 chunks
// (vid:<name>:<id> = JSON { mime, n }, vid:<name>:<id>:<i> = chunk) and expire after 30 days.
const VIDEO_CHUNK = 700_000;
const VIDEO_TTL = 30 * 86400;
const MAX_VIDEO_BYTES = 40_000_000;

async function putVideo(username, id, mime, base64) {
  if (base64.length > MAX_VIDEO_BYTES) return { status: 413, error: "Video too large to save" };
  const key = `vid:${username.toLowerCase()}:${id}`;
  const n = Math.ceil(base64.length / VIDEO_CHUNK);
  for (let i = 0; i < n; i++) await redis("SET", `${key}:${i}`, base64.slice(i * VIDEO_CHUNK, (i + 1) * VIDEO_CHUNK), "EX", VIDEO_TTL);
  await redis("SET", key, JSON.stringify({ mime, n }), "EX", VIDEO_TTL); // written last: a video only exists once complete
  return { ok: true };
}

// Returns { mime, n, chunk(i) } or null, so the caller can stream it chunk by chunk.
async function getVideo(username, id) {
  const key = `vid:${username.toLowerCase()}:${id}`;
  const meta = parse(await redis("GET", key));
  if (!meta?.n) return null;
  return { mime: meta.mime, n: meta.n, chunk: (i) => redis("GET", `${key}:${i}`) };
}

// Counts uses per day (UTC) for rate limits; returns the new count.
async function countToday(key) {
  const day = new Date().toISOString().slice(0, 10);
  const [n] = await pipeline([["INCR", `count:${key}:${day}`], ["EXPIRE", `count:${key}:${day}`, 172800]]);
  return n;
}

// ---------- Activity log ----------
async function addEvent(event) {
  await pipeline([["LPUSH", "activity", JSON.stringify(event)], ["LTRIM", "activity", 0, MAX_EVENTS - 1]]);
}

async function listEvents() {
  const rows = (await redis("LRANGE", "activity", 0, MAX_EVENTS - 1)) || [];
  return rows.map(parse).filter(Boolean).reverse(); // oldest first, like the bridge's log
}

module.exports = {
  STORE_ON, registerUser, verifyUser, listUsers,
  listChats, getChat, putChat, deleteChat, addEvent, listEvents,
  putImage, getImage, putVideo, getVideo, countToday,
};
