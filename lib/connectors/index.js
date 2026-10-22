// Connections (2026-10-21): outside services yAI can use, on the website and in yAI Code.
//
//   no account:   weather, maps, arXiv, Semantic Scholar, YouTube           (always on)
//   a site key:   Wolfram Alpha (WOLFRAM_APP_ID), UW courses (UW_API_KEY)  (on when the key is set)
//   your account: GitHub (OAuth), UWaterloo LEARN (its calendar feed link), webhooks (saved links)
//
// Each service lists tools ("weather.forecast" with its params). Reading tools run when the model asks; tools that
// change something (write: true) only run after the person says yes.
//
//   GET    ?op=connections                    every service: { id, label, desc, ready, connected, who, needs, tools }
//   GET    ?op=github-connect                 GitHub's consent screen        GET ?op=github-callback  back from it
//   DELETE ?op=connections&service=<id>       disconnect (LEARN and webhooks: forget the saved links)
//   PUT    ?op=connections-settings           { learnIcs } and/or { webhooks: [{ id?, name, url }] }
//   POST   ?op=webhook-test                   { name }
//   POST   ?op=tool                           { tool, args, confirm? } -> { text, sources?, link? }
//
//   conncfg:<user>   encrypted JSON { learnIcs, webhooks: [{ id, name, url }] }

const crypto = require("crypto");
const store = require("../store");
const { sendJson } = require("../handlers");
const oauth = require("./oauth");
const { encrypt, decrypt, ToolError, publicUrl, fetchText, clip } = require("./util");
const open = require("./open");
const acc = require("./accounts");

// Watchers (lib/watchers.js): the chat can offer to set one up; it's made when the person presses Do it.
const watchService = {
  id: "watch", label: "Watchers", desc: "Tell me when a price drops or a page changes", kind: "open",
  tools: [{
    name: "watch.add", write: true, params: { url: "the page", kind: "price or change", below: "for a price: tell me when it's at or under this number (optional)", every: "hours between checks: 1, 6 or 24" },
    desc: "watch a page: a notification when its price drops (or goes under a number), or when the page changes",
    async run(a, ctx) {
      const w = await require("../watchers").add(ctx.user, a);
      return { text: `Watching ${w.name || w.url} every ${w.every} h${w.last?.price ? ` (now ${w.last.price})` : ""}. Manage it on the Scheduled page.`, link: "/scheduled#watchers" };
    },
  }],
};
const SERVICES = [acc.github, acc.learn, acc.uw, acc.youtube, watchService, open.weather, open.maps, open.wolfram, open.arxiv, open.scholar, acc.webhooks];
const TOOLS = new Map(SERVICES.flatMap((s) => s.tools.map((t) => [t.name, { ...t, service: s }])));
const DAILY_TOOL_CALLS = 400;
const lower = (u) => String(u).toLowerCase();

// ---------- saved settings ----------
async function getSettings(user) {
  const raw = await store.redis("GET", `conncfg:${lower(user)}`).catch(() => null);
  if (!raw) return { webhooks: [] };
  try { return { webhooks: [], ...JSON.parse(decrypt(raw)) }; } catch { return { webhooks: [] }; }
}
const saveSettings = (user, s) => store.redis("SET", `conncfg:${lower(user)}`, encrypt(JSON.stringify(s)));

