// Scheduled tasks (2026-10-21): "every morning at 8, brief me on AI news". At the time, yAI runs the prompt (with a web
// search if asked), saves the answer as a chat, and sends a notification to the person's phone or browser.
// Something has to knock every few minutes: a GitHub Actions workflow calls ?op=tick (.github/workflows/scheduler.yml).
//
//   GET    ?op=schedules                  your tasks
//   PUT    ?op=schedule   { id?, title, prompt, model, web, enabled, schedule: { kind, time, day?, date? }, tz }
//                         kind: daily | weekdays | weekly (day 0-6, Sunday 0) | once (date YYYY-MM-DD); time "HH:MM"
//   DELETE ?op=schedule&id=…
//   POST   ?op=schedule-run&id=…          run it now
//   GET    ?op=tick                       runs the tasks that are due (no sign-in; CRON_SECRET if set)
//
//   sched:<name>   hash  id -> JSON task
//   sched:due      sorted set  "<name>|<id>" scored by its next run (ms)

const crypto = require("crypto");
const store = require("./store");
const policy = require("./policy");
const { sendJson, modelEntry, completeOnce, cloudOn, webContext, searchRouterPrompt } = require("./handlers");
const { notify } = require("./push");

const MAX_TASKS = 25;
const MODELS_OK = ["deepseek-v4.1-flash", "qwen3.8-max", "deepseek-v4-pro", "kimi-k3-ultra"]; // kimi-k3-ultra: older tasks, now yAI Ultra on DeepSeek V4 Pro
const lower = (u) => String(u).toLowerCase();
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

// ---------- time zones without a library ----------
function tzOffset(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(ts).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}
// A wall-clock time in a zone, as a timestamp (DST-safe: the offset is checked again at the result).
function zoned(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}
function localParts(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(ts).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
// The next run after `after` (ms), or null for a one-off that has passed.
function nextRun(s, tz, after = Date.now()) {
  const [h, mi] = String(s.time || "08:00").split(":").map(Number);
  if (s.kind === "once") {
    const [y, m, d] = String(s.date || "").split("-").map(Number);
    const t = y ? zoned(y, m, d, h, mi, tz) : NaN;
    return t > after ? t : null;
  }
  for (let i = 0; i < 9; i++) {
    const day = localParts(after + i * 864e5, tz);
    const t = zoned(day.y, day.m, day.d, h, mi, tz);
    if (t <= after) continue;
    const wd = localParts(t, tz).wd;
    if (s.kind === "weekdays" && (wd === 0 || wd === 6)) continue;
    if (s.kind === "weekly" && wd !== Number(s.day)) continue;
    return t;
  }
  return null;
}
const validTz = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

function clean(b, old) {
  const kind = ["daily", "weekdays", "weekly", "once"].includes(b.schedule?.kind) ? b.schedule.kind : "daily";
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.schedule?.time || "") ? b.schedule.time : "08:00";
  const schedule = { kind, time, ...(kind === "weekly" && { day: Math.max(0, Math.min(6, Number(b.schedule.day) || 0)) }), ...(kind === "once" && { date: /^\d{4}-\d{2}-\d{2}$/.test(b.schedule.date || "") ? b.schedule.date : "" }) };
  const tz = validTz(b.tz) ? b.tz : old?.tz || "UTC";
  const prompt = clip(b.prompt, 4000).trim();
  return {
    id: old?.id || crypto.randomBytes(6).toString("hex"),
    title: clip(b.title, 80).trim() || prompt.slice(0, 50) || "Scheduled task",
    prompt, model: MODELS_OK.includes(b.model) ? b.model : "deepseek-v4.1-flash", web: !!b.web, enabled: b.enabled !== false,
    webhook: /^[\w-]{1,40}$/.test(b.webhook || "") ? b.webhook : "",
    schedule, tz, createdAt: old?.createdAt || new Date().toISOString(), lastRun: old?.lastRun || null, lastStatus: old?.lastStatus || "", lastChatId: old?.lastChatId || null,
  };
}
async function save(user, task) {
  task.nextRun = task.enabled ? nextRun(task.schedule, task.tz) : null;
  const member = `${lower(user)}|${task.id}`;
  await store.pipeline([
    ["HSET", `sched:${lower(user)}`, task.id, JSON.stringify(task)],
    task.nextRun ? ["ZADD", "sched:due", task.nextRun, member] : ["ZREM", "sched:due", member],
  ]);
  return task;
}

