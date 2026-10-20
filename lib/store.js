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
//   share:<id>             JSON of a yAI Code session shared with /share (expires after SHARE_TTL)

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

async function putChat(username, { id, title, messages, projectId }) {
  const key = username.toLowerCase();
  const updatedAt = new Date().toISOString();
  // projectId: the chat was started in one of the user's Projects (its files and instructions go with it).
  const project = typeof projectId === "string" && projectId ? projectId.slice(0, 64) : undefined;
  const chat = { id, title: String(title || "New chat").slice(0, 120), messages, updatedAt, projectId: project };
  const json = compact(chat);
  if (!json) return { status: 413, error: "Chat too large to save" };
  await pipeline([
    ["SET", `chat:${key}:${id}`, json],
    ["HSET", `chatmeta:${key}`, id, JSON.stringify({ id, title: chat.title, updatedAt, projectId: project })],
  ]);
  // Keep only the newest chats if a user goes over the limit.
  const all = await listChats(username);
  const extra = all.slice(MAX_CHATS_PER_USER);
  if (extra.length) {
    await pipeline(extra.flatMap((c) => [["DEL", `chat:${key}:${c.id}`], ["HDEL", `chatmeta:${key}`, c.id]]));
  }
  return { ok: true };
}

// Clear chat history (2026-10-20): every saved chat of one user. Projects, images and usage are kept.
async function deleteAllChats(username) {
  const key = username.toLowerCase();
  const ids = (await redis("HKEYS", `chatmeta:${key}`)) || [];
  for (let i = 0; i < ids.length; i += 200) await pipeline(ids.slice(i, i + 200).map((id) => ["DEL", `chat:${key}:${id}`]));
  await redis("DEL", `chatmeta:${key}`);
  return { ok: true, deleted: ids.length };
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

// Money spent today on per-token models (yAI Ultra), in millionths of a dollar, per user.
async function getSpendToday(key) {
  const day = new Date().toISOString().slice(0, 10);
  return Number(await redis("GET", `spend:${key}:${day}`)) || 0;
}
async function addSpendToday(key, micros) {
  const day = new Date().toISOString().slice(0, 10);
  await pipeline([["INCRBY", `spend:${key}:${day}`, Math.max(0, Math.round(micros))], ["EXPIRE", `spend:${key}:${day}`, 172800]]);
}

// ---------- Activity log ----------
async function addEvent(event) {
  await pipeline([["LPUSH", "activity", JSON.stringify(event)], ["LTRIM", "activity", 0, MAX_EVENTS - 1]]);
}

async function listEvents() {
  const rows = (await redis("LRANGE", "activity", 0, MAX_EVENTS - 1)) || [];
  return rows.map(parse).filter(Boolean).reverse(); // oldest first, like the bridge's log
}

// ---------- Shared yAI Code sessions (/share) ----------
const SHARE_TTL = 60 * 60 * 24 * 180; // 180 days
async function putShare(id, session) {
  await redis("SET", `share:${id}`, JSON.stringify(session), "EX", SHARE_TTL);
}
async function getShare(id) {
  return parse(await redis("GET", `share:${id}`));
}

// ---------- Usage (the /usage page) ----------
// usage:<name>:<day> is a hash of counters for one UTC day (messages, codeMessages, tokensIn, tokensOut, images,
// videos, searches, ultraMicros, m:<model> = messages per model), kept 100 days; usagetotal:<name> holds the
// same counters since the start.
const USAGE_TTL = 100 * 86400;
async function trackUsage(username, fields) {
  const key = String(username || "anon").toLowerCase();
  const day = new Date().toISOString().slice(0, 10);
  const cmds = [];
  for (const [f, n] of Object.entries(fields)) {
    const v = Math.round(Number(n) || 0);
    if (!v) continue;
    cmds.push(["HINCRBY", `usage:${key}:${day}`, f, v], ["HINCRBY", `usagetotal:${key}`, f, v]);
  }
  if (!cmds.length) return;
  cmds.push(["EXPIRE", `usage:${key}:${day}`, USAGE_TTL]);
  await pipeline(cmds);
}
const hashToObject = (flat) => {
  const o = {};
  for (let i = 0; flat && i < flat.length; i += 2) o[flat[i]] = Number(flat[i + 1]) || 0;
  return o;
};
// { days: [{ day, ...counters }] oldest first, total: {...} }
async function getUsage(username, days = 30) {
  const key = String(username || "anon").toLowerCase();
  const list = [];
  for (let i = days - 1; i >= 0; i--) list.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const rows = await pipeline([...list.map((d) => ["HGETALL", `usage:${key}:${d}`]), ["HGETALL", `usagetotal:${key}`]]);
  return { days: list.map((day, i) => ({ day, ...hashToObject(rows[i]) })), total: hashToObject(rows[list.length]) };
}
// How many of a daily-limited thing were used today (the counters lib/images.js checks), without adding one.
async function peekToday(key) {
  const day = new Date().toISOString().slice(0, 10);
  return Number(await redis("GET", `count:${key}:${day}`)) || 0;
}

// ---------- Projects: files and instructions reused across chats ----------
//   projectmeta:<name>        hash  projectId -> JSON { id, name, files, chars, updatedAt }
//   project:<name>:<id>       JSON { id, name, instructions, files: [{ id, name, chars, text }], updatedAt }
const MAX_PROJECTS = 50;
const MAX_PROJECT_BYTES = 900_000;
async function listProjects(username) {
  const flat = (await redis("HGETALL", `projectmeta:${username.toLowerCase()}`)) || [];
  const list = [];
  for (let i = 1; i < flat.length; i += 2) { const m = parse(flat[i]); if (m) list.push(m); }
  return list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
const getProject = async (username, id) => parse(await redis("GET", `project:${username.toLowerCase()}:${id}`));
async function putProject(username, project) {
  const key = username.toLowerCase();
  const existing = await listProjects(username);
  if (!existing.some((p) => p.id === project.id) && existing.length >= MAX_PROJECTS) return { status: 400, error: `You can have up to ${MAX_PROJECTS} projects` };
  project.updatedAt = new Date().toISOString();
  const json = JSON.stringify(project);
  if (json.length > MAX_PROJECT_BYTES) return { status: 413, error: "The project's files are too large together (about 850,000 characters at most)" };
  const chars = project.files.reduce((n, f) => n + f.text.length, 0);
  await pipeline([
    ["SET", `project:${key}:${project.id}`, json],
    ["HSET", `projectmeta:${key}`, project.id, JSON.stringify({ id: project.id, name: project.name, files: project.files.length, chars, updatedAt: project.updatedAt })],
  ]);
  return { ok: true, project };
}
async function deleteProject(username, id) {
  const key = username.toLowerCase();
  await pipeline([["DEL", `project:${key}:${id}`], ["HDEL", `projectmeta:${key}`, id]]);
  return { ok: true };
}

// ---------- Model arena: blind votes and Elo ratings ----------
//   arena:elo     hash  model -> rating (starts at 1000)
//   arena:stats   hash  <model>:w / :l / :t -> wins, losses, ties
//   arena:votes   list of JSON { a, b, winner, user, ts }, newest first (last 5000)
const ELO_K = 24;
async function arenaVote(a, b, winner, username) {
  const [ra, rb] = (await pipeline([["HGET", "arena:elo", a], ["HGET", "arena:elo", b]])).map((x) => Number(x) || 1000);
  const expectA = 1 / (1 + 10 ** ((rb - ra) / 400));
  const scoreA = winner === "a" ? 1 : winner === "b" ? 0 : 0.5;
  const na = ra + ELO_K * (scoreA - expectA), nb = rb + ELO_K * (expectA - scoreA);
  const outcome = (s) => (s === 1 ? "w" : s === 0 ? "l" : "t");
  await pipeline([
    ["HSET", "arena:elo", a, na.toFixed(2), b, nb.toFixed(2)],
    ["HINCRBY", "arena:stats", `${a}:${outcome(scoreA)}`, 1],
    ["HINCRBY", "arena:stats", `${b}:${outcome(1 - scoreA)}`, 1],
    ["LPUSH", "arena:votes", JSON.stringify({ a, b, winner, user: username, ts: new Date().toISOString() })],
    ["LTRIM", "arena:votes", 0, 4999],
  ]);
  return { a: Math.round(na), b: Math.round(nb) };
}
async function arenaBoard() {
  const [elo, stats] = await pipeline([["HGETALL", "arena:elo"], ["HGETALL", "arena:stats"]]);
  const r = hashToObject(elo), s = hashToObject(stats);
  return Object.keys(r).map((model) => {
    const w = s[`${model}:w`] || 0, l = s[`${model}:l`] || 0, t = s[`${model}:t`] || 0;
    return { model, rating: Math.round(r[model]), wins: w, losses: l, ties: t, votes: w + l + t };
  }).sort((x, y) => y.rating - x.rating);
}

// ---------- Coding benchmark results (yAI Code's /bench) ----------
//   bench:results   list of JSON { model, label, passed, total, solved, tasks, secs, user, ts }, newest first (last 500)
async function addBench(result) {
  await pipeline([["LPUSH", "bench:results", JSON.stringify(result)], ["LTRIM", "bench:results", 0, 499]]);
}
async function listBench() {
  return ((await redis("LRANGE", "bench:results", 0, 499)) || []).map(parse).filter(Boolean);
}

module.exports = {
  STORE_ON, registerUser, verifyUser, listUsers,
  listChats, getChat, putChat, deleteChat, deleteAllChats, addEvent, listEvents,
  putImage, getImage, putVideo, getVideo, countToday, getSpendToday, addSpendToday, putShare, getShare,
  trackUsage, getUsage, peekToday, listProjects, getProject, putProject, deleteProject, arenaVote, arenaBoard, addBench, listBench,
};
