// Shared yAI Code sessions (/share in the terminal). POST /api/share stores one for a signed-in user and returns
// an unlisted link; GET /api/share?id= returns it to anyone with the link, for public/share.html to render.

const crypto = require("crypto");
const { currentUser } = require("./session");
const store = require("./store");
const { sendJson, readBody } = require("./handlers");

const MAX_BYTES = 900_000; // the CLI trims sessions to ~800 KB
const MAX_MESSAGES = 2000;
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

async function handleShare(req, res) {
  if (!store.STORE_ON) return sendJson(res, 503, { error: "Sharing needs the site's storage, which isn't set up." });

  if (req.method === "GET") {
    const id = new URL(req.url, "http://x").searchParams.get("id") || "";
    if (!/^[a-f0-9]{12}$/.test(id)) return sendJson(res, 400, { error: "That isn't a valid link." });
    const session = await store.getShare(id).catch(() => null);
    if (!session) return sendJson(res, 404, { error: "This shared session doesn't exist or has expired." });
    return sendJson(res, 200, session, { "Cache-Control": "public, max-age=300" });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "Sign in to share", needsLogin: true });
  let body;
  try {
    const raw = await readBody(req);
    if (raw.length > MAX_BYTES) return sendJson(res, 413, { error: "This session is too big to share." });
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .slice(0, MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: clip(m.content, 30000) }));
  if (!messages.length) return sendJson(res, 400, { error: "Nothing to share." });

  const id = crypto.randomBytes(6).toString("hex");
  const session = {
    id,
    user,
    title: clip(body.title, 200) || "yAI Code session",
    project: clip(body.project, 100),
    model: clip(body.model, 80),
    createdAt: new Date().toISOString(),
    messages,
  };
  try {
    await store.putShare(id, session);
  } catch (err) {
    return sendJson(res, 502, { error: `Couldn't save it: ${err.message}` });
  }
  const host = req.headers["x-forwarded-host"] || req.headers.host || "yousef-llmai.vercel.app";
  const proto = /^(localhost|127\.)/.test(host) ? "http" : "https";
  sendJson(res, 200, { id, url: `${proto}://${host}/share?id=${id}` });
}

module.exports = { handleShare };
