// The home-screen widget (2026-10-21). A phone widget can't sign in, so each person gets a private read-only link
// (a token) that returns a small daily brief: the weather for their place, the next LEARN due dates, the latest
// scheduled task's result, whether a PC is live in Remote, and the latest watcher alert. Scriptable (iPhone) and web
// widget apps (Android) draw it; /widget sets it up.
//
//   GET    ?op=widget-setup             { token?, place }                (signed in)
//   POST   ?op=widget-setup             { place?, renew? } -> { token }  make (or renew) the link, set the place
//   DELETE ?op=widget-setup             turn the link off
//   GET    ?op=widget&t=<token>         the brief, no sign-in (the token is the key)
//
//   widgettok:<user>  JSON { token, place }      widget:<token>  user name

const crypto = require("crypto");
const store = require("./store");
const { sendJson } = require("./handlers");

const lower = (u) => String(u).toLowerCase();
const getSetup = async (user) => store.parse(await store.redis("GET", `widgettok:${lower(user)}`).catch(() => null));

async function brief(user, setup) {
  const c = require("./connectors");
  const out = { user, at: Date.now(), weather: null, deadlines: [], scheduled: null, remote: null, watch: null };
  const tasks = [];
  if (setup.place) tasks.push(c.runTool(user, "weather.forecast", { place: setup.place, days: 3 }).then((r) => {
    const d = r.card?.data;
    if (d) out.weather = { place: d.place, temp: Math.round(d.now.temp), label: d.now.label, code: d.now.code, hi: Math.round(d.days[0]?.max), lo: Math.round(d.days[0]?.min), tomorrow: d.days[1] ? { label: d.days[1].label, hi: Math.round(d.days[1].max), lo: Math.round(d.days[1].min), code: d.days[1].code } : null };
  }).catch(() => {}));
  tasks.push(c.runTool(user, "learn.deadlines", { days: 7 }).then((r) => {
    out.deadlines = String(r.text).split("\n").filter((l) => l.startsWith("- ")).slice(0, 4).map((l) => { const m = /^- ([^:]+:\d\d [ap]\.?m\.?|[^:]+): (.*)$/i.exec(l.slice(2)) || [null, "", l.slice(2)]; return { when: m[1].trim(), what: m[2].split(" · ")[0].trim() }; });
  }).catch(() => {}));
  tasks.push((async () => {
    const flat = (await store.redis("HGETALL", `sched:${lower(user)}`)) || [];
    let last = null;
    for (let i = 0; i < flat.length; i += 2) { const t = store.parse(flat[i + 1]); if (t?.lastRun && (!last || t.lastRun > last.lastRun)) last = t; }
    if (last) {
      const chat = last.lastChatId ? await store.getChat?.(user, last.lastChatId).catch(() => null) : null;
      const text = String(chat?.messages?.find((m) => m.role === "assistant")?.content || "").replace(/[#*_`>\[\]]+/g, "").replace(/\s+/g, " ").trim();
      out.scheduled = { title: last.title, at: Date.parse(last.lastRun), text: text.slice(0, 220), url: last.lastChatId ? `/?chat=${last.lastChatId}` : "/scheduled" };
    }
  })().catch(() => {}));
  tasks.push((async () => {
    const flat = (await store.redis("HGETALL", `remote:${lower(user)}`)) || [];
    for (let i = 0; i < flat.length; i += 2) { const m = store.parse(flat[i + 1]); if (m?.listening && Date.now() - m.seen < 45000) { out.remote = { name: m.name, folder: String(m.folder || "").split(/[\\/]/).pop() }; break; } }
  })().catch(() => {}));
  tasks.push((async () => {
    const flat = (await store.redis("HGETALL", `watch:${lower(user)}`)) || [];
    let ev = null;
    for (let i = 0; i < flat.length; i += 2) { const w = store.parse(flat[i + 1]); const e = w?.events?.[0]; if (e && (!ev || e.t > ev.t)) ev = { ...e, name: w.name || w.url, url: w.url }; }
    out.watch = ev;
  })().catch(() => {}));
  await Promise.all(tasks);
  return out;
}

const ops = {
  "GET widget-setup": async ({ res, user, noStore }) => {
    const s = await getSetup(user);
    return sendJson(res, 200, { token: s?.token || null, place: s?.place || "" }, noStore);
  },
  "POST widget-setup": async ({ res, user, body }) => {
    const b = await body();
    const old = await getSetup(user);
    const token = !old || b.renew ? crypto.randomBytes(18).toString("base64url") : old.token;
    const place = "place" in b ? String(b.place || "").trim().slice(0, 80) : old?.place || "";
    const cmds = [["SET", `widgettok:${lower(user)}`, JSON.stringify({ token, place })], ["SET", `widget:${token}`, lower(user)]];
    if (old && old.token !== token) cmds.push(["DEL", `widget:${old.token}`]);
    await store.pipeline(cmds);
    return sendJson(res, 200, { token, place });
  },
  "DELETE widget-setup": async ({ res, user }) => {
    const old = await getSetup(user);
    await store.pipeline([["DEL", `widgettok:${lower(user)}`], ...(old ? [["DEL", `widget:${old.token}`]] : [])]);
    return sendJson(res, 200, { ok: true });
  },
};

// The widget's own request: no sign-in, the token is the key (handled before the sign-in check in hub.js).
async function publicWidget(req, res, url) {
  const t = String(url.searchParams.get("t") || "");
  if (!/^[\w-]{20,40}$/.test(t)) return sendJson(res, 400, { error: "Missing widget link" });
  const user = await store.redis("GET", `widget:${t}`).catch(() => null);
  if (!user) return sendJson(res, 404, { error: "This widget link was turned off. Make a new one on yAI's Widgets page." });
  const setup = await getSetup(user);
  if (!setup || setup.token !== t) return sendJson(res, 404, { error: "This widget link was replaced." });
  const cached = await store.redis("GET", `widgetcache:${t}`).catch(() => null);
  if (cached) return sendJson(res, 200, JSON.parse(cached), { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  const data = await brief(user, setup);
  await store.redis("SET", `widgetcache:${t}`, JSON.stringify(data), "EX", 300).catch(() => {});
  return sendJson(res, 200, data, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
}

module.exports = { ops, publicWidget };
