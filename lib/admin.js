// Admin login (signed, HttpOnly session cookie) and the activity feed.
// Credentials come from ADMIN_USERNAME / ADMIN_PASSWORD environment variables.

const crypto = require("crypto");
const { sendJson, readBody, safeEqual, LMSTUDIO_URL, BRIDGE_TOKEN, upstreamHeaders } = require("./handlers");
const { currentUser, isAdminAccount } = require("./session");
const store = require("./store");

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
// Derived from the password by default, so changing the password signs everyone out.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash("sha256").update(`session:${ADMIN_PASSWORD}:${BRIDGE_TOKEN}`).digest("hex");
const SESSION_HOURS = 12;
const COOKIE = "admin_session";

const b64url = (s) => Buffer.from(s).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");

function cookieHeader(req, value, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

// Signed in with an admin account (ADMIN_ACCOUNTS), or with the separate admin login.
function currentAdmin(req) {
  const user = currentUser(req);
  if (isAdminAccount(user)) return { u: user, via: "account" };
  const match = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [data, sig] = match[1].split(".");
  if (!data || !sig || !safeEqual(sig, sign(data))) return null;
  try {
    const session = JSON.parse(Buffer.from(data, "base64url").toString());
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

async function handleLogin(req, res) {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    return sendJson(res, 503, { error: "Admin login isn't configured on the server" });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }
  const userOk = safeEqual(String(body.username || "").trim().toLowerCase(), ADMIN_USERNAME.toLowerCase());
  const passOk = safeEqual(String(body.password || ""), ADMIN_PASSWORD);
  if (!userOk || !passOk) {
    await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
    return sendJson(res, 401, { error: "Wrong username or password" });
  }
  const data = b64url(JSON.stringify({ u: ADMIN_USERNAME, exp: Date.now() + SESSION_HOURS * 3600e3 }));
  sendJson(res, 200, { ok: true, username: ADMIN_USERNAME }, {
    "Set-Cookie": cookieHeader(req, `${data}.${sign(data)}`, SESSION_HOURS * 3600),
  });
}

function handleLogout(req, res) {
  sendJson(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "", 0) });
}

async function handleActivity(req, res) {
  const admin = currentAdmin(req);
  if (!admin) return sendJson(res, 401, { error: "Not signed in" });
  if (store.STORE_ON) {
    try {
      const [events, users] = await Promise.all([store.listEvents(), store.listUsers()]);
      return sendJson(res, 200, { username: admin.u, via: admin.via, events, users }, { "Cache-Control": "no-store" });
    } catch (err) {
      return sendJson(res, 502, { username: admin.u, error: `Couldn't load activity from Upstash (${err.message}).` });
    }
  }
  if (!BRIDGE_TOKEN) {
    return sendJson(res, 200, { username: admin.u, events: [], note: "Activity logging needs the bridge (BRIDGE_TOKEN)." });
  }
  try {
    const r = await fetch(`${LMSTUDIO_URL}/activity`, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`bridge returned ${r.status}`);
    const { events } = await r.json();
    // Account list (usernames, sign-up dates, number of saved chats) for the dashboard.
    const users = await fetch(`${LMSTUDIO_URL}/users`, { headers: upstreamHeaders, signal: AbortSignal.timeout(10000) })
      .then((u) => (u.ok ? u.json() : { users: [] }))
      .then((u) => u.users)
      .catch(() => []);
    sendJson(res, 200, { username: admin.u, via: admin.via, events, users }, { "Cache-Control": "no-store" });
  } catch (err) {
    sendJson(res, 502, {
      username: admin.u,
      error: `Can't reach your PC (${err.message}). Activity is stored there, so the bridge and tunnel must be running.`,
    });
  }
}

module.exports = { handleLogin, handleLogout, handleActivity };
