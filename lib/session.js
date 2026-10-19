// Signed, HttpOnly session cookies for user accounts.
// The signing key is derived separately from the admin one, so a user cookie can never
// be replayed as an admin session.

const crypto = require("crypto");

const COOKIE = "yai_session";
// Accounts with admin rights, e.g. ADMIN_ACCOUNTS="yousef,alex" (case-insensitive).
const ADMIN_ACCOUNTS = (process.env.ADMIN_ACCOUNTS || "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean);
const isAdminAccount = (username) => !!username && ADMIN_ACCOUNTS.includes(username.toLowerCase());
const DAYS = 30;
const BASE_SECRET = process.env.SESSION_SECRET || `${process.env.BRIDGE_TOKEN || ""}:${process.env.ADMIN_PASSWORD || ""}`;
const KEY = crypto.createHmac("sha256", BASE_SECRET).update("yai-user-sessions").digest();

const sign = (data) => crypto.createHmac("sha256", KEY).update(data).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieHeader(req, value, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// Returns the signed-in username, or null.
function currentUser(req) {
  const match = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [data, sig] = match[1].split(".");
  if (!data || !sig || !safeEqual(sig, sign(data))) return null;
  try {
    const session = JSON.parse(Buffer.from(data, "base64url").toString());
    return session.kind === "user" && session.exp > Date.now() && typeof session.u === "string" ? session.u : null;
  } catch {
    return null;
  }
}

function signInCookie(req, username) {
  const data = Buffer.from(JSON.stringify({ kind: "user", u: username, exp: Date.now() + DAYS * 864e5 })).toString("base64url");
  return cookieHeader(req, `${data}.${sign(data)}`, DAYS * 86400);
}

const signOutCookie = (req) => cookieHeader(req, "", 0);

module.exports = { currentUser, signInCookie, signOutCookie, safeEqual, isAdminAccount };
