// Signing in to a service for a person (GitHub): the consent screen, the callback, refreshing the token.
//
//   conn:<service>:<user>   JSON { who, access (encrypted), refresh (encrypted), expiresAt, scope, connectedAt }
//
// A service gives { id, label, authUrl, tokenUrl, scopes, idEnv, secretEnv, basicAuth?, profile(token) -> who }.
// Its redirect URI is https://<site>/api/hub?op=<id>-callback.

const store = require("../store");
const { encrypt, decrypt, sign, fetchJson, ToolError } = require("./util");

const lower = (u) => String(u).toLowerCase();
const key = (svc, user) => `conn:${svc.id}:${lower(user)}`;
const origin = (req) => `${req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http")}://${req.headers["x-forwarded-host"] || req.headers.host}`;
const redirectUri = (req, svc) => `${origin(req)}/api/hub?op=${svc.id}-callback`;

const configured = (svc) => !!(process.env[svc.idEnv] && process.env[svc.secretEnv]);
const getLink = async (svc, user) => store.parse(await store.redis("GET", key(svc, user)).catch(() => null));

function connectUrl(req, svc, user) {
  const state = Buffer.from(JSON.stringify({ u: user, t: Date.now() })).toString("base64url");
  const q = new URLSearchParams({
    client_id: process.env[svc.idEnv], redirect_uri: redirectUri(req, svc), response_type: "code",
    scope: svc.scopes.join(" "), state: `${state}.${sign(state)}`, ...(svc.authParams || {}),
  });
  return `${svc.authUrl}?${q}`;
}

async function tokenRequest(svc, params) {
  const id = process.env[svc.idEnv], secret = process.env[svc.secretEnv];
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (svc.basicAuth) headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  else Object.assign(params, { client_id: id, client_secret: secret });
  return fetchJson(svc.tokenUrl, { method: "POST", headers, body: new URLSearchParams(params) });
}

// The callback: checks the signed state, trades the code for tokens, saves them. Returns where to send the person.
async function callback(req, svc, user, url) {
  const [state, sig] = String(url.searchParams.get("state") || "").split(".");
  let s = null;
  try { s = sig === sign(state) ? JSON.parse(Buffer.from(state, "base64url").toString()) : null; } catch {}
  if (!s || lower(s.u) !== lower(user) || Date.now() - s.t > 15 * 60000) return `/?connected=${svc.id}&result=failed`;
  if (url.searchParams.get("error")) return `/?connected=${svc.id}&result=cancelled`;
  let t;
  try { t = await tokenRequest(svc, { grant_type: "authorization_code", code: String(url.searchParams.get("code") || ""), redirect_uri: redirectUri(req, svc) }); } catch { return `/?connected=${svc.id}&result=failed`; }
  if (!t.access_token) return `/?connected=${svc.id}&result=failed`;
  const who = await svc.profile(t.access_token).catch(() => "");
  await store.redis("SET", key(svc, user), JSON.stringify({
    who, access: encrypt(t.access_token), refresh: t.refresh_token ? encrypt(t.refresh_token) : null,
    expiresAt: t.expires_in ? Date.now() + (t.expires_in - 120) * 1000 : null, scope: t.scope || svc.scopes.join(" "), connectedAt: new Date().toISOString(),
  }));
  return `/?connected=${svc.id}&result=ok`;
}

// A working access token, refreshed when it has expired.
async function accessToken(svc, user) {
  const link = await getLink(svc, user);
  if (!link) throw new ToolError(`${svc.label} isn't connected. Connect it under Connections in the account menu.`);
  if (!link.expiresAt || Date.now() < link.expiresAt) return decrypt(link.access);
  if (!link.refresh) throw new ToolError(`${svc.label} access expired; connect it again under Connections.`);
  let t;
  try { t = await tokenRequest(svc, { grant_type: "refresh_token", refresh_token: decrypt(link.refresh) }); } catch (err) {
    if (/invalid_grant|revoked/i.test(err.message)) await store.redis("DEL", key(svc, user)).catch(() => {});
    throw new ToolError(`${svc.label} access was removed; connect it again under Connections.`);
  }
  Object.assign(link, { access: encrypt(t.access_token), expiresAt: Date.now() + ((t.expires_in || 3600) - 120) * 1000, ...(t.refresh_token && { refresh: encrypt(t.refresh_token) }) });
  await store.redis("SET", key(svc, user), JSON.stringify(link));
  return t.access_token;
}

async function disconnect(svc, user) {
  const link = await getLink(svc, user);
  if (link && svc.revoke) await svc.revoke(decrypt(link.access)).catch(() => {});
  await store.redis("DEL", key(svc, user));
}

module.exports = { configured, getLink, connectUrl, callback, accessToken, disconnect };