// ---------- who has what ----------
async function status(svc, user, settings) {
  if (svc.kind === "open") return { ready: true, connected: true };
  if (svc.kind === "key") { const ok = svc.env.every((e) => process.env[e]); return { ready: ok, connected: ok, needs: ok ? "" : `Not set up on this site yet (${svc.env.join(", ")}).` }; }
  if (svc.kind === "oauth") {
    if (!oauth.configured(svc.oauth)) return { ready: false, connected: false, needs: `Not set up on this site yet (${svc.oauth.idEnv}, ${svc.oauth.secretEnv}).` };
    const link = await oauth.getLink(svc.oauth, user);
    return { ready: true, connected: !!link, who: link?.who || "" };
  }
  if (svc.id === "learn") return { ready: true, connected: !!settings.learnIcs, needs: settings.learnIcs ? "" : "Paste your LEARN calendar link" };
  if (svc.id === "webhooks") return { ready: true, connected: settings.webhooks.length > 0, who: settings.webhooks.map((h) => h.name).join(", ") };
  return { ready: false, connected: false };
}
async function listFor(user) {
  const settings = await getSettings(user);
  return Promise.all(SERVICES.map(async (s) => ({
    id: s.id, label: s.label, desc: s.desc, kind: s.kind, ...(await status(s, user, settings)),
    tools: s.tools.map((t) => ({ name: t.name, desc: t.desc, params: t.params, write: !!t.write })),
  })));
}
// The tools this person can use right now.
async function available(user) {
  const list = await listFor(user);
  return list.filter((s) => s.connected).flatMap((s) => s.tools.map((t) => ({ ...t, service: s.id, label: s.label })));
}

// ---------- running a tool ----------
async function runTool(user, name, args = {}, { confirm = false } = {}) {
  const t = TOOLS.get(String(name));
  if (!t) throw new ToolError(`There's no tool called ${name}.`);
  if (t.write && !confirm) throw new ToolError(`${name} changes something, so it needs the user's OK first.`);
  const settings = await getSettings(user);
  const st = await status(t.service, user, settings);
  if (!st.connected) throw new ToolError(`${t.service.label}: ${st.needs || "not connected"}.`);
  if (store.STORE_ON && (await store.countToday(`tool:u:${lower(user)}`).catch(() => 0)) > DAILY_TOOL_CALLS) throw new ToolError(`You've used today's ${DAILY_TOOL_CALLS} tool calls.`);
  const ctx = {
    user, settings,
    token: () => oauth.accessToken(t.service.oauth, user),
  };
  const out = await t.run(args && typeof args === "object" ? args : {}, ctx);
  return { text: clip(out.text, 40000), sources: out.sources || [], link: out.link || null, tool: t.name, label: t.service.label };
}

// ---------- what the models see ----------
const sig = (t) => `${t.name} ${JSON.stringify(Object.fromEntries(Object.entries(t.params || {}).map(([k, v]) => [k, v])))}`;
// The lines the website's quick check reads: the reading tools it may call before answering.
function routerLines(tools) {
  return tools.filter((t) => !t.write).map((t) => `- ${sig(t)}: ${t.desc}`).join("\n");
}
// The chat's own instructions for the tools that change things: it proposes, the person presses the button.
function actionsBlock(tools) {
  const w = tools.filter((t) => t.write);
  if (!w.length) return "";
  return "\n\n# Actions in the user's connected services\nYou can't do these yourself. When the user asks for one, write a block like " +
    `<yai-action tool="github.create_issue">{"repo":"owner/name","title":"…","body":"…"}</yai-action> (the JSON args) and say what it will do; ` +
    "the user presses its button to run it. Never say it's done before then. Available:\n" + w.map((t) => `- ${sig(t)}: ${t.desc}`).join("\n");
}

// A LEARN link is only saved once it's shown to be the calendar's feed: the calendar page itself (…/calendar/6606)
// needs a LEARN sign-in, so it would only ever return the login page.
async function learnFeed(raw) {
  const url = await publicUrl(raw, { hosts: ["uwaterloo.ca"] });
  if (!/feed\.ics|\.ics\b|calendar\/feed/i.test(url)) {
    throw new ToolError("That's LEARN's calendar page, which needs you signed in. On that page press Subscribe, choose All Courses, and paste the link it gives you (it ends in feed.ics?token=…).");
  }
  const text = await fetchText(url, { timeout: 15000 }).catch(() => "");
  if (!/BEGIN:VCALENDAR/.test(text)) throw new ToolError("LEARN didn't send a calendar from that link. Copy the Subscribe link again (it may have been reset).");
  return url;
}

