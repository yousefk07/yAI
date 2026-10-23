// Per-person limits, blocks and abuse flags (2026-10-20). Admins change limits and block people on the People
// page (/people); flags are raised here automatically and only admins ever see them.
//
//   policy:<name>     JSON { blocked, reason, limits: { ultraUsd, images, videos, searches, voiceChars }, by, ts }
//   flags:<name>      list of JSON { type, detail, ts }, newest first (last 50)
//   flagged           set of names with flags nobody has dismissed yet
//   rate:<name>:<min> requests in one minute (bursts)

const crypto = require("crypto");
const store = require("./store");
const { isAdminAccount } = require("./session");

const DEFAULTS = { ultraUsd: Number(process.env.ULTRA_DAILY_USD) || 2, images: 25, videos: 2, searches: 150, voiceChars: 30000 };
const LIMIT_KEYS = Object.keys(DEFAULTS);
const BURST_FLAG = 20; // requests a minute that raise a flag
const BURST_STOP = 40; // ... and that are refused
const REPEAT_FLAG = 5; // the same message this many times in a row
const FLAG_LABELS = {
  burst: "Many requests in a minute",
  repeat: "The same message over and over",
  limits: "Hit a daily limit",
  "blocked-prompt": "Asked for a blocked image",
  "api-burst": "API key used very fast",
};

const lower = (u) => String(u || "").toLowerCase();
const key = (u) => `policy:${lower(u)}`;

async function getPolicy(user) {
  if (!store.STORE_ON || !user) return { blocked: false, limits: {} };
  return store.parse(await store.redis("GET", key(user)).catch(() => null)) || { blocked: false, limits: {} };
}

// Today's limits for a person: their overrides on top of the defaults. Admins have no image, video, voice or search limit.
async function limitsFor(user, policy) {
  const p = policy || (await getPolicy(user));
  const out = { ...DEFAULTS };
  for (const k of LIMIT_KEYS) if (Number.isFinite(p.limits?.[k]) && p.limits[k] >= 0) out[k] = p.limits[k];
  if (isAdminAccount(user)) {
    out.images = null;
    out.videos = null;
    out.voiceChars = null;
    out.searches = null; // the site's own search key (2026-10-23: /crew and /team runs used the 150 by midday)
  }
  return out;
}

async function setPolicy(user, { blocked, reason, limits }, by) {
  const p = await getPolicy(user);
  if (typeof blocked === "boolean") p.blocked = blocked;
  if (typeof reason === "string") p.reason = reason.slice(0, 200);
  if (limits && typeof limits === "object") {
    p.limits = {};
    for (const k of LIMIT_KEYS) {
      const v = limits[k];
      if (v === null || v === "" || v === undefined) continue; // back to the default
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) p.limits[k] = k === "ultraUsd" ? Math.round(n * 100) / 100 : Math.round(n);
    }
  }
  p.by = by;
  p.ts = new Date().toISOString();
  await store.redis("SET", key(user), JSON.stringify(p));
  return p;
}

const isBlocked = async (user) => !!user && store.STORE_ON && (await getPolicy(user)).blocked === true;

// ---------- Flags ----------
// Each kind of flag is raised at most once in `quietSecs`, so a burst doesn't fill the list.
async function flag(user, type, detail = "", quietSecs = 600) {
  if (!store.STORE_ON || !user || isAdminAccount(user)) return;
  try {
    const fresh = await store.redis("SET", `flagonce:${lower(user)}:${type}`, "1", "EX", quietSecs, "NX");
    if (!fresh) return;
    await store.pipeline([
      ["LPUSH", `flags:${lower(user)}`, JSON.stringify({ type, detail: String(detail).slice(0, 300), ts: new Date().toISOString() })],
      ["LTRIM", `flags:${lower(user)}`, 0, 49],
      ["SADD", "flagged", lower(user)],
    ]);
  } catch {}
}
async function listFlags(user) {
  return ((await store.redis("LRANGE", `flags:${lower(user)}`, 0, 49).catch(() => [])) || []).map(store.parse).filter(Boolean)
    .map((f) => ({ ...f, label: FLAG_LABELS[f.type] || f.type }));
}
const flaggedUsers = async () => (store.STORE_ON ? (await store.redis("SMEMBERS", "flagged").catch(() => [])) || [] : []);
async function dismissFlags(user) {
  await store.pipeline([["DEL", `flags:${lower(user)}`], ["SREM", "flagged", lower(user)]]);
}

// Called for each chat message (and API call): counts the minute's requests and notices the same message sent
// over and over. Returns an error string when the request should be refused (a burst far past normal use).
async function watch(user, { text = "", api = false } = {}) {
  if (!store.STORE_ON || !user || isAdminAccount(user)) return null;
  try {
    const minute = Math.floor(Date.now() / 60000);
    const h = crypto.createHash("sha1").update(String(text).trim().toLowerCase()).digest("hex").slice(0, 16);
    const [n, last] = await store.pipeline([
      ["INCR", `rate:${lower(user)}:${minute}`],
      ["GET", `lastq:${lower(user)}`],
    ]);
    store.redis("EXPIRE", `rate:${lower(user)}:${minute}`, 120).catch(() => {});
    if (n > BURST_FLAG) await flag(user, api ? "api-burst" : "burst", `${n} requests in one minute`);
    let repeats = 1;
    if (text && last) {
      const [lh, lc] = String(last).split(":");
      if (lh === h) repeats = Number(lc) + 1;
    }
    if (text) await store.redis("SET", `lastq:${lower(user)}`, `${h}:${repeats}`, "EX", 3600);
    if (repeats >= REPEAT_FLAG) await flag(user, "repeat", `Sent ${repeats} times: “${String(text).slice(0, 120)}”`);
    if (n > BURST_STOP) return "Slow down a little: that's a lot of requests in one minute. Try again in a moment.";
  } catch {}
  return null;
}

module.exports = { DEFAULTS, LIMIT_KEYS, FLAG_LABELS, getPolicy, setPolicy, limitsFor, isBlocked, flag, listFlags, flaggedUsers, dismissFlags, watch };
