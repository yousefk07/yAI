// Calendar and email helper (2026-10-20): people connect their Google account; with "Google" on in a chat, yAI reads
// their upcoming calendar and recent inbox and can suggest Gmail drafts and calendar events. Nothing is sent or added
// until the person presses the button on the card. Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a Google Cloud
// OAuth client whose redirect URI is https://<site>/api/hub?op=google-callback).
//
//   GET    ?op=google            { configured, connected, email }
//   GET    ?op=google-connect    redirects to Google's consent screen
//   GET    ?op=google-callback   Google sends people back here
//   DELETE ?op=google            disconnect (revokes the token)
//   POST   ?op=google-draft      { to, subject, body, replyTo? }      -> { id, url }   saves a Gmail draft
//   POST   ?op=google-event      { title, start, end, location?, description?, allDay? } -> { id, url }
//
//   google:<name>   JSON { email, refresh (encrypted), scope, connectedAt }

const crypto = require("crypto");
const store = require("./store");
const { sendJson } = require("./handlers");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const CONFIGURED = !!(CLIENT_ID && CLIENT_SECRET);
const SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  // Drive and Docs (2026-10-21, connections): read files, and save answers as new Google Docs
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];
const SECRET = crypto.createHash("sha256").update(`${process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "yai"}:google`).digest();
const lower = (u) => String(u).toLowerCase();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", SECRET, iv);
  const out = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), out].map((b) => b.toString("base64url")).join(".");
}
function decrypt(blob) {
  const [iv, tag, data] = String(blob).split(".").map((s) => Buffer.from(s, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", SECRET, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}
const sign = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
const origin = (req) => `${req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http")}://${req.headers["x-forwarded-host"] || req.headers.host}`;
const redirectUri = (req) => `${origin(req)}/api/hub?op=google-callback`;
const redirect = (res, to) => { res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); };

const getLink = async (user) => store.parse(await store.redis("GET", `google:${lower(user)}`).catch(() => null));

// A fresh access token for the person (kept for its hour in Redis).
async function accessToken(user) {
  const cached = await store.redis("GET", `googletoken:${lower(user)}`).catch(() => null);
  if (cached) return decrypt(cached);
  const link = await getLink(user);
  if (!link) throw Object.assign(new Error("Google isn't connected"), { status: 400 });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: decrypt(link.refresh), grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(10000),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) {
    if (t.error === "invalid_grant") await store.redis("DEL", `google:${lower(user)}`).catch(() => {});
    throw new Error(t.error === "invalid_grant" ? "Google access was removed; connect it again" : "Google didn't give access");
  }
  await store.redis("SET", `googletoken:${lower(user)}`, encrypt(t.access_token), "EX", Math.max(60, (t.expires_in || 3600) - 120));
  return t.access_token;
}

async function g(user, url, opts = {}) {
  const token = await accessToken(user);
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.body && { "Content-Type": "application/json" }), ...opts.headers }, signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `Google returned ${r.status}`);
  return data;
}