// ---------- ops ----------
const redirect = (res, to) => { res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); };
const ops = {
  // the setting names (WOLFRAM_APP_ID…) only for admins, who can add them
  "GET connections": async ({ res, user, admin, noStore }) => sendJson(res, 200, { services: (await listFor(user)).map((s) => (admin ? s : { ...s, needs: String(s.needs || "").replace(/ \([A-Z_, ]+\)/, "") })) }, noStore),
  "DELETE connections": async ({ res, user, url }) => {
    const id = url.searchParams.get("service");
    const svc = SERVICES.find((s) => s.id === id);
    if (!svc) return sendJson(res, 400, { error: "Unknown service" });
    if (svc.kind === "oauth") await oauth.disconnect(svc.oauth, user);
    else if (svc.id === "learn" || svc.id === "webhooks") {
      const s = await getSettings(user);
      if (svc.id === "learn") delete s.learnIcs; else s.webhooks = [];
      await saveSettings(user, s);
    } else return sendJson(res, 400, { error: `${svc.label} can't be disconnected here.` });
    return sendJson(res, 200, { ok: true });
  },
  "PUT connections-settings": async ({ res, user, body }) => {
    const b = await body();
    const s = await getSettings(user);
    try {
      if ("learnIcs" in b) s.learnIcs = b.learnIcs ? await learnFeed(b.learnIcs) : undefined;
      if (Array.isArray(b.webhooks)) {
        const list = [];
        for (const h of b.webhooks.slice(0, 20)) {
          const name = clip(String(h.name || "").trim(), 40);
          if (!name) continue;
          const old = s.webhooks.find((x) => x.id === h.id);
          list.push({ id: old?.id || crypto.randomUUID().slice(0, 8), name, url: h.url ? await publicUrl(h.url) : old?.url });
        }
        s.webhooks = list.filter((h) => h.url);
      }
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    await saveSettings(user, s);
    return sendJson(res, 200, { ok: true, learn: !!s.learnIcs, webhooks: s.webhooks.map((h) => ({ id: h.id, name: h.name, host: new URL(h.url).hostname })) });
  },
  "GET connections-settings": async ({ res, user, noStore }) => {
    const s = await getSettings(user);
    return sendJson(res, 200, { learn: !!s.learnIcs, webhooks: s.webhooks.map((h) => ({ id: h.id, name: h.name, host: new URL(h.url).hostname })) }, noStore);
  },
  "POST webhook-test": async ({ res, user, body }) => {
    const b = await body();
    const h = (await getSettings(user)).webhooks.find((x) => x.name === b.name || x.id === b.id);
    if (!h) return sendJson(res, 404, { error: "No webhook by that name" });
    try { await acc.sendWebhook(h, "Test from yAI: this webhook works.", user); } catch (err) { return sendJson(res, 502, { error: err.message }); }
    return sendJson(res, 200, { ok: true });
  },
  "POST tool": async ({ res, user, body }) => {
    const b = await body();
    try {
      const out = await runTool(user, b.tool, b.args, { confirm: b.confirm === true });
      if (store.STORE_ON) await store.trackUsage(user, { tools: 1 }).catch(() => {});
      return sendJson(res, 200, out);
    } catch (err) {
      return sendJson(res, err instanceof ToolError ? 400 : 502, { error: err.message });
    }
  },
};
for (const svc of SERVICES.filter((s) => s.kind === "oauth")) {
  ops[`GET ${svc.id}-connect`] = async ({ req, res, user }) => {
    if (!oauth.configured(svc.oauth)) return sendJson(res, 503, { error: `${svc.label} isn't set up on this site yet.` });
    return redirect(res, oauth.connectUrl(req, svc.oauth, user));
  };
  ops[`GET ${svc.id}-callback`] = async ({ req, res, user, url }) => redirect(res, await oauth.callback(req, svc.oauth, user, url));
}

module.exports = { ops, SERVICES, TOOLS, listFor, available, runTool, routerLines, actionsBlock, getSettings, sendWebhook: acc.sendWebhook };
