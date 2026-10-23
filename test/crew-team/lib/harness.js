"use strict";
// The /crew and /team test harness (2026-10-23): a fake yAI site (auth, models, warm-up and a scriptable /api/chat
// stream), a yAI Code session driven over --stdio, and a tiny runner for one area's cases.
//
// Nothing here touches your real ~/.yai: every session runs with a throwaway home folder (USERPROFILE and HOME point at
// it) holding a fake sign-in, so the real cookie is never read or sent, and sessions are saved there, not in yours.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..", "..");
const INDEX = path.join(REPO, "cli", "index.js");
const TMP = path.join(os.tmpdir(), "yai-crew-team-tests");

// a tool call in yAI's text format
const T = (name, args = {}) => `<tool name="${name}">\n${Object.entries(args).map(([k, v]) => `<${k}>\n${v}\n</${k}>`).join("\n")}\n</tool>\n`;
const strip = (s) => String(s ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = [
  { id: "deepseek-v4.1-flash", label: "yAI Ultra Flash", cloud: true, price: { in: 0.1, cached: 0.01, out: 0.4 }, context: 64000 },
  { id: "deepseek-v4-pro", label: "yAI Ultra", cloud: true, price: { in: 0.4, cached: 0.04, out: 1.6 }, context: 64000 },
  { id: "glm-4.7-flash", label: "yAI Lite", cloud: true, price: { in: 0, cached: 0, out: 0 }, context: 64000 },
];

// A project folder for one case, emptied first
let dirN = 0;
function project(name, files = {}) {
  const dir = path.join(TMP, "proj", `${process.pid}-${name.replace(/[^\w-]+/g, "_").slice(0, 40)}-${++dirN}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
}
// A throwaway home with a fake sign-in
function home() {
  const dir = path.join(TMP, "home", String(process.pid));
  fs.mkdirSync(path.join(dir, ".yai"), { recursive: true });
  const cfg = path.join(dir, ".yai", "config.json");
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ cookie: "yai_session=test-only", user: { username: "sim" }, theme: "dark" }));
  return dir;
}
// (YAI_DIR, not USERPROFILE: Chrome for page checks doesn't start under a made-up home)
const homeEnv = () => ({ YAI_DIR: path.join(home(), ".yai") });

// Who sent a chat request, from its system prompt and first message
function whoOf(b) {
  const sys = String(b.system || "");
  const first = JSON.stringify((b.messages || []).find((m) => m.role === "user")?.content || "");
  if (/You supervise a coding session/.test(sys)) return "watcher";
  if (/You are the lead of a small coding team between rounds/.test(sys)) return "round-lead";
  if (/You are the lead of a small coding team/.test(sys)) return "lead";
  if (/You are taking over this job/.test(first)) return "takeover";
  // /team
  if (/You supervise a team of AI coding agents/.test(sys)) return "team-watcher";
  if (/You are the architect of a team of AI agents about to build/.test(sys)) return "direction";
  if (/You turn a software team's check reports/.test(sys)) return "todo";
  if (/You are one of \d+ builder agents/.test(first)) return "builder";
  if (/You are the main builder of this project/.test(first)) return "crew-main";
  if (/You are a helper\. The main builder/.test(first)) return "team-helper";
  const role = /You are the (\w+)(?: checker)? on a team of agents/.exec(first);
  if (role && !/You are taking over this job/.test(first)) return `team-${role[1]}`;
  // /crew
  if (/research the topic before the main agent/.test(first)) return "researcher";
  if (/You are taking over this job/.test(first)) return "takeover";
  if (/one side of a debate[\s\S]*strongest DIFFERENT/.test(first)) return "challenger";
  if (/one side of a debate/.test(first)) return "proposer";
  if (/judge of a debate/.test(first)) return "judge";
  if (/reproduce the bug/.test(first)) return "reproducer";
  if (/root cause of the bug/.test(first)) return "tracer";
  if (/Your job: fix the bug/.test(first)) return "fixer";
  if (/Your job: quality-check/.test(first)) return "qa";
  if (/Your job: write and run tests/.test(first)) return "tester";
  if (/You are a background agent/.test(first)) return "helper";
  if (/# Your crew \(\/crew\)/.test(sys)) return "main";
  return "other";
}

// The fake site. handler(req) → a reply:
//   "text"                                  streamed as content, then done
//   { text, chunk, delay, usage, cost }     the same, in pieces of `chunk` characters `delay` ms apart
//   { status, error }                       an HTTP error with { error }
//   { sseError }                            a stream that sends { error }
//   { drop: n, text }                       sends n characters, then closes without done
//   { hang: true }                          never answers (until the client gives up)
//   { stall: ms, text }                     waits ms before the first byte
// req: { body, who, turn, all, model, system, messages, n }
async function fakeServer(handler, { models = MODELS, defaultModel = "deepseek-v4.1-flash" } = {}) {
  const log = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (o, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname === "/api/auth") return json({ user: { username: "sim", admin: true } });
    if (url.pathname === "/api/models") return json({ models, default: defaultModel });
    if (url.pathname === "/api/warmup") return json({ state: "ready" });
    if (url.pathname === "/api/hub") return json(url.searchParams.get("op") === "search" ? { results: [{ title: "A source", url: "http://127.0.0.1:1/x", snippet: "facts" }] } : { ok: true });
    if (url.pathname !== "/api/chat") return json({ error: "not here" }, 404);
    let raw = ""; for await (const c of req) raw += c;
    let body; try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
    const who = whoOf(body);
    const msgs = body.messages || [];
    const r = { body, who, model: body.model, system: body.system || "", messages: msgs, all: JSON.stringify(msgs), text: msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"), turn: msgs.filter((m) => m.role === "assistant").length, n: log.length, temperature: body.temperature };
    log.push(r);
    let out;
    try { out = await handler(r); } catch (err) { out = { status: 500, error: `handler threw: ${err.message}` }; }
    if (out == null) out = "Done.";
    if (typeof out === "string") out = { text: out };
    r.reply = out;
    if (out.status) return json({ error: out.error || `HTTP ${out.status}` }, out.status);
    if (out.hang) { req.socket.setTimeout(0); r.hung = true; return; }
    if (out.stall) await sleep(out.stall);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let closed = false;
    res.on("close", () => { closed = true; });
    const send = (o) => { if (!res.destroyed && !closed) res.write(`data: ${JSON.stringify(o)}\n\n`); };
    if (out.sseError) { send({ error: out.sseError }); return res.end(); }
    const text = String(out.text ?? "");
    const upto = out.drop != null ? Math.min(out.drop, text.length) : text.length;
    const step = out.chunk || 4000;
    r.sent = 0;
    for (let i = 0; i < upto; i += step) {
      if (res.destroyed || closed) break;
      send({ content: text.slice(i, Math.min(upto, i + step)) });
      r.sent = Math.min(upto, i + step);
      await sleep(out.delay || 0); // a turn of the event loop, so a client that hung up is noticed
    }
    if (out.drop != null) { res.destroy(); return; }
    if (out.thenHang) { r.hung = true; return; } // sent its text, then nothing more, never closed
    send({ done: true, usage: out.usage || { in: 1000, out: 50, cached: 800 }, costUsd: out.cost ?? 0.0001 });
    res.end();
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, log,
    of: (who) => log.filter((r) => r.who === who),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

// A yAI Code session over --stdio
function startYai({ cwd, url, env = {}, args = [] }) {
  const child = spawn(process.execPath, [INDEX, "--stdio", ...args], {
    cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, YAI_URL: url, YAI_NO_MCP: "1", ...homeEnv(), ...env },
  });
  const events = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  require("readline").createInterface({ input: child.stdout }).on("line", (line) => {
    let e; try { e = JSON.parse(line); } catch { return; }
    e.at = Date.now();
    events.push(e);
    for (const w of [...waiters]) if (w.pred(e, events)) { waiters.splice(waiters.indexOf(w), 1); w.done(e); }
  });
  let exited = null;
  child.on("exit", (code) => { exited = code; for (const w of [...waiters]) if (w.onExit) { waiters.splice(waiters.indexOf(w), 1); w.fail(new Error(`yai exited (${code}) while waiting for ${w.what}\n${stderr.slice(-1500)}`)); } });
  const send = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n"); } catch {} };
  // the first event (already seen, or still to come) that matches
  const waitFor = (pred, ms = 30000, what = "an event") => {
    const hit = events.find((e) => pred(e, events));
    if (hit) return Promise.resolve(hit);
    if (exited !== null) return Promise.reject(new Error(`yai had exited (${exited}) before ${what}\n${stderr.slice(-1500)}`));
    return new Promise((done, fail) => {
      const w = { pred, done: (e) => { clearTimeout(t); done(e); }, fail: (err) => { clearTimeout(t); fail(err); }, onExit: true, what };
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`timed out after ${ms} ms waiting for ${what}. Last events:\n${events.slice(-12).map((e) => JSON.stringify(e).slice(0, 200)).join("\n")}\n${stderr.slice(-800)}`)); }, ms);
      waiters.push(w);
    });
  };
  // the next event from now on that matches
  const next = (pred, ms = 30000, what = "an event") => { const from = events.length; return waitFor((e, all) => all.indexOf(e) >= from && pred(e, all), ms, what); };
  const ready = waitFor((e) => e.type === "ready", 20000, "ready");
  // a request ran to its end: a "done" after a "busy"
  const finished = async (ms = 60000) => {
    const from = events.length;
    await waitFor((e, all) => e.type === "busy" && all.indexOf(e) >= from - 1, ms, "busy").catch(() => {});
    const busyAt = events.map((e) => e.type).lastIndexOf("busy");
    return waitFor((e, all) => e.type === "done" && all.indexOf(e) > busyAt, ms, "done after busy");
  };
  const notes = () => events.filter((e) => e.type === "note").map((e) => strip(e.text));
  const texts = () => events.filter((e) => e.type === "text").map((e) => strip(e.line));
  const kill = () => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} };
  return { child, events, send, waitFor, next, ready, finished, notes, texts, kill, stderr: () => stderr, exited: () => exited };
}

// Prompt a session and wait for that request to end
async function ask(y, text, { mode, ms = 60000 } = {}) {
  await y.ready;
  if (mode) y.send({ type: "mode", mode });
  const from = y.events.length;
  y.send({ type: "prompt", text });
  await y.waitFor((e, all) => e.type === "busy" && all.indexOf(e) >= from, ms, "busy");
  const busyAt = y.events.map((e) => e.type).lastIndexOf("busy");
  return y.waitFor((e, all) => e.type === "done" && all.indexOf(e) > busyAt, ms, "the request to end");
}
async function command(y, text, { mode, ms = 60000 } = {}) {
  await y.ready;
  if (mode) y.send({ type: "mode", mode });
  const from = y.events.length;
  y.send({ type: "command", text });
  await y.waitFor((e, all) => e.type === "busy" && all.indexOf(e) >= from, ms, "busy");
  const busyAt = y.events.map((e) => e.type).lastIndexOf("busy");
  return y.waitFor((e, all) => e.type === "done" && all.indexOf(e) > busyAt, ms, "the command to end");
}

// Until cond() is true (polled), or fail after ms
async function until(cond, ms = 20000, what = "a condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(100);
  }
}

// The fake ui and state crew.js needs when it's required directly (with the real ui.js's colours)
function crewKit({ url, root, models = MODELS, oneShot } = {}) {
  process.env.YAI_URL = url;
  process.env.YAI_NO_MCP = "1";
  Object.assign(process.env, homeEnv());
  const ui = require(path.join(REPO, "cli", "ui.js"));
  const evs = [];
  ui.setSink((e) => evs.push(e));
  const T2 = require(path.join(REPO, "cli", "tools.js"));
  const ctx = T2.makeContext(root);
  const renders = { n: 0 };
  const state = { models, model: "deepseek-v4.1-flash", mode: "acceptEdits", crewTask: "a test task" };
  const X = { oneShot: oneShot || (async () => '{"actions":[]}') };
  delete require.cache[require.resolve(path.join(REPO, "cli", "crew.js"))];
  const CREW = require(path.join(REPO, "cli", "crew.js"))({ state, root, ui, X, ctx });
  return { ui, state, ctx, CREW, X, evs, renders, notes: () => evs.filter((e) => e.type === "note").map((e) => strip(e.text)) };
}

// A fake site and a session in a fresh folder, both closed when the case ends
async function session(ctl, handler, { env = {}, files = {}, name = "s", serverOpts } = {}) {
  const srv = await fakeServer(typeof handler === "function" ? handler : (r) => (handler[r.turn] ?? "Done."), serverOpts);
  const dir = project(name, files);
  const y = startYai({ cwd: dir, url: srv.url, env });
  ctl.cleanup(() => srv.close());
  ctl.cleanup(() => y.kill());
  await y.ready;
  return { y, srv, dir, file: (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return null; } } };
}

// ---------- one area's cases ----------
// Each case: { name, ms, fn }. Run in order; each prints one JSON line the runner reads.
async function suite(file, cases) {
  const only = process.env.CASE ? new RegExp(process.env.CASE, "i") : null;
  const cleanups = [];
  for (const c of cases) {
    if (only && !only.test(c.name)) continue;
    const t0 = Date.now();
    const ctl = { cleanup: (fn) => cleanups.push(fn) };
    let ok = true, err = "";
    const limit = c.ms || 60000;
    try {
      await Promise.race([c.fn(ctl), sleep(limit).then(() => { throw new Error(`case took over ${limit} ms`); })]);
    } catch (e) { ok = false; err = (e && e.stack) || String(e); }
    for (const fn of cleanups.splice(0).reverse()) { try { await fn(); } catch {} }
    process.stdout.write(JSON.stringify({ file: path.basename(file), name: c.name, ok, ms: Date.now() - t0, err: ok ? "" : err.slice(0, 4000) }) + "\n");
  }
  process.exit(0);
}

module.exports = { REPO, INDEX, TMP, T, strip, sleep, MODELS, project, home, homeEnv, whoOf, fakeServer, startYai, ask, command, until, crewKit, session, suite };