// ---------- What the model sees ----------
const STOP = new Set("a an the and or but to of in on at for from with about my me i you your our we is are was were be been do does did can could should would will what when where who which how why any some this that these those it its email emails mail inbox gmail calendar schedule event events meeting meetings week today tomorrow yesterday next last reply draft write send show find tell check list".split(" "));
const header = (m, name) => (m.payload?.headers || []).find((h) => h.name.toLowerCase() === name)?.value || "";
function plainBody(part) {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts || []) {
    const t = plainBody(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  return "";
}

async function contextBlock(user, question) {
  if (!CONFIGURED) return "\n\n# Google\nThe user turned on Google, but it isn't set up on this site. Tell them in one sentence.";
  const link = await getLink(user);
  if (!link) return "\n\n# Google\nThe user turned on Google but hasn't connected their account. Tell them to press Connect Google in the account menu.";
  const now = new Date();
  const tz = (await g(user, "https://www.googleapis.com/calendar/v3/users/me/settings/timezone").catch(() => ({}))).value || "UTC";
  const words = String(question).toLowerCase().match(/[\p{L}\p{N}@.'-]{3,}/gu)?.filter((w) => !STOP.has(w)).slice(0, 5) || [];
  const [cal, inbox, found] = await Promise.all([
    g(user, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({
      timeMin: new Date(now - 2 * 864e5).toISOString(), timeMax: new Date(+now + 21 * 864e5).toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "50", timeZone: tz })}`).catch((e) => ({ error: e.message })),
    g(user, "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=in%3Ainbox").catch((e) => ({ error: e.message })),
    words.length ? g(user, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(words.join(" OR "))}`).catch(() => ({})) : {},
  ]);
  const ids = [...new Set([...(found.messages || []).map((m) => m.id), ...(inbox.messages || []).map((m) => m.id)])].slice(0, 18);
  const full = new Set((found.messages || []).slice(0, 3).map((m) => m.id));
  const msgs = await Promise.all(ids.map((id) =>
    g(user, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${full.has(id) ? "format=full" : "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date"}`).catch(() => null)));

  const when = (e) => (e.start?.dateTime ? new Date(e.start.dateTime).toLocaleString("en-CA", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : `${e.start?.date} (all day)`);
  let out = `\n\n# The user's Google account (${link.email})\nNow: ${now.toLocaleString("en-CA", { timeZone: tz, dateStyle: "full", timeStyle: "short" })} (${tz}).`;
  out += "\n\n## Calendar, the last 2 days and the next 3 weeks\n";
  out += cal.error ? `(couldn't read the calendar: ${cal.error})` : (cal.items || []).length
    ? cal.items.map((e) => `- ${when(e)}: ${e.summary || "(no title)"}${e.location ? ` @ ${e.location}` : ""}`).join("\n") : "(nothing scheduled)";
  out += "\n\n## Email (most recent first; [id] for replies)\n";
  out += inbox.error ? `(couldn't read email: ${inbox.error})` : msgs.filter(Boolean).map((m) => {
    let s = `- [${m.id}] ${header(m, "date")} · from ${header(m, "from")} · “${header(m, "subject")}” · ${m.snippet || ""}`;
    if (full.has(m.id)) s += `\n  Full text: ${plainBody(m.payload).replace(/\s+/g, " ").trim().slice(0, 2500)}`;
    return s;
  }).join("\n") || "(the inbox is empty)";
  out +=
    "\n\n## What you can do\nAnswer from this. You can't send email or change the calendar yourself; instead suggest it, and " +
    "the user saves it with a button:\n" +
    '- An email draft: <gmail-draft to="name@example.com" subject="..." reply-to="[id of the email it answers, if any]">the email body, plain text</gmail-draft>\n' +
    `- A calendar event: <calendar-event title="..." start="2026-10-21T15:00" end="2026-10-21T16:00" location="...">notes</calendar-event> (times in ${tz}; for all day use start="2026-10-21" end="2026-10-22")\n` +
    "Only add these when the user asks for an email or an event. Never say an email was sent or an event was added.";
  return out;
}

// ---------- Ops ----------
const ops = {
  "GET google": async ({ res, user, noStore }) => {
    const link = CONFIGURED ? await getLink(user) : null;
    return sendJson(res, 200, { configured: CONFIGURED, connected: !!link, email: link?.email || null }, noStore);
  },
  "GET google-connect": async ({ req, res, user }) => {
    if (!CONFIGURED) return sendJson(res, 503, { error: "Google isn't set up on this site yet." });
    const state = `${Buffer.from(JSON.stringify({ u: user, t: Date.now() })).toString("base64url")}`;
    const q = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: redirectUri(req), response_type: "code", scope: SCOPES.join(" "),
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: `${state}.${sign(state)}`,
    });
    return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${q}`);
  },
  "GET google-callback": async ({ req, res, user, url }) => {
    const [state, sig] = String(url.searchParams.get("state") || "").split(".");
    let s = null;
    try { s = sig === sign(state) ? JSON.parse(Buffer.from(state, "base64url").toString()) : null; } catch {}
    if (!s || lower(s.u) !== lower(user) || Date.now() - s.t > 15 * 60000) return redirect(res, "/?google=failed");
    if (url.searchParams.get("error")) return redirect(res, "/?google=cancelled");
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: String(url.searchParams.get("code") || ""), client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirectUri(req), grant_type: "authorization_code" }),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.refresh_token) return redirect(res, "/?google=failed");
    let email = "";
    try { email = JSON.parse(Buffer.from(String(t.id_token).split(".")[1], "base64url").toString()).email || ""; } catch {}
    await store.pipeline([
      ["SET", `google:${lower(user)}`, JSON.stringify({ email, refresh: encrypt(t.refresh_token), scope: t.scope, connectedAt: new Date().toISOString() })],
      ["SET", `googletoken:${lower(user)}`, encrypt(t.access_token), "EX", Math.max(60, (t.expires_in || 3600) - 120)],
    ]);
    return redirect(res, "/?google=connected");
  },
  "DELETE google": async ({ res, user }) => {
    const link = await getLink(user);
    if (link) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(link.refresh))}`, { method: "POST" }).catch(() => {});
    await store.pipeline([["DEL", `google:${lower(user)}`], ["DEL", `googletoken:${lower(user)}`]]);
    return sendJson(res, 200, { ok: true });
  },
  "POST google-draft": async ({ res, user, body }) => {
    const b = await body();
    const to = String(b.to || "").replace(/[\r\n]/g, "").slice(0, 500);
    const subject = String(b.subject || "").replace(/[\r\n]/g, " ").slice(0, 300);
    const text = String(b.body || "").slice(0, 50000);
    let threadId, inReply = "";
    if (/^[A-Za-z0-9]{8,40}$/.test(b.replyTo || "")) {
      const orig = await g(user, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${b.replyTo}?format=metadata&metadataHeaders=Message-ID`).catch(() => null);
      if (orig) { threadId = orig.threadId; inReply = header(orig, "message-id"); }
    }
    const mime = [`To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8",
      ...(inReply ? [`In-Reply-To: ${inReply}`, `References: ${inReply}`] : []), "", text].join("\r\n");
    const d = await g(user, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { method: "POST", body: JSON.stringify({ message: { raw: Buffer.from(mime).toString("base64url"), ...(threadId && { threadId }) } }) });
    return sendJson(res, 200, { id: d.id, url: "https://mail.google.com/mail/u/0/#drafts" });
  },
  "POST google-event": async ({ res, user, body }) => {
    const b = await body();
    const tz = (await g(user, "https://www.googleapis.com/calendar/v3/users/me/settings/timezone").catch(() => ({}))).value || "UTC";
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(b.start || "");
    const time = (v) => (allDay ? { date: String(v).slice(0, 10) } : { dateTime: String(v).length === 16 ? `${v}:00` : String(v), timeZone: tz });
    if (!b.start || !b.title) return sendJson(res, 400, { error: "The event needs a title and a start" });
    const end = b.end || (allDay ? b.start : new Date(new Date(b.start).getTime() + 3600000).toISOString().slice(0, 16));
    const e = await g(user, "https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      body: JSON.stringify({ summary: String(b.title).slice(0, 300), location: String(b.location || "").slice(0, 300) || undefined, description: String(b.description || "").slice(0, 5000) || undefined, start: time(b.start), end: time(end) }),
    });
    return sendJson(res, 200, { id: e.id, url: e.htmlLink });
  },
};

module.exports = { ops, contextBlock, CONFIGURED, getLink, accessToken };
