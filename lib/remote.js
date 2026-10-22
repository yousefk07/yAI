// Run on phone (2026-10-20): yAI Code on a PC (`yai remote`, or /remote in a session) waits for tasks sent from the
// website's Remote page (/remote) on a phone, runs them, and streams its output back. Questions it would ask in the
// terminal (may I edit this file?) come to the phone as buttons.
//
// The PC (yAI Code):
//   POST ?op=remote-hello  { machine, name, folder, model }         registers / refreshes the machine
//   GET  ?op=remote-poll&m=…                                          waits up to ~20 s: { tasks: [...], answers: [...], stop: [...] }
//   POST ?op=remote-push   { m, task, events: [...], status? }       output: { t: "out", text } | { t: "ask", id, title, detail, options } | { t: "done" }
//   POST ?op=remote-bye    { m }                                     the PC stopped listening
// The phone (/remote):
//   GET  ?op=remote-machines                                         { machines: [{ id, name, folder, model, online, seen }] }
//   GET  ?op=remote-tasks&m=…                                        recent tasks on one machine
//   POST ?op=remote-task   { m, text, mode }                         queue a task -> { task }
//   GET  ?op=remote-feed&task=…&from=n                               waits up to ~20 s for output: { events, status, next }
//   POST ?op=remote-answer { m, task, ask, choice }                  answer a question
//   POST ?op=remote-stop   { m, task }
//
//   remote:<name>                 hash machine -> JSON { id, name, folder, model, seen, listening }
//   remoteq:<name>:<machine>      list of control messages for the PC (tasks, answers, stops)
//   remotetasks:<name>:<machine>  list of JSON tasks, newest first (last 20)
//   remotetask:<name>:<task>      JSON { id, m, text, mode, status, ts }
//   remotelog:<name>:<task>       list of JSON output events (kept a week)
//   remotesessions:<name>         list of JSON sessions, newest first: one per run of yai remote (2026-10-21)
//
//   GET  ?op=remote-sessions                                         the chats: { sessions: [{ id, m, name, folder, model, startedAt, live, tasks }] }
// Output events: { t: "ev", ev } carries what yAI Code said and did (text, step, step-result, diff, note), so the
// phone draws a chat; { t: "out", text } is older plain text.

const crypto = require("crypto");
const store = require("./store");
const { sendJson } = require("./handlers");

const lower = (u) => String(u).toLowerCase();
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const ID = /^[A-Za-z0-9_-]{6,40}$/;
const ONLINE_MS = 45000;
const WAIT_MS = 20000;
const DAY = 86400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getMachine(user, m) {
  return store.parse(await store.redis("HGET", `remote:${lower(user)}`, m));
}
async function saveMachine(user, mach) {
  await store.redis("HSET", `remote:${lower(user)}`, mach.id, JSON.stringify(mach));
}
async function getTask(user, t) {
  return store.parse(await store.redis("GET", `remotetask:${lower(user)}:${t}`));
}
async function saveTask(user, task) {
  await store.redis("SET", `remotetask:${lower(user)}:${task.id}`, JSON.stringify(task), "EX", 7 * DAY);
}
const push = (user, m, msg) => store.pipeline([["RPUSH", `remoteq:${lower(user)}:${m}`, JSON.stringify(msg)], ["EXPIRE", `remoteq:${lower(user)}:${m}`, DAY]]);