// ---------- running one ----------
async function run(user, task) {
  const started = Date.now();
  let answer = "", sources = null, status = "done";
  try {
    if (await policy.isBlocked(user)) throw new Error("Your account is paused");
    const [spent, limits] = await Promise.all([store.getSpendToday(user).catch(() => 0), policy.limitsFor(user)]);
    if (spent >= limits.ultraUsd * 1e6) throw new Error(`Today's $${limits.ultraUsd} allowance is used up`);
    const entry = modelEntry(task.model) && cloudOn(modelEntry(task.model)) ? modelEntry(task.model) : modelEntry("deepseek-v4.1-flash");
    if (!entry || !cloudOn(entry)) throw new Error("No hosted model is available");
    const now = new Date().toLocaleString("en-CA", { timeZone: task.tz, dateStyle: "full", timeStyle: "short" });
    let context = "";
    if (task.web) {
      const web = await webContext(task.prompt, entry.context || 32000);
      context = web.block;
      sources = web.sources;
      await store.trackUsage(user, { searches: 1 }).catch(() => {});
    }
    // Connections (2026-10-21): the person's connected tools, picked by the same quick check as a chat.
    const connectors = require("./connectors");
    const tools = (await connectors.available(user).catch(() => [])).filter((t) => !t.write);
    const router = modelEntry("deepseek-v4.1-flash");
    if (tools.length && router && cloudOn(router)) {
      const verdict = String(await completeOnce(router, router.id, [
        { role: "system", content: searchRouterPrompt(connectors.routerLines(tools), false) },
        { role: "user", content: `Latest message:\n${task.prompt.slice(0, 1500)}` },
      ], 200, AbortSignal.timeout(8000), user).catch(() => ""));
      const calls = [...verdict.matchAll(/^\s*TOOL:\s*([\w.]+)\s*(\{.*\})?\s*$/gim)].slice(0, 3);
      for (const m of calls) {
        let args = {};
        try { args = JSON.parse(m[2] || "{}"); } catch {}
        const r = await connectors.runTool(user, m[1], args).catch((err) => ({ tool: m[1], label: m[1], text: `(failed: ${err.message})`, sources: [] }));
        context += `\n\n# From the user's ${r.label} (${r.tool}), just now\n${r.text}`;
        if (r.sources?.length) sources = [...(sources || []), ...r.sources.map((s, i) => ({ n: (sources?.length || 0) + i + 1, ...s }))];
      }
    }
    answer = await completeOnce(entry, entry.id, [
      { role: "system", content: "Your name is yAI. This is a task the user scheduled to run on its own; they'll read the result later, " +
        `so write the finished result directly (no questions back, no "Sure!"). It is now ${now} (${task.tz}). Use Markdown.` + context },
      { role: "user", content: task.prompt },
    ], 3000, AbortSignal.timeout(80000), user);
  } catch (err) {
    status = "error";
    answer = `This scheduled task couldn't run: ${err.message}.`;
  }
  // The result is a chat, so it shows up in the sidebar and can be continued.
  const chatId = crypto.randomUUID();
  await store.putChat(user, {
    id: chatId, title: `⏰ ${task.title}`,
    messages: [{ role: "user", content: task.prompt }, { role: "assistant", content: answer, ...(sources?.length && { sources }), stats: { ms: Date.now() - started } }],
  }).catch(() => {});
  await notify(user, { title: task.title, body: answer.replace(/```[\s\S]*?(```|$)/g, " ").replace(/<[^>]+>/g, "").replace(/[#*_`>\[\]]+/g, "").replace(/\s+/g, " ").slice(0, 180), url: `/?chat=${chatId}`, tag: `sched-${task.id}` }).catch(() => 0);
  if (task.webhook) {
    try {
      const connectors = require("./connectors");
      const h = (await connectors.getSettings(user)).webhooks.find((x) => x.id === task.webhook);
      if (h) await connectors.sendWebhook(h, `**${task.title}**\n${answer}`, user, { title: task.title, chat: `/?chat=${chatId}` });
    } catch (err) {
      status = status === "error" ? status : "webhook failed";
    }
  }
  Object.assign(task, { lastRun: new Date().toISOString(), lastStatus: status, lastChatId: chatId });
  if (task.schedule.kind === "once") task.enabled = false;
  await save(user, task);
  return task;
}

// Runs what's due, a few at a time, within the function's time limit. A lock keeps two knocks from overlapping.
async function tick(req, res) {
  const secret = process.env.CRON_SECRET;
  const given = new URL(req.url, "http://x").searchParams.get("key") || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (secret && given !== secret) return sendJson(res, 401, { error: "Wrong key" });
  if (!store.STORE_ON) return sendJson(res, 503, { error: "No storage" });
  const lock = await store.redis("SET", "sched:lock", "1", "EX", 110, "NX");
  if (!lock) return sendJson(res, 200, { ran: 0, busy: true });
  const until = Date.now() + 30000; // a batch started by then finishes inside the function's 120 s
  let ran = 0;
  try {
    const due = (await store.redis("ZRANGEBYSCORE", "sched:due", 0, Date.now(), "LIMIT", 0, 20)) || [];
    for (let i = 0; i < due.length && Date.now() < until; i += 3) {
      await Promise.all(due.slice(i, i + 3).map(async (member) => {
        const [user, id] = member.split("|");
        const task = store.parse(await store.redis("HGET", `sched:${user}`, id));
        if (!task || !task.enabled) return store.redis("ZREM", "sched:due", member);
        // Moved to its next time first, so a run that fails halfway isn't retried every 5 minutes.
        const next = task.schedule.kind === "once" ? null : nextRun(task.schedule, task.tz);
        await (next ? store.redis("ZADD", "sched:due", next, member) : store.redis("ZREM", "sched:due", member));
        await run(user, task).catch(() => {});
        ran++;
      }));
    }
    // price and page watchers (lib/watchers.js) in the time that's left
    var watched = await require("./watchers").runDue(Date.now() + Math.max(5000, until + 30000 - Date.now())).catch(() => 0);
  } finally {
    await store.redis("DEL", "sched:lock").catch(() => {});
  }
  return sendJson(res, 200, { ran, watched: watched || 0, at: new Date().toISOString() });
}

const ops = {
  "GET schedules": async ({ res, user, noStore }) => {
    const flat = (await store.redis("HGETALL", `sched:${lower(user)}`)) || [];
    const tasks = [];
    for (let i = 0; i < flat.length; i += 2) { const t = store.parse(flat[i + 1]); if (t) tasks.push(t); }
    return sendJson(res, 200, { tasks: tasks.sort((a, b) => (a.nextRun || 9e15) - (b.nextRun || 9e15)) }, noStore);
  },
  "PUT schedule": async ({ res, user, body }) => {
    const b = await body();
    const old = b.id ? store.parse(await store.redis("HGET", `sched:${lower(user)}`, String(b.id))) : null;
    if (!old && ((await store.redis("HLEN", `sched:${lower(user)}`)) || 0) >= MAX_TASKS) return sendJson(res, 400, { error: `You can have ${MAX_TASKS} scheduled tasks.` });
    const task = clean(b, old);
    if (!task.prompt) return sendJson(res, 400, { error: "Say what yAI should do." });
    if (task.schedule.kind === "once" && !nextRun(task.schedule, task.tz)) return sendJson(res, 400, { error: "That time has already passed." });
    return sendJson(res, 200, { task: await save(user, task) });
  },
  "DELETE schedule": async ({ res, user, url }) => {
    const id = String(url.searchParams.get("id") || "");
    await store.pipeline([["HDEL", `sched:${lower(user)}`, id], ["ZREM", "sched:due", `${lower(user)}|${id}`]]);
    return sendJson(res, 200, { ok: true });
  },
  "POST schedule-run": async ({ res, user, url }) => {
    const task = store.parse(await store.redis("HGET", `sched:${lower(user)}`, String(url.searchParams.get("id") || "")));
    if (!task) return sendJson(res, 404, { error: "Task not found" });
    const enabled = task.enabled;
    const done = await run(user, { ...task, schedule: task.schedule.kind === "once" ? { ...task.schedule, kind: "daily" } : task.schedule });
    if (task.schedule.kind === "once") { done.schedule = task.schedule; done.enabled = enabled; await save(user, done); }
    return sendJson(res, 200, { task: done });
  },
};

module.exports = { ops, tick, nextRun, zoned };