const ops = {
  // ---------- the PC ----------
  "POST remote-hello": async ({ res, user, body }) => {
    const b = await body();
    if (!ID.test(b.machine || "")) return sendJson(res, 400, { error: "Invalid machine id" });
    const old = await getMachine(user, b.machine);
    const session = ID.test(b.session || "") ? b.session : old?.session || "";
    const mach = { id: b.machine, name: clip(b.name, 60) || "PC", folder: clip(b.folder, 300), model: clip(b.model, 80), seen: Date.now(), listening: true, since: old?.since || Date.now(), session };
    await saveMachine(user, mach);
    if (session && session !== old?.session) {
      await store.pipeline([
        ["LPUSH", `remotesessions:${lower(user)}`, JSON.stringify({ id: session, m: mach.id, name: mach.name, folder: mach.folder, model: mach.model, startedAt: Date.now() })],
        ["LTRIM", `remotesessions:${lower(user)}`, 0, 39],
      ]);
    }
    return sendJson(res, 200, { machine: mach });
  },
  "GET remote-poll": async ({ res, user, url, noStore }) => {
    const m = String(url.searchParams.get("m") || "");
    const mach = ID.test(m) && (await getMachine(user, m));
    if (!mach) return sendJson(res, 404, { error: "Run yai remote again to register this PC." });
    const key = `remoteq:${lower(user)}:${m}`;
    const until = Date.now() + WAIT_MS;
    let items = [];
    for (;;) {
      const list = await store.redis("LPOP", key, 50);
      items = (Array.isArray(list) ? list : list ? [list] : []).map(store.parse).filter(Boolean);
      if (items.length || Date.now() > until) break;
      await sleep(1500);
    }
    mach.seen = Date.now();
    mach.listening = true;
    await saveMachine(user, mach);
    return sendJson(res, 200, {
      tasks: items.filter((x) => x.kind === "task"), answers: items.filter((x) => x.kind === "answer"), stop: items.filter((x) => x.kind === "stop"),
    }, noStore);
  },
  "POST remote-push": async ({ res, user, body }) => {
    const b = await body();
    const task = ID.test(b.task || "") && (await getTask(user, b.task));
    if (!task) return sendJson(res, 404, { error: "Task not found" });
    const events = (Array.isArray(b.events) ? b.events : []).slice(0, 300).map((e) => ({
      t: ["out", "ask", "answered", "done", "error", "ev"].includes(e.t) ? e.t : "out", text: clip(e.text, 20000), ...(e.t === "answered" && { id: clip(e.id, 40) }),
      ...(e.t === "ev" && e.ev && typeof e.ev === "object" && JSON.stringify(e.ev).length < 60000 && { ev: e.ev }),
      ...(e.t === "ask" && { id: clip(e.id, 40), title: clip(e.title, 300), detail: clip(e.detail, 4000), options: (e.options || []).slice(0, 4).map((o) => clip(o, 80)) }),
      ts: Date.now(),
    }));
    const key = `remotelog:${lower(user)}:${task.id}`;
    if (events.length) await store.pipeline([["RPUSH", key, ...events.map((e) => JSON.stringify(e))], ["EXPIRE", key, 7 * DAY]]);
    if (b.status && ["running", "done", "stopped", "error"].includes(b.status)) {
      task.status = b.status;
      if (b.status !== "running") task.endedAt = Date.now();
      await saveTask(user, task);
    }
    return sendJson(res, 200, { ok: true });
  },
  "POST remote-bye": async ({ res, user, body }) => {
    const m = String((await body()).machine || "");
    const mach = ID.test(m) && (await getMachine(user, m));
    if (mach) { mach.listening = false; mach.seen = Date.now(); await saveMachine(user, mach); }
    return sendJson(res, 200, { ok: true });
  },

  // ---------- the phone ----------
  "GET remote-machines": async ({ res, user, noStore }) => {
    const flat = (await store.redis("HGETALL", `remote:${lower(user)}`)) || [];
    const machines = [];
    for (let i = 0; i < flat.length; i += 2) {
      const m = store.parse(flat[i + 1]);
      if (m) machines.push({ ...m, online: !!m.listening && Date.now() - m.seen < ONLINE_MS });
    }
    return sendJson(res, 200, { machines: machines.sort((a, b) => b.online - a.online || b.seen - a.seen) }, noStore);
  },
  "DELETE remote-machine": async ({ res, user, url }) => {
    await store.redis("HDEL", `remote:${lower(user)}`, String(url.searchParams.get("m") || ""));
    return sendJson(res, 200, { ok: true });
  },
  // The chats: each run of yai remote, with its tasks; the machine's current one is live while it's listening.
  "GET remote-sessions": async ({ res, user, noStore }) => {
    const [flat, raw] = await store.pipeline([["HGETALL", `remote:${lower(user)}`], ["LRANGE", `remotesessions:${lower(user)}`, 0, 39]]);
    const machines = {};
    for (let i = 0; i < (flat || []).length; i += 2) { const m = store.parse(flat[i + 1]); if (m) machines[m.id] = { ...m, online: !!m.listening && Date.now() - m.seen < ONLINE_MS }; }
    const sessions = (raw || []).map(store.parse).filter(Boolean);
    // each machine's recent tasks, grouped into its sessions (tasks from before sessions existed form an "earlier" chat)
    const ids = Object.keys(machines);
    const lists = ids.length ? await store.pipeline(ids.map((m) => ["LRANGE", `remotetasks:${lower(user)}:${m}`, 0, 19])) : [];
    const all = ids.flatMap((m, i) => (lists[i] || []).map((t) => [m, t]));
    const tasks = all.length ? (await store.pipeline(all.map(([, t]) => ["GET", `remotetask:${lower(user)}:${t}`]))).map(store.parse).filter(Boolean) : [];
    const out = sessions.map((s) => ({ ...s, live: !!machines[s.m]?.online && machines[s.m].session === s.id, tasks: [] }));
    const byId = Object.fromEntries(out.map((s) => [s.id, s]));
    for (const t of tasks) {
      let s = byId[t.session];
      if (!s) {
        const key = `old-${t.m}`;
        s = byId[key] ||= (out.push({ id: key, m: t.m, name: machines[t.m]?.name || "PC", folder: machines[t.m]?.folder || "", model: "", startedAt: t.ts, live: false, earlier: true, tasks: [] }), out[out.length - 1]);
      }
      s.tasks.push({ id: t.id, text: t.text, status: t.status, ts: t.ts, mode: t.mode, m: t.m });
      s.startedAt = Math.min(s.startedAt || t.ts, t.ts);
    }
    for (const s of out) s.tasks.sort((a, b) => a.ts - b.ts);
    const shown = out.filter((s) => s.live || s.tasks.length).sort((a, b) => b.live - a.live || (b.tasks.at(-1)?.ts || b.startedAt) - (a.tasks.at(-1)?.ts || a.startedAt));
    return sendJson(res, 200, { sessions: shown, machines: Object.values(machines) }, noStore);
  },
  "GET remote-tasks": async ({ res, user, url, noStore }) => {
    const m = String(url.searchParams.get("m") || "");
    const ids = (await store.redis("LRANGE", `remotetasks:${lower(user)}:${m}`, 0, 19)) || [];
    const tasks = ids.length ? (await store.pipeline(ids.map((t) => ["GET", `remotetask:${lower(user)}:${t}`]))).map(store.parse).filter(Boolean) : [];
    return sendJson(res, 200, { tasks }, noStore);
  },
  "POST remote-task": async ({ res, user, body }) => {
    const b = await body();
    const mach = ID.test(b.m || "") && (await getMachine(user, b.m));
    if (!mach) return sendJson(res, 404, { error: "That PC isn't connected." });
    const text = clip(b.text, 8000).trim();
    if (!text) return sendJson(res, 400, { error: "Write a task first." });
    const task = { id: crypto.randomBytes(8).toString("hex"), m: mach.id, session: mach.session || "", text, mode: b.mode === "acceptEdits" ? "acceptEdits" : b.mode === "plan" ? "plan" : "default", status: "queued", ts: Date.now() };
    await saveTask(user, task);
    await store.pipeline([["LPUSH", `remotetasks:${lower(user)}:${mach.id}`, task.id], ["LTRIM", `remotetasks:${lower(user)}:${mach.id}`, 0, 19]]);
    await push(user, mach.id, { kind: "task", ...task });
    return sendJson(res, 200, { task, online: !!mach.listening && Date.now() - mach.seen < ONLINE_MS });
  },
  "GET remote-feed": async ({ res, user, url, noStore }) => {
    const t = String(url.searchParams.get("task") || "");
    const from = Math.max(0, Number(url.searchParams.get("from")) || 0);
    if (!ID.test(t)) return sendJson(res, 400, { error: "Invalid task" });
    const key = `remotelog:${lower(user)}:${t}`;
    const until = Date.now() + WAIT_MS;
    for (;;) {
      const [events, raw] = await store.pipeline([["LRANGE", key, from, from + 499], ["GET", `remotetask:${lower(user)}:${t}`]]);
      const task = store.parse(raw);
      if (!task) return sendJson(res, 404, { error: "Task not found" });
      const list = (events || []).map(store.parse).filter(Boolean);
      if (list.length || ["done", "stopped", "error"].includes(task.status) || Date.now() > until) {
        return sendJson(res, 200, { events: list, next: from + list.length, status: task.status, task }, noStore);
      }
      await sleep(1200);
    }
  },
  "POST remote-answer": async ({ res, user, body }) => {
    const b = await body();
    if (!ID.test(b.m || "")) return sendJson(res, 400, { error: "Invalid machine" });
    await push(user, b.m, { kind: "answer", task: clip(b.task, 40), ask: clip(b.ask, 40), choice: Number(b.choice) || 0 });
    return sendJson(res, 200, { ok: true });
  },
  "POST remote-stop": async ({ res, user, body }) => {
    const b = await body();
    if (!ID.test(b.m || "")) return sendJson(res, 400, { error: "Invalid machine" });
    await push(user, b.m, { kind: "stop", task: clip(b.task, 40) });
    const task = await getTask(user, clip(b.task, 40));
    if (task && task.status === "queued") { task.status = "stopped"; await saveTask(user, task); }
    return sendJson(res, 200, { ok: true });
  },
};

module.exports = { ops };
