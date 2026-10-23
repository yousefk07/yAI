#!/usr/bin/env node
"use strict";
// yAI Code: a coding agent in your terminal, on the models from your yAI site.
//
//   yai                    start in the current folder
//   yai -c                 continue the last conversation in this folder
//   yai -p "question"      answer once and exit (read-only unless --accept-edits)
//   yai -m <model>         pick the model by name or number
//
// It signs in with your yAI account, reads and edits files in the folder it was started in
// (never outside it), and asks before changing files or running commands.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { execSync } = require("child_process");
const api = require("./api");
const ui = require("./ui");
const T = require("./tools");
const { c, print, spinner } = ui;
const LOOK = require("./look")({ ui }); // the v2 look: status pill, key bar, plan card, approvals, summaries
// The full-window app (cli/screen.js): header, conversation, plan panel, input box and key bar, like the design.
const SCREEN = require("./screen")({ ui });
ui.setScreen(SCREEN);

// The version is the build number: how many changes have been pushed to yAI so far (the site's What's new page uses the
// same number). Read from git when yai runs from its own clone, otherwise from package.json.
const VERSION = (() => {
  const home = path.join(__dirname, "..");
  const git = (args) => execSync(`git ${args}`, { cwd: home, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
  try {
    if (path.resolve(git("rev-parse --show-toplevel")).toLowerCase() === path.resolve(home).toLowerCase()) {
      const n = git("rev-list --count HEAD");
      if (/^\d+$/.test(n)) return `1.0.${n}`;
    }
  } catch {}
  return require("../package.json").version || "1.0.0";
})();
const MODES = ["default", "acceptEdits", "yolo", "plan"];
const MAX_STEPS = Number(process.env.YAI_MAX_STEPS) || 50; // tool calls per request before yAI stops to check in (/team raises it for agents that write)
// Steps that only look at things: the same one again with nothing changed gives the same answer, so it isn't run
// twice (2026-10-22: a /team builder re-read the same three parts of a file 43 times and wrote nothing, at 20x the cost).
const LOOK_STEPS = new Set(["read_file", "list_files", "search", "find_files", "run"]);
// Share of the model's window at which old tool output is dropped, and at which the conversation is
// summarized automatically so a task never stops at 100%.
const TRIM_AT = 0.75;
const AUTO_COMPACT_AT = 0.9;
const COMPACT_HINT_AT = 350_000;
const SAFE_COMMANDS = /^(git (status|diff|log|show|branch)|ls|dir|pwd|cat|type|Get-ChildItem|Get-Content|Get-Location|node (-v|--version|--check)|npm (-v|--version|ls)|where|which)\b/i;

// `yai <pack>` (any focus pack's name): start in the pack's folder with it on (cli/focus.js). Before `root` is fixed.
const STARTUP_FOCUS = require("./focus").startup(process.argv);

// ---------- state ----------
const root = path.resolve(process.cwd());
const ctx = T.makeContext(root);
ctx.interrupted = () => state.interrupted; // crew_wait stops waiting when the agent is stopped
const state = {
  pasted: [], // clipboard images pasted this session: [image N] is pasted[N - 1]
  pastedText: [], // long or multi-line pastes: [Pasted text #N +K lines] is pastedText[N - 1]
  user: null,
  models: [],
  model: "",
  mode: "default",
  messages: [],
  pendingContext: [], // output of !commands, sent with the next message
  conversationId: crypto.randomUUID(),
  warmed: new Set(),
  busy: false,
  asking: false,
  abort: null,
  interrupted: false,
  usage: { in: 0, out: 0 },
  allowEdits: false,
  printMode: false,
  undo: [], // edits yAI made this session, newest last: { abs, before, created }
  placeholder: false, // the faint "Ask yAI…" hint is showing in the empty prompt
  cost: { session: 0, todayUsd: null, limitUsd: null }, // yAI Ultra: this session's spend, and today's against the allowance
  askHook: null, // ({ title, detail, options, edit }) => Promise<index>: questions go to the phone (yai remote) or VS Code (--stdio)
  stdio: false, // run by the VS Code extension (yai --stdio)
  remote: null, // yai remote: listening for tasks from the phone
  // v2 (2026-10-21): where things stand, for the status pill and the keys that work now:
  // welcome · ready · finished · attention
  phase: "welcome",
  phaseLabel: "",
  plan: null, // { steps: [...], done: n } written by the model while it works
  task: null, // this request: { files: Map(path -> { a, d }), tests, failure, offerFix }
  quick: {}, // single keys offered now (pressed alone): key -> () => void
  prefix: "", // a starter picked on the start screen ("Fix this: ") goes in front of the next message
  hint: "", // the input's placeholder for the next message
};
const projectKey = crypto.createHash("sha1").update(root.toLowerCase()).digest("hex").slice(0, 16);
const project = () => ((api.cfg.projects ||= {})[projectKey] ||= { path: root, allowedCommands: [] });
const SESSION_FILE = path.join(api.DIR, "sessions", `${projectKey}.json`); // one per folder, before 2026-10-20
const SESSIONS_DIR = path.join(api.DIR, "sessions");
// Each conversation has its own file now, so /resume can pick any earlier one.
const sessionFile = () => path.join(SESSIONS_DIR, `${projectKey}-${state.conversationId}.json`);
const HISTORY_FILE = path.join(api.DIR, "history");

// ---------- helpers ----------
const relPath = (abs) => T.rel(ctx, abs);
const modelLabel = (id = state.model) => state.models.find((m) => m.id === id)?.label || id || "no model";
const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// /showcase, /look, /duo, /fix, /commit, /review, /share, /tutor (cli/extras.js).
const X = require("./extras")({
  state, ctx, root, api, ui, T, project,
  syncMute: () => syncMute(),
  runAgent: (text) => runAgent(text),
  showPrompt: () => showPrompt(),
  question: (q) => question(q),
  topLevel: () => topLevel(),
  modelLabel: () => modelLabel(),
  title: () => sessionTitle({ messages: state.messages }),
});

// /team: background agents that split the work (cli/team.js).
// Connections (cli/connect.js): the website's connected services, and /connections, /pr, /issues, /deploy.
const CONN = require("./connect")({
  state, root, api, ui, X,
  select: (o) => select(o),
  question: (q) => question(q),
  runAgent: (text) => runAgent(text),
});
// Focus packs (cli/focus.js): a private knowledge file (~/.yai/packs) kept in front of the model, e.g. /acme.
const FOCUS = require("./focus")({ state, root, api, ui, project: () => project() });
const serviceOk = new Set(); // write services the user said "always" to, this session
ctx.service = (tool, args, confirm) => CONN.call(tool, args, confirm);
ctx.serviceTool = (name) => CONN.tools().find((t) => t.name === name);
ctx.serviceNames = () => CONN.tools().map((t) => t.name);
ctx.approve = async (name, args) => {
  if (serviceOk.has(name)) return true;
  const detail = Object.entries(args).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n").slice(0, 1500);
  const r = await askPermission(`Let yAI use ${name}?`, `Yes, and don't ask again for ${name} this session`, detail);
  if (r === "always") serviceOk.add(name);
  return r === "yes" || r === "always";
};

// /crew: this chat with background agents it commissions (cli/crew.js)
const CREW = require("./crew")({ state, root, ui, X, ctx });
ctx.onCommission = (spec) => (state.crewActive ? CREW.commission(spec) : null);
const TEAM = require("./team")({
  state, root, api, ui, X,
  syncMute: () => syncMute(),
  runAgent: (text) => runAgent(text),
  select: (o) => select(o),
  checklist: (o) => checklist(o),
  inputLine: () => rl.line,
  testCounts: (s) => LOOK.testCounts(s),
  riskOf: (s) => LOOK.riskOf(s),
  topLevel: () => topLevel(),
  modelLabel: () => modelLabel(),
});

// /bench: the coding benchmark on any model (cli/bench.js).
const BENCH = require("./bench")({ state, api, ui, syncMute: () => syncMute(), findModel: (q) => findModel(q), modelLabel: () => modelLabel() });

// MCP servers: their tools join yAI's own (cli/mcp.js).
const MCP = require("./mcp")({ root, api, T, version: VERSION });

// web_search goes through the site (which may have a search API key), or straight to DuckDuckGo if that fails.
ctx.webSearch = async (q) => {
  try {
    return (await api.search(q)).results || [];
  } catch (err) {
    if (err.auth) throw new Error("Not signed in. Run /login.");
    return require("../lib/search").search(q);
  }
};
// check_page's eyes (2026-10-22): a model that can see describes the screenshot, plainly and critically, so a text-only
// model building a game knows what's actually on screen
ctx.describeImage = (img, lookFor) => X.withVision((m) => X.oneShot({ // → { vm, text }
  model: m.id, signal: state.abort?.signal,
  system: "You look at a screenshot of a web app or game for the developer building it. In 3 to 6 short lines say what is on screen and what looks wrong or unfinished: blank or black areas, missing or placeholder graphics (plain boxes where there should be shapes), overlapping or cut-off UI, error text, anything that doesn't look like a finished product. Be specific and honest; don't praise.",
  messages: [{ role: "user", content: [{ type: "text", text: lookFor ? `Check especially: ${lookFor}` : "Describe it." }, X.imagePart(img, "image/jpeg")] }],
}), state.abort?.signal).then((r) => String(r?.text || "").trim());
// A background command that ends on its own: yAI hears about it with the next message, and so does the user.
ctx.onTaskDone = (t) => {
  if (t.stopped) return;
  state.pendingContext.push(`Background task ${t.id} (${t.command}) ${T.taskStatus(t)}. Its last output:\n${T.clipOutput(t.out.slice(-2000), 2000)}`);
  if (!state.busy && !state.printMode && rl) {
    process.stdout.write("\r\x1b[K");
    ui.note(`${t.code ? c.red("●") : c.green("●")} ${c.ink(`background task ${t.id} ${T.taskStatus(t)}`)} ${c.dim(`· ${ui.middle(t.command, 40)}`)}`);
    showPrompt();
  }
};
process.on("exit", () => {
  T.stopAllTasks(ctx);
  MCP.stopAll();
});

// Project MCP servers (.mcp.json) run commands from the repository, so the user OKs them once per project.
async function approveMcp(list) {
  const known = project().mcpApproved || [];
  const fresh = list.filter((s) => !known.includes(s.name));
  if (!fresh.length || state.printMode) return list.map((s) => s.name).filter((n) => known.includes(n));
  print("");
  print(` ${c.yellow("?")} ${c.ink("This project lists MCP servers that run on your computer:")}`);
  for (const s of fresh) print(`   ${c.bold(c.ink(s.name))} ${c.dim(s.cfg.url || [s.cfg.command, ...(s.cfg.args || [])].join(" "))} ${c.dim(`(${s.source})`)}`);
  const a = ((await question(` ${ui.choices([["Y", "Start them"], ["N", "Not now"]], "Y").trimStart()}`)) || "").trim().toLowerCase();
  if (a === "" || a === "y" || a === "yes") {
    project().mcpApproved = [...known, ...fresh.map((s) => s.name)];
    api.save();
    return list.map((s) => s.name);
  }
  return list.map((s) => s.name).filter((n) => known.includes(n));
}
function mcpSummary() {
  const all = [...MCP.servers.values()];
  if (!all.length) return null;
  const ready = all.filter((s) => s.state === "ready");
  const tools = ready.reduce((n, s) => n + s.tools.length, 0);
  const failed = all.filter((s) => s.state === "failed").map((s) => s.name);
  return { text: `${ready.length} server${ready.length === 1 ? "" : "s"} · ${tools} tool${tools === 1 ? "" : "s"}`, failed };
}

// /mcp                    list servers and their tools
// /mcp add <name> <command …> | <url>    save a server in ~/.yai/config.json and start it
// /mcp remove <name>      /mcp restart <name>
async function mcpCommand(arg) {
  const [sub, name, ...rest] = arg.split(/\s+/).filter(Boolean);
  if (sub === "add") {
    if (!name || !rest.length) return print(c.yellow("Usage: /mcp add <name> <command and args>   or   /mcp add <name> https://server/mcp"));
    const cfg = /^https?:\/\//.test(rest[0]) ? { url: rest[0] } : { command: rest[0], args: rest.slice(1) };
    (api.cfg.mcpServers ||= {})[name] = cfg;
    api.save();
    spinner.start(`starting ${name}`);
    MCP.remove(name);
    const s = await MCP.connect({ name, cfg, source: "you" });
    spinner.stop();
    return s.state === "ready"
      ? ui.note(`${c.green("✓")} ${c.ink(`${name}: ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}`)} ${c.dim("· saved in " + path.join(api.DIR, "config.json"))}`)
      : ui.note(`${c.red("✕")} ${c.ink(`${name} didn't start:`)} ${c.dim(s.error)}`);
  }
  if (sub === "remove" || sub === "rm") {
    if (!name) return print(c.yellow("Usage: /mcp remove <name>"));
    if (api.cfg.mcpServers) delete api.cfg.mcpServers[name];
    api.save();
    MCP.remove(name);
    return ui.note(`${c.yellow("↺")} ${c.ink(`removed ${name}`)}`);
  }
  if (sub === "restart") {
    spinner.start(`restarting ${name}`);
    const s = await MCP.restart(name);
    spinner.stop();
    if (!s) return print(c.yellow(`No MCP server called ${name}.`));
    return ui.note(s.state === "ready" ? `${c.green("✓")} ${c.ink(`${name}: ${s.tools.length} tools`)}` : `${c.red("✕")} ${c.dim(s.error)}`);
  }
  const all = [...MCP.servers.values()];
  print("");
  if (!all.length) {
    print(c.dim("  No MCP servers. Add one with /mcp add <name> <command>, e.g."));
    print(c.dim("    /mcp add files npx -y @modelcontextprotocol/server-filesystem ."));
    print(c.dim("  or list them in .mcp.json in the project, the same format as Claude Code."));
    return;
  }
  for (const s of all) {
    const dot = s.state === "ready" ? c.green("●") : s.state === "failed" ? c.red("●") : c.yellow("●");
    print(` ${dot} ${c.bold(c.ink(s.name))} ${c.dim(`· ${s.source} · ${s.state === "ready" ? `${s.tools.length} tools` : s.state === "failed" ? s.error : "starting"}`)}`);
    if (s.state === "ready") print(c.dim(`     ${s.tools.map((t) => t.name).join(", ").slice(0, 400)}`));
  }
}

// /tasks: background commands; /tasks stop <n>
function tasksCommand(arg) {
  const [sub, id] = arg.split(/\s+/);
  if (sub === "stop" || sub === "kill") {
    const t = ctx.tasks.get(Number(id));
    if (!t) return print(c.yellow(`No background task ${id || ""}.`));
    T.stopTask(t);
    return ui.note(`${c.yellow("■")} ${c.ink(`stopped task ${t.id}`)}`);
  }
  if (!ctx.tasks.size) return print(c.dim("   No background tasks. yAI starts servers and watchers in the background when it needs them."));
  print("");
  for (const t of ctx.tasks.values()) {
    const dot = t.done ? (t.code && !t.stopped ? c.red("●") : c.faint("●")) : c.green("●");
    print(` ${dot} ${c.bold(c.ink(String(t.id)))} ${c.ink(ui.middle(t.command, 60))} ${c.dim("· " + T.taskStatus(t))}`);
    const last = t.out.trim().split("\n").slice(-2).join(" | ");
    if (last) print(c.dim(`     ${ui.middle(last, ui.columns() - 8)}`));
  }
  print(c.dim("\n   /tasks stop <n> stops one"));
}

function findModel(q) {
  const n = Number(q);
  if (Number.isInteger(n) && n >= 1 && n <= state.models.length) return state.models[n - 1];
  const s = String(q).toLowerCase();
  return state.models.find((m) => m.id.toLowerCase() === s) || state.models.find((m) => (m.label + " " + m.id).toLowerCase().includes(s));
}

function pushUser(content) {
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === "user") last.content += "\n\n" + content;
  else state.messages.push({ role: "user", content });
}

function saveSession() {
  if (!state.messages.length) return;
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    state.title ||= sessionTitle({ messages: state.messages });
    fs.writeFileSync(sessionFile(), JSON.stringify({ id: state.conversationId, title: state.title, root, model: state.model, savedAt: new Date().toISOString(), messages: state.messages }));
  } catch {}
}

function gitBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
  } catch {
    return "";
  }
}

// Folders directly inside the project that are git repositories (for a project folder that holds several).
let repoCache;
function nestedRepos() {
  if (repoCache) return repoCache;
  repoCache = [];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && fs.existsSync(path.join(root, e.name, ".git"))) repoCache.push(e.name);
      if (repoCache.length >= 10) break;
    }
  } catch {}
  return repoCache;
}


// ---------- choice boxes (the 2026-10-20 design): ↑↓ or a number to choose, enter to confirm, esc to cancel ----------
// Draws ui.selectLines and redraws it in place. Resolves to the chosen index, or -1 for esc / Ctrl+C.
// While it's open the typed keys don't reach readline's line (output is muted and the line is cleared after).
function select(opts) {
  if (!process.stdout.isTTY) return Promise.resolve(0);
  spinner.stop();
  let sel = opts.selected || 0;
  const render = opts.render || ui.selectLines;
  let lines = render({ ...opts, selected: sel });
  if (SCREEN.on) SCREEN.setExtra(["", ...lines]);
  else for (const l of lines) process.stdout.write(l + "\n");
  const wasMuted = ui.rlOutput.muted;
  ui.rlOutput.muted = true;
  state.selecting = true;
  return new Promise((resolve) => {
    const redraw = () => {
      const next = render({ ...opts, selected: sel });
      if (SCREEN.on) SCREEN.setExtra(["", ...next]);
      else {
        process.stdout.write(`\x1b[${lines.length}A`);
        for (const l of next) process.stdout.write("\r\x1b[K" + l + "\n");
      }
      lines = next;
    };
    let finished = false;
    const done = (i) => {
      if (finished) return;
      finished = true;
      process.stdin.removeListener("keypress", onKey);
      state.selecting = false;
      state.cancelSelect = null;
      // The box goes away; what was chosen is shown by the caller.
      if (SCREEN.on) SCREEN.setExtra([]);
      else process.stdout.write(`\x1b[${lines.length}A\r\x1b[J`);
      rl.write(null, { ctrl: true, name: "u" });
      ui.rlOutput.muted = wasMuted;
      resolve(i);
    };
    const onKey = (s, key = {}) => {
      if (state.inMouse) return; // a mouse-wheel report's characters aren't answers
      if (opts.keys && s && opts.keys.includes(s.toLowerCase())) { sel = opts.keys.indexOf(s.toLowerCase()); redraw(); return done(sel); }
      if (key.name === "up" || key.name === "left" || (key.name === "k" && !opts.keys)) { sel = (sel + opts.options.length - 1) % opts.options.length; redraw(); }
      else if (key.name === "down" || key.name === "right" || (key.name === "j" && !opts.keys) || key.name === "tab") { sel = (sel + 1) % opts.options.length; redraw(); }
      else if (key.name === "return" || key.name === "enter") done(sel);
      else if (key.name === "escape" || (key.ctrl && key.name === "c")) done(-1);
      else if (/^[1-9]$/.test(s || "") && Number(s) <= opts.options.length) { sel = Number(s) - 1; redraw(); done(sel); }
    };
    state.cancelSelect = () => done(-1);
    process.stdin.on("keypress", onKey);
  });
}

// A checklist (2026-10-21, the /team picker): rows to tick, grouped under headings, and a Start row. Resolves to the
// rows' on/off values (heading rows left out), or null when cancelled. Rows with a `model` show it, and ← → changes it
// to the next or previous of `models` ({ id, short }); the new id is left on the row (2026-10-22: a model per agent).
// The /team picker draws itself (`render(sel)` → lines), adds its own keys (`onKey(s, key, { sel, draw, finish })`,
// true when it handled one) and its own key hints (`keys`).
async function checklist({ title, note = "", rows, start, models = [], render, onKey: extraKey, keys }) {
  spinner.stop();
  const items = rows.filter((r) => r.kind !== "head");
  if (!process.stdout.isTTY || state.askHook) return items.map((r) => !!r.on);
  let sel = 0, drawn = [];
  state.checklistKeys = keys || null;
  const draw = () => {
    const lines = render ? render(sel) : LOOK.checklistLines({ title, note, rows, sel, start: start(items), models });
    if (SCREEN.on) SCREEN.setExtra(["", ...lines]);
    else {
      if (drawn.length) process.stdout.write(`\x1b[${drawn.length}A`);
      for (const l of lines) process.stdout.write("\r\x1b[K" + l + "\n");
      if (drawn.length > lines.length) process.stdout.write("\x1b[J");
    }
    drawn = lines;
  };
  const wasMuted = ui.rlOutput.muted;
  ui.rlOutput.muted = true;
  state.selecting = true;
  state.checklistOpen = true;
  draw();
  return new Promise((resolve) => {
    const finish = (r) => {
      process.stdin.removeListener("keypress", onKey);
      state.selecting = false;
      state.checklistOpen = false;
      state.checklistKeys = null;
      state.cancelSelect = null;
      if (SCREEN.on) SCREEN.setExtra([]);
      else process.stdout.write(`\x1b[${drawn.length}A\r\x1b[J`);
      rl.write(null, { ctrl: true, name: "u" });
      ui.rlOutput.muted = wasMuted;
      resolve(r);
    };
    const onKey = (s, key = {}) => {
      if (state.inMouse) return;
      const n = items.length + 1; // the items and the Start row
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(null);
      if (extraKey && extraKey(s, key, { sel, draw, finish })) return;
      if (key.name === "up") { sel = (sel + n - 1) % n; return draw(); }
      if (key.name === "down" || key.name === "tab") { sel = (sel + 1) % n; return draw(); }
      if (key.name === "space" && sel < items.length) { items[sel].on = !items[sel].on; return draw(); }
      if ((key.name === "left" || key.name === "right") && sel < items.length && items[sel].model && models.length > 1) {
        const i = models.findIndex((m) => m.id === items[sel].model);
        items[sel].model = models[(i + (key.name === "right" ? 1 : models.length - 1)) % models.length].id;
        return draw();
      }
      if (/^[1-9]$/.test(s || "") && Number(s) <= items.length) { sel = Number(s) - 1; items[sel].on = !items[sel].on; return draw(); }
      if (key.name === "return" || key.name === "enter") {
        if (sel < items.length) { items[sel].on = !items[sel].on; return draw(); }
        return finish(items.map((r) => !!r.on));
      }
    };
    state.cancelSelect = () => finish(null);
    process.stdin.on("keypress", onKey);
  });
}

// The question form (ask_user, 2026-10-21): a tab for each question and one to submit, numbered options, "Type
// something" for an answer of your own and "Chat about this" to talk it over. Resolves to { answers } or { chat } or {}.
async function askForm(questions) {
  spinner.stop();
  // VS Code and the phone: one question at a time
  if (state.askHook || !process.stdout.isTTY) {
    const answers = [];
    for (const q of questions) {
      const i = state.askHook ? await state.askHook({ title: q.question, detail: q.options.map((o) => o.description ? `${o.label}: ${o.description}` : o.label).join(" · "), options: q.options.map((o) => o.label) }) : 0;
      if (i < 0) return {};
      answers.push(q.options[i] || q.options[0]);
    }
    return { answers };
  }
  const n = questions.length;
  let tab = 0, sel = 0, typing = false, draft = "", drawn = [];
  const answers = [];
  const draw = () => {
    const lines = LOOK.formLines({ questions, tab, sel, answers, typing, draft });
    if (SCREEN.on) SCREEN.setExtra(["", ...lines]);
    else {
      if (drawn.length) process.stdout.write(`\x1b[${drawn.length}A`);
      for (const l of lines) process.stdout.write("\r\x1b[K" + l + "\n");
      if (drawn.length > lines.length) process.stdout.write("\x1b[J");
    }
    drawn = lines;
  };
  const wasMuted = ui.rlOutput.muted;
  ui.rlOutput.muted = true;
  state.selecting = true;
  state.formOpen = true;
  draw();
  return new Promise((resolve) => {
    const finish = (r) => {
      process.stdin.removeListener("keypress", onKey);
      state.selecting = false;
      state.formOpen = false;
      state.cancelSelect = null;
      if (SCREEN.on) SCREEN.setExtra([]);
      else process.stdout.write(`\x1b[${drawn.length}A\r\x1b[J`);
      rl.write(null, { ctrl: true, name: "u" });
      ui.rlOutput.muted = wasMuted;
      resolve(r);
    };
    const options = () => (tab < n ? questions[tab].options.length + 2 : 2); // + "Type something" and "Chat about this"
    const go = (t) => {
      tab = Math.max(0, Math.min(n, t));
      const a = answers[tab];
      sel = tab < n && a ? (a.own ? questions[tab].options.length : Math.max(0, questions[tab].options.findIndex((o) => o.label === a.label))) : 0;
      draw();
    };
    const choose = () => {
      if (tab === n) return sel === 0 ? finish({ answers }) : finish({});
      const q = questions[tab];
      if (sel < q.options.length) { answers[tab] = q.options[sel]; return go(tab + 1); }
      if (sel === q.options.length) { typing = true; draft = answers[tab] && answers[tab].own ? answers[tab].label : ""; return draw(); }
      return finish({ chat: true });
    };
    const onKey = (s, key = {}) => {
      if (state.inMouse) return;
      if (typing) {
        if (key.name === "return" || key.name === "enter") {
          typing = false;
          if (draft.trim()) { answers[tab] = { label: draft.trim(), own: true }; return go(tab + 1); }
          return draw();
        }
        if (key.name === "escape") { typing = false; return draw(); }
        if (key.name === "backspace") draft = draft.slice(0, -1);
        else if (s && !key.ctrl && !key.meta && s.length === 1 && s >= " ") draft += s;
        return draw();
      }
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish({});
      if (key.name === "right" || (key.name === "tab" && !key.shift)) return go(tab + 1);
      if (key.name === "left" || (key.name === "tab" && key.shift)) return go(tab - 1);
      if (key.name === "up") { sel = (sel + options() - 1) % options(); return draw(); }
      if (key.name === "down") { sel = (sel + 1) % options(); return draw(); }
      if (key.name === "return" || key.name === "enter") return choose();
      if (/^[1-9]$/.test(s || "") && Number(s) <= options()) { sel = Number(s) - 1; draw(); return choose(); }
    };
    state.cancelSelect = () => finish({});
    process.stdin.on("keypress", onKey);
  });
}

// ---------- /help: the commands, grouped, in columns ----------
const HELP_GROUPS = [
  ["Session", [["/clear", "start a new conversation"], ["/resume", "pick an earlier conversation"], ["/compact", "summarise (/compact <focus>)"], ["/undo", "revert yAI's last edit"], ["/share", "publish at an unlisted link"]]],
  ["Model", [["/model", "switch model"], ["/duo", "plan + review with 2 models"], ["/team", "agents split the work"], ["/crew", "one builder + helpers"], ["/bench", "run the coding benchmark"], ["/status", "account, model and usage"], ["/usage", "today's limits, last 30 days"]]],
  ["Project", [["/init", "write YAI.md"], ["/fix", "run the tests, fix them"], ["/review", "review your changes"], ["/commit", "write a commit and commit"]]],
  ["Look & make", [["/clone", "rebuild a page from a screenshot"], ["/look", "design review of a page"], ["/showcase", "record a demo video"], ["/image", "make an image"], ["/video", "make a video"]]],
  ["Modes & tools", [["/mode", "ask · auto-edit · plan"], ["/plan", "read-only planning"], ["/tutor", "hints, not answers"], ["/web", "search the web, cite sources"], ["/mcp", "MCP servers and tools"], ["/tasks", "background commands"], ["/remote", "take tasks from your phone"]]],
  ["Account", [["/login", "sign in to yAI"], ["/logout", "sign out"], ["/theme", "colours"], ["/config url", "use another yAI site"], ["/exit", "quit"]]],
  ["Keys", [["@", "mention a file or folder"], ["!", "run a shell command"], ["alt+v", "paste a screenshot"], ["shift+tab", "cycle the approval mode"], ["esc", "interrupt yAI"]]],
];
function showHelp() {
  const inner = ui.width() - 3;
  const cols = inner >= 108 ? 3 : inner >= 72 ? 2 : 1;
  const colW = Math.floor((inner - 2) / cols);
  const keyW = 12;
  const blocks = HELP_GROUPS.map(([name, items]) => [
    c.faint(name),
    ...items.map(([k, d]) => `${c.accent(k.padEnd(keyW))}${c.dim(ui.middle(d, colW - keyW - 2))}`),
  ]);
  const rows = [` ${c.bold(c.ink("Commands"))}${" ".repeat(Math.max(2, inner - 10 - 33))}${c.faint("type one at the prompt to run it")}`, ""];
  for (let i = 0; i < blocks.length; i += cols) {
    const group = blocks.slice(i, i + cols);
    const h = Math.max(...group.map((g) => g.length));
    for (let r = 0; r < h; r++) rows.push(" " + group.map((g) => padVis(g[r] || "", colW)).join(""));
    rows.push("");
  }
  rows.push(` ${c.faint("Docs and setup: ")}${c.dim(api.baseUrl())}${c.faint("  ·  yai -p \"task\" answers once  ·  yai -c continues")}`);
  ui.print("");
  ui.frame(rows, { indent: 1, inner });
}
const padVis = (s, n) => s + " ".repeat(Math.max(0, n - ui.stripAnsi(s).length));

// ---------- /model: a table to pick from ----------
const SPEED = { "deepseek-v4-pro": "fast", "deepseek-v4.1-flash": "fast", "glm-4.7-flash": "free", "qwen3-coder-30b-cloud": "~60 tok/s" };
async function modelPicker() {
  let ultraLeft = "";
  try {
    const u = await (await fetch(`${api.baseUrl()}/api/hub?op=usage`, { headers: { Cookie: api.cfg.cookie || "", "User-Agent": "yai-code/1.0" } })).json();
    if (u.today) ultraLeft = `$${Math.max(0, u.today.ultra.limitUsd - u.today.ultra.spentUsd).toFixed(2)} left`;
  } catch {}
  const W = { name: 24, where: 10, ctx: 9, speed: 11 };
  const rowOf = (m) => {
    const where = m.price ? "hosted" : m.cloud || /cloud/.test(m.id) ? "cloud GPU" : "your PC";
    const ctx = m.context ? `${Math.round(m.context / 1000)}k` : "8k";
    const cost = m.price ? ultraLeft || "daily limit" : "free";
    const name = ui.middle(m.label, W.name - (m.id === state.model ? 10 : 1)) + (m.id === state.model ? " (current)" : "");
    return `${name.padEnd(W.name)}${where.padEnd(W.where)}${ctx.padEnd(W.ctx)}${(SPEED[m.id] || (where === "your PC" ? "~120 tok/s" : "—")).padEnd(W.speed)}${cost}`;
  };
  const i = await select({
    title: "Switch model", note: "applies from the next message",
    header: `${"model".padEnd(W.name)}${"where".padEnd(W.where)}${"context".padEnd(W.ctx)}${"speed".padEnd(W.speed)}cost`,
    options: state.models.map(rowOf),
    selected: Math.max(0, state.models.findIndex((m) => m.id === state.model)),
    hint: "↑↓ choose · enter switch · esc cancel",
  });
  return i < 0 ? null : state.models[i];
}

// Recently used sessions in any folder, for the welcome screen: [{ when, title, here }]
function recentSessions(n = 3) {
  const dir = path.join(api.DIR, "sessions");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, n * 2);
  } catch {}
  const out = [];
  for (const { f } of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!s.messages?.length || String(s.root || "").startsWith(os.tmpdir())) continue; // not /bench's temporary folders
      out.push({ when: ago(s.savedAt), title: sessionTitle(s), folder: path.basename(s.root || ""), here: s.root === root });
    } catch {}
    if (out.length >= n) break;
  }
  return out;
}

// /web <question>: searches the web (through the site, which uses its search API), shows the results, and has yAI
// answer from them with [n] citations, reading a page with web_fetch when a snippet isn't enough.
async function webCommand(q) {
  if (!q) return print(c.yellow("   Usage: /web <what to look up>   e.g. /web what's new in Node.js 24"));
  if (!state.user) await ensureLogin();
  print("");
  ui.resetSections();
  ui.toolHeader("Web search", q);
  spinner.start("searching");
  let results;
  try {
    results = await ctx.webSearch(q);
  } catch (err) {
    spinner.stop();
    return ui.toolResult(err.message, { color: c.red });
  }
  spinner.stop();
  if (!results.length) return ui.toolResult("no results", { color: c.yellow });
  ui.toolResult(results.map((r, i) => `[${i + 1}] ${ui.middle(r.title || r.url, 70)}  ${r.site || ""}`).join("\n"), { summary: `${results.length} results` });
  const block = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || ""}`).join("\n\n");
  await runAgent(`${q}\n\n<web_results>\n${block}\n</web_results>\n\nAnswer from these web results; web_fetch a page if a snippet isn't enough. Cite them like [1] after the sentences that use them, and end with the links you used.`);
}

// ---------- system prompt ----------
function projectNotes() {
  for (const name of ["YAI.md", "CLAUDE.md", "AGENTS.md"]) {
    try {
      const text = fs.readFileSync(path.join(root, name), "utf8");
      return `\n# Project notes (${name})\n${text.slice(0, 20000)}`;
    } catch {}
  }
  return "";
}

function topLevel() {
  const names = [];
  for (const { entry } of T.walk(ctx, root, 1)) {
    names.push(entry.name + (entry.isDirectory() ? "/" : ""));
    if (names.length >= 60) break;
  }
  return names.join("  ");
}

// What changes while yAI works (prompt caching, 2026-10-21): sent at the end of each request, not in the system prompt,
// so the system prompt and the conversation before it stay the same from one request to the next.
// (1) The attempt log (2026-10-22): one line per edit, page check and command result, kept by yAI, not the model. Old
// steps are trimmed from the conversation to save money, and then an agent no longer knows it already tried something,
// so it tries it again (a main builder changed and reverted the same line for minutes). The last 30 lines go at the
// end of every request, where trimming never reaches.
const attempts = [];
function logAttempt(line) {
  const t = new Date(); attempts.push(`${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")} ${line}`);
  if (attempts.length > 60) attempts.splice(0, attempts.length - 60);
}
const attemptBlock = () => (attempts.length ? `\n<attempt_log note="what you already did this task, oldest first; check it before you try something again">\n${attempts.slice(-30).join("\n")}\n</attempt_log>` : "");
function envContext() {
  const branch = gitBranch();
  const repo = branch ? `git branch: ${branch}` : nestedRepos().length ? `not a git repository; these folders in it are: ${nestedRepos().join(", ")} (run git there with git -C <folder> ...)` : "not a git repository";
  const mode = state.tutor ? "TUTOR (you may read files and run commands such as tests; editing files is off)" : state.mode === "plan" ? "PLAN (read-only: investigate, then present a plan; do not edit or run anything)" : state.mode === "yolo" ? "edits, commands and deletions are all applied automatically" : state.mode === "acceptEdits" ? "edits are applied automatically" : "the user approves each edit and command";
  return `<environment>\n- Repository: ${repo}\n- Permission mode: ${mode}\n- Top-level files: ${topLevel() || "(empty folder)"}\n</environment>`;
}
// How to write a tool call. DeepSeek (yAI Ultra Flash) is taught its own DSML format, the one it was trained on:
// asked for yAI's <tool> blocks it kept mixing the two (2026-10-21). Everyone else gets the <tool> blocks.
function toolFormat() {
  if (/^deepseek/i.test(state.model)) {
    const D = "｜DSML｜";
    return `To use a tool, end your message with one tool call in your native DSML format, each tag on its own line:

<${D}tool_calls>
<${D}invoke name="read_file">
<${D}parameter name="path" string="true">src/app.js</${D}parameter>
</${D}invoke>
</${D}tool_calls>

Then stop writing. The result comes back in the next message inside <tool_result>. One tool per message. Use only this
format for tool calls (never <tool> tags), never put a tool call inside a code fence, and never write a <tool_result>.

Values go inside the parameter as-is, without escaping, and multi-line values are fine:

<${D}tool_calls>
<${D}invoke name="edit_file">
<${D}parameter name="path" string="true">src/app.js</${D}parameter>
<${D}parameter name="old" string="true">function add(a, b) {
  return a - b;
}</${D}parameter>
<${D}parameter name="new" string="true">function add(a, b) {
  return a + b;
}</${D}parameter>
</${D}invoke>
</${D}tool_calls>`;
  }
  return `To use a tool, end your message with a block in exactly this format, each tag on its own line:

<tool name="read_file">
<path>src/app.js</path>
</tool>

Then stop writing. The result comes back in the next message inside <tool_result>. One tool per message. Never put tool blocks inside code fences, and never write a <tool_result> yourself.

Multi-line values go between the tags as-is, without escaping:

<tool name="edit_file">
<path>src/app.js</path>
<old>
function add(a, b) {
  return a - b;
}
</old>
<new>
function add(a, b) {
  return a + b;
}
</new>
</tool>`;
}
// A /team agent (YAI_TEAM_AGENT, 2026-10-22) gets a shorter prompt: it is re-sent with every step of every agent, and
// an agent has no use for connected services, the plan panel or advice about chatting with the user. Its brief
// carries the task-specific rules.
const TEAM_AGENT = !!process.env.YAI_TEAM_AGENT;
// (connected services are allowed since 2026-10-22, read-only ones only: see the service tool)
const TEAM_SKIP = new Set(["ask_user"]);
const TEAM_ONLY = new Set(["team_say"]); // tools only a /team agent has (the team chat)
// /crew's main builder (YAI_CREW_LEAD) also commissions helpers and waits for them
const CREW_LEAD = !!process.env.YAI_CREW_LEAD, CREW_ONLY = new Set(["commission", "crew_wait"]);
const toolAllowed = (name) => (CREW_ONLY.has(name) ? CREW_LEAD || !!state.crewActive : TEAM_AGENT ? !TEAM_SKIP.has(name) : !TEAM_ONLY.has(name));
// A /team agent's progress, sent to the board after each reply (2026-10-22): its plan and how far it is, what it has
// cost, the tokens it has processed, and how many replies came from the fallback model.
function teamProgress() {
  if (!TEAM_AGENT && !state.stdio) return; // a team agent, or the VS Code panel (its plan card)
  ui.event({ type: "progress", plan: state.plan ? { steps: state.plan.steps, done: state.plan.done } : null, cost: state.cost.session, tokens: state.teamTokens || 0, usage: state.teamUsage || null, fallbacks: state.fallbacks || 0 });
}
function teamPrompt(shell, toolDocs) {
  return `You are one agent in a yAI Code team, working in a project folder on your own part of a bigger task.

# Environment
- Project folder: ${root} (all paths are relative to it; nothing outside it is reachable)
- Shell: ${shell}
- Date: ${new Date().toDateString()}
- The newest <environment> block at the end of the latest message has the current permission mode and top-level files.

# Tools
${toolFormat()}

Available tools:
${toolDocs}${CONN.promptBlock({ readOnly: true })}${FOCUS.block()}

# How to work
- When you need documentation, a library's current API, an error explained or anything recent, use web_search, then web_fetch the best result; for exact maths or facts, or data from the user's accounts, use a connected service (above). Don't guess at an API you're unsure of.
- Never guess what a file contains: read it. Read several files in one step (several paths in one read_file).
- Everything you were given in your brief (the task, the contract) is already in front of you: don't read it again from disk.
- Each step re-sends the whole conversation, so don't re-read files you already read unless they changed.
- Read a file before editing it; copy <old> exactly, without the line numbers. Small edit_file changes; write_file for new files.
- Write long files in parts of at most 60 lines (write_file, then write_file with <append>true</append>).
- Check your work when you can (a syntax check such as node --check file.js, or the tests). Delete scratch files.
- Before a fix, say in one line what you expect it to change. After checking, say whether it did. If it didn't, say what is different about your next attempt before you make it, and look at your <attempt_log> first: never make a change you already made and undid.
- If a tool returns an error, fix the cause instead of repeating the call.
- Be brief: at most one short sentence before a tool call. End with a short report, without a tool call.
- Start your first reply with a short plan of 3 to 5 steps in plain words, between <plan> and </plan>, one numbered step per line. When a whole step is finished, start your next reply with <done>N</done> (N = steps finished so far). yAI shows these as your progress.${projectNotes()}`;
}

// The tools as an OpenAI-style list, for hosts that call tools natively (DeepSeek's API, 2026-10-22). Every argument is
// a string, as in the text format; the site turns the model's calls back into <tool> blocks.
function nativeTools() {
  return Object.entries(T.tools)
    .filter(([name]) => toolAllowed(name))
    .map(([name, t]) => ({ name, description: String(t.describe || "").slice(0, 1500), params: t.params.slice(0, 20) }));
}

function systemPrompt() {
  const shell = process.platform === "win32"
    ? "Windows PowerShell 5.1 (chain commands with ; — a && b and a || b also work, yAI converts them)"
    : `bash on ${os.type()}`;
  const toolDocs = Object.entries(T.tools)
    .filter(([name]) => toolAllowed(name))
    .map(([name, t]) => `- ${name}(${t.params.join(", ")}): ${t.describe}`)
    .join("\n");
  if (TEAM_AGENT) return teamPrompt(shell, toolDocs);
  return `You are yAI Code, a coding agent working in the user's terminal. You help with software tasks in their project: you read, search and edit files and run commands.

# Environment
- Project folder: ${root}
- Shell: ${shell}
- Date: ${new Date().toDateString()}
- The git branch, the permission mode and the top-level files change as you work, so they come at the end of the latest
  message, in <environment>; always follow the newest one.
All paths are relative to the project folder. You cannot access anything outside it.

# Tools
${toolFormat()}

Available tools:
${toolDocs}${CONN.promptBlock()}${FOCUS.block()}

# How to work
- Look before you change anything: use list_files, find_files, search and read_file. Never guess what a file contains.
- Your context window is small. Read big files in parts (<limit> of about 150 lines, where the search points you) and search with a specific pattern or a <glob>, instead of reading whole files.
- When you describe the project, only state what you saw in files you read; say "probably" for anything you are inferring from names.
- If you create scratch or debug files to try something out, delete them before you finish.
- Read a file before editing it. Copy <old> exactly from the read_file output, without the line numbers.
- Make small, focused edit_file changes; use write_file only for new files or full rewrites. Keep the project's existing style.
- A reply has a length limit. Write long files in parts of at most 60 lines: write_file with the first part, then write_file with <append>true</append> for the rest.
- If the user asks for text (an answer, an essay, an explanation) and doesn't ask for a file, reply with the text itself; don't write a file.
- After changing code, check it when you can (run the tests, or a quick syntax check such as node --check file.js).
- When you need documentation, an error message explained, a library's current API or anything recent, use web_search, then web_fetch the best result. Don't guess at APIs you're unsure of.
- Start dev servers and watchers with run and <background>true</background>, then check them with task_output (or web_fetch http://localhost:<port>). Stop them with task_stop when you're done unless the user wants them running.
- If a tool returns an error, fix the cause and try again instead of repeating the same call.
- Questions get answers, not edits. Don't change files the user didn't ask about.
- When the request leaves real choices open that change what you'd build and the code can't tell you (a fixed list or free text? which page?), ask with ask_user before you start: up to 4 short questions with 2 to 4 options each. Don't ask about things you can decide yourself.
- Be brief. Before a tool call, write at most one short sentence. When the task is done, say what you changed in a few sentences, without a tool call.
- Use Markdown sparingly; the user reads your replies in a terminal.${LOOK.PLAN_RULES}${state.tutor ? X.TUTOR_PROMPT : ""}${projectNotes()}`;
}

// ---------- readline, prompt and keys ----------
let rl;
let lastCtrlC = 0;
const queue = [];

function syncMute() {
  ui.rlOutput.muted = SCREEN.on || (state.busy && !state.asking);
  SCREEN.render();
}

// The prompt: "› ", with a faint hint while it's empty (what it says depends on where things stand).
const PLACEHOLDERS = { welcome: "Describe a task, or ask about the code", ready: "Ask a follow-up, or / for commands", finished: "Ask for a follow-up", attention: "Or tell me how you'd like to fix it" };
const placeholder = () => state.hint || PLACEHOLDERS[state.phase] || PLACEHOLDERS.ready;
function promptText() {
  return ` ${c.accent("›")} `;
}

// Git branch and how many files are modified, for the footer and the welcome box.
function gitStatus() {
  const branch = gitBranch();
  if (!branch) return null;
  let modified = 0;
  try {
    modified = execSync("git status --porcelain", { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().split("\n").filter(Boolean).length;
  } catch {}
  return { branch, modified };
}

// How full the model's context is: the conversation and instructions against the model's window (the site
// says how big each one is; 32k for yAI 3 Coder, about 8k for the local models), at roughly 3.6 characters a
// token. A big window keeps 4k tokens free for the reply itself.
function contextChars() {
  const m = state.models.find((x) => x.id === state.model);
  const tokens = (m && m.context) || (/cloud/.test(state.model) ? 24000 : 8192);
  return (tokens - (tokens >= 16000 ? 4096 : 0)) * 3.6;
}
const usedChars = () => JSON.stringify(state.messages).length + systemPrompt().length;
function contextPercent() {
  return Math.min(100, Math.round((usedChars() / contextChars()) * 100));
}
// How much of a file or a command's output can go back to the model and still leave it room to
// answer. A small local model can't take a 400-line file whole, so the middle is cut instead.
// No single result may take more than 30% of the window, so two big reads can't fill it.
function toolBudget() {
  return Math.max(2500, Math.floor(Math.min(40000, contextChars() * 0.3, contextChars() * 0.85 - usedChars())));
}

// The line above the prompt: "main ● 2 modified   ctx 23%   approvals: ask        ⇧⇥ plan mode   /undo".
const MODE_NAMES = { default: "ask before running", acceptEdits: "auto-approve edits", yolo: "auto-approve everything", plan: "plan · read-only" };
const shortPath = (p) => { const h = os.homedir(); return p.toLowerCase().startsWith(h.toLowerCase()) ? "~" + p.slice(h.length).replace(/\\/g, "/") : p; };
function footerLine() {
  const left = [`${c.green("●")} ${c.dim(modelLabel())}`, c.faint(ui.middle(shortPath(root), 36))];
  const git = gitStatus();
  if (git) left.push(c.faint(git.branch) + (git.modified ? " " + c.yellow(`●${git.modified}`) : ""));
  left.push(state.mode === "default" ? c.faint(MODE_NAMES.default) : c.accent(MODE_NAMES[state.mode]));
  if (state.tutor) left.push(c.accent("tutor"));
  if (state.duo) left.push(c.accent("duo"));
  const pct = contextPercent();
  const filled = Math.round((pct / 100) * 6);
  const meter = c.dim("━".repeat(filled)) + c.line("─".repeat(6 - filled));
  const right = [c.faint(state.lastStats || "ready"), `${c.faint("context")} ${meter} ${c.faint(pct + "%")}`];
  // yAI Ultra's spend: this session, and today against the daily allowance (purple from 80%).
  if (state.cost.session > 0 || state.models.find((m) => m.id === state.model)?.price) {
    const t = state.cost;
    const today = t.todayUsd != null && t.limitUsd ? ` · today $${t.todayUsd.toFixed(2)}/$${t.limitUsd}` : "";
    const hot = t.todayUsd != null && t.limitUsd && t.todayUsd / t.limitUsd >= 0.8;
    right.unshift((hot ? c.accent : c.faint)(`$${t.session.toFixed(t.session < 1 ? 3 : 2)}${today}`));
  }
  // On a narrow terminal the folder goes first, so the stats and the context meter stay.
  const fits = (l) => ui.stripAnsi(ui.footer(l, right)).includes("context");
  return ui.footer(fits(left) ? left : left.filter((_, i) => i !== 1), right);
}
// The rule the prompt sits under, with the keys on its right.
function ruleLine() {
  const hint = state.undo.length ? "@ files · / commands · /undo" : "@ files · / commands · ⇧⇥ mode";
  return " " + c.line("─".repeat(Math.max(4, ui.width() - hint.length - 3))) + " " + c.faint(hint);
}

function pillState() {
  if (state.phase === "finished") return ["finished", state.phaseLabel || "Finished"];
  if (state.phase === "attention") return ["attention", "Needs attention"];
  return ["ready", "Ready"];
}
function showPrompt() {
  if (state.printMode) return;
  if (state.redrawWhenIdle) {
    state.redrawWhenIdle = false;
    redrawTranscript();
  }
  if (SCREEN.on) {
    rl.setPrompt("");
    rl.prompt(true);
    return drawBelow();
  }
  print("");
  const [st, label] = pillState();
  print(LOOK.statusRow({ project: path.basename(root), branch: gitBranch(), st, label }));
  rl.setPrompt(promptText());
  rl.prompt(true);
  showPlaceholder();
  drawBelow();
}
// What each part of the full-window app shows (cli/screen.js asks for them on every draw).
let branchCache = { at: 0, name: "" };
function liveBranch() {
  if (Date.now() - branchCache.at > 5000) branchCache = { at: Date.now(), name: gitBranch() };
  return branchCache.name;
}
const panelOpen = () => !!(SCREEN.on && (process.stdout.columns || 0) >= 100 && ((state.busy && state.plan && state.plan.steps.length && state.task && !state.task.over) || (state.crewActive && CREW.count())));
SCREEN.parts.header = (cols) => {
  let [st, label] = pillState();
  if (state.selecting && state.busy) [st, label] = ["waiting", "Waiting for you"];
  else if (state.busy) [st, label] = ["working", state.plan && state.plan.steps.length ? `Working · step ${Math.min(state.plan.done + 1, state.plan.steps.length)} of ${state.plan.steps.length}` : "Working"];
  return LOOK.headerRow(cols, { project: state.focus ? `${state.focus.title} · ${path.basename(root)}` : path.basename(root), branch: liveBranch(), st, label });
};
SCREEN.parts.panel = () => (panelOpen() ? (w) => [...(state.busy && state.plan?.steps.length && state.task && !state.task.over ? LOOK.panelLines(state.plan, state.task, w) : []), ...(state.crewActive ? CREW.panelLines(w) : [])] : null);
SCREEN.parts.input = () => {
  const text = rl ? rl.line : "";
  if (state.asking) {
    return { label: "›", text: state.askHidden ? "•".repeat(text.length) : text, cursor: rl.cursor, placeholder: state.askLabel || "", active: true };
  }
  // a question form or an approval card has the keys; the input stays out of it
  if (state.formOpen || state.checklistOpen) return { text: "", cursor: 0, placeholder: state.checklistKeys ? "Press c to chat about the plan instead" : "Answer above, or choose Chat about this to talk it over", active: false, caret: false };
  // a /team run says who a note goes to (the whole team, or the agent you're watching)
  if (state.busy && state.teamInput) return { text, cursor: rl ? rl.cursor : 0, placeholder: state.teamInput.placeholder?.() || "Add a note for the whole team…", hint: state.teamInput.hint?.() || "read after each step", active: false };
  if (state.busy) return { text, cursor: rl ? rl.cursor : 0, placeholder: state.selecting ? "Or tell me what to do instead" : "Add a note while I work…", hint: "I'll read it after this step", active: false };
  return { text, cursor: rl ? rl.cursor : 0, placeholder: placeholder(), hint: text ? "" : state.phase === "welcome" ? "enter to send" : "", active: true };
};
SCREEN.parts.keys = (cols) => {
  const list = suggestions();
  const keys = list ? LOOK.KEYS.commands : state.checklistOpen ? state.checklistKeys || [["↑↓", "move"], ["space", "toggle"], ["←→", "model"], ["enter", "start"], ["esc", "cancel"]] : state.formOpen ? [["←→", "question"], ["↑↓", "choose"], ["enter", "select"], ["esc", "cancel"]] : state.teamKeys && !state.selecting ? state.teamKeys() : state.selecting && state.busy ? LOOK.KEYS.waiting : state.busy ? LOOK.KEYS.working : LOOK.KEYS[state.phase] || LOOK.KEYS.ready;
  const mode = state.mode === "default" ? c.faint(MODE_WORDS.default) : c.accent(MODE_WORDS[state.mode]);
  return LOOK.keysRow(keys, { mode, model: modelLabel(), memory: contextPercent() }, cols);
};
function showPlaceholder() {
  if (!process.stdout.isTTY || rl.line) return;
  const p = placeholder();
  process.stdout.write(c.faint(p) + `\x1b[${p.length}D`);
  state.placeholder = true;
}
// Under the input: the keys that work now (or the /command suggestions while one is being typed). Drawn with moves
// relative to the cursor, so it stays right when the screen scrolls; readline wipes it on some edits, so every
// key press draws it again.
const MODE_WORDS = { default: "asks before changes", acceptEdits: "auto-accept edits", yolo: "auto-accept everything", plan: "plan · read-only" };
const sugg = { sel: 0, closed: null };
function suggestions() {
  const line = rl ? rl.line : "";
  if (!/^\/\S*$/.test(line) || sugg.closed === line) return null;
  const q = line.slice(1).toLowerCase();
  const all = COMMAND_INFO();
  const starts = all.filter(([n]) => n.slice(1).startsWith(q));
  const inside = all.filter(([n, t, d]) => !starts.includes(all.find((x) => x[0] === n)) && q && (n + " " + t + " " + d).toLowerCase().includes(q));
  return [...starts, ...inside].slice(0, 6);
}
function belowLines() {
  const list = suggestions();
  if (list) {
    sugg.sel = Math.min(sugg.sel, Math.max(0, list.length - 1));
    return LOOK.suggestionLines(list, sugg.sel, rl.line);
  }
  const keys = LOOK.KEYS[state.phase] || LOOK.KEYS.ready;
  const mode = state.mode === "default" ? c.faint(MODE_WORDS.default) : c.accent(MODE_WORDS[state.mode]);
  return [LOOK.keysRow(keys, { mode, model: modelLabel(), memory: contextPercent() })];
}
function drawBelow() {
  if (SCREEN.on) {
    // the /command suggestions sit at the end of the conversation, over the input
    const list = !state.busy && !state.selecting && !state.asking ? suggestions() : null;
    if (list) sugg.sel = Math.min(sugg.sel, Math.max(0, list.length - 1));
    if (!state.selecting) SCREEN.setExtra(list ? ["", ...LOOK.suggestionLines(list, sugg.sel, rl.line)] : []);
    return SCREEN.render();
  }
  if (!process.stdout.isTTY || state.printMode || state.stdio || state.busy || state.selecting || state.asking || !rl) return;
  const lines = belowLines();
  const cols = process.stdout.columns || 100;
  const total = Math.floor((3 + rl.line.length) / cols); // rows the input takes, after the first
  const pos = rl.getCursorPos();
  const down = Math.max(0, total - pos.rows);
  process.stdout.write((down ? `\x1b[${down}B` : "") + "\r\n" + lines.map((l) => "\x1b[K" + l).join("\r\n") + "\x1b[J" +
    `\x1b[${lines.length + down}A\x1b[${pos.cols + 1}G`);
}

function setMode(mode, { announce = true } = {}) {
  state.mode = mode;
  if (announce && (!state.busy || SCREEN.on)) drawBelow();
}

// rl.question, but the answer doesn't end up in the ↑ history.
// Returns null if the user pressed Esc.
function question(q, { hidden = false } = {}) {
  state.asking = true;
  state.escAnswer = false;
  state.askLabel = ui.stripAnsi(String(q)).trim();
  state.askHidden = hidden;
  syncMute();
  return new Promise((resolve) => {
    if (hidden && !SCREEN.on) {
      process.stdout.write(q);
      ui.rlOutput.muted = true;
    }
    rl.question(hidden ? "" : q, (answer) => {
      if (rl.history && rl.history[0] === answer) rl.history.shift();
      if (hidden && !SCREEN.on) {
        ui.rlOutput.muted = false;
        process.stdout.write("\n");
      }
      state.askLabel = "";
      state.askHidden = false;
      state.asking = false;
      syncMute();
      resolve(state.escAnswer ? null : answer);
    });
  });
}

function completer(line) {
  if (/^\/\S*$/.test(line)) {
    const hits = COMMAND_NAMES.filter((n) => n.startsWith(line));
    return [hits.length ? hits : COMMAND_NAMES, line];
  }
  const m = line.match(/@([^\s@]*)$/);
  if (!m) return [[], line];
  const partial = m[1].replace(/\\/g, "/");
  const dirPart = partial.includes("/") ? partial.slice(0, partial.lastIndexOf("/") + 1) : "";
  const base = partial.slice(dirPart.length).toLowerCase();
  let dir;
  try {
    dir = T.resolve(ctx, dirPart || ".");
  } catch {
    return [[], line];
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  const hits = entries
    .filter((e) => !ctx.ignore.has(e.name) && e.name.toLowerCase().startsWith(base))
    .map((e) => "@" + dirPart + e.name + (e.isDirectory() ? "/" : ""))
    .slice(0, 50);
  return [hits, "@" + partial];
}

function setupReadline() {
  let history = [];
  try {
    history = fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean).reverse().slice(0, 300);
  } catch {}
  rl = readline.createInterface({ input: process.stdin, output: ui.rlOutput, terminal: true, history, historySize: 300, completer });

  // Boxes and rules are drawn to the window's width; when it changes, everything is drawn again at the new width
  // (2026-10-21: a narrower window wrapped every line of the start box). While yAI works, it waits until it's done.
  let cols = process.stdout.columns, resizeTimer = null;
  process.stdout.on("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (process.stdout.columns === cols) return;
      cols = process.stdout.columns;
      state.redrawWhenIdle = true;
      if (SCREEN.on) return SCREEN.render(); // the full-window app redraws at any size
      if (state.busy || state.asking || state.selecting) return;
      process.stdout.write("\r\x1b[K");
      showPrompt();
    }, 180);
  });

  // While a /command is being typed, ↑↓ move through the suggestions (not the history), tab completes the chosen
  // one, enter runs it and esc closes the list.
  const ttyWrite = rl._ttyWrite.bind(rl);
  let mouse = null, paste = null;
  rl._ttyWrite = (s, key = {}) => {
    // Pasting (bracketed paste, 2026-10-21): the text arrives whole, so its line breaks don't send the prompt. One short
    // line goes in as typed; anything longer stands in the prompt as [Pasted text #N +K lines], as in Claude Code, and
    // the full text goes to the model.
    if (key.name === "paste-start") { paste = ""; state.inMouse = true; return; }
    if (paste !== null) {
      if (key.name !== "paste-end") { paste += s || ""; return; }
      const text = paste.replace(/\r\n?/g, "\n");
      paste = null;
      setImmediate(() => (state.inMouse = false));
      if (!text) return;
      if (!text.includes("\n") && text.length <= 800) return ttyWrite(text, {});
      state.pastedText.push(text);
      const n = text.split("\n").length;
      return ttyWrite(`[Pasted text #${state.pastedText.length} +${n} line${n === 1 ? "" : "s"}] `, {});
    }
    // Mouse reports (SGR: ESC [ < button ; x ; y M) arrive as single characters; the wheel scrolls, the rest is dropped.
    if (SCREEN.on) {
      if (key.code === "[<") { mouse = ""; state.inMouse = true; return; }
      if (mouse !== null) {
        if (s === "M" || s === "m") {
          const [btn, x, y] = mouse.split(";").map(Number);
          if (btn === 64) SCREEN.scrollBy(3);
          else if (btn === 65) SCREEN.scrollBy(-3);
          else SCREEN.mouse(btn, x, y, s === "m"); // selecting text to copy
          mouse = null;
          setImmediate(() => (state.inMouse = false));
        } else mouse += s || "";
        return;
      }
      SCREEN.clearSelection();
      if (key.name === "pageup") return SCREEN.page(1);
      if (key.name === "pagedown") return SCREEN.page(-1);
      if (key.name === "end" && key.ctrl) return SCREEN.toBottom();
    }
    if (state.keyHook && !state.selecting && state.keyHook(s, key)) return;
    const list = !state.busy && !state.selecting && !state.asking ? suggestions() : null;
    if (list && list.length) {
      const setLine = (t) => { rl.line = t; rl.cursor = t.length; rl._refreshLine(); };
      if (key.name === "up" || key.name === "down") {
        sugg.sel = (sugg.sel + (key.name === "up" ? -1 : 1) + list.length) % list.length;
        return drawBelow();
      }
      if (key.name === "tab" && !key.shift) return setLine(list[sugg.sel][0] + " "), drawBelow();
      if (key.name === "escape") return (sugg.closed = rl.line), drawBelow();
      if ((key.name === "return" || key.name === "enter") && rl.line !== list[sugg.sel][0]) setLine(list[sugg.sel][0]);
    }
    return ttyWrite(s, key);
  };

  process.stdin.on("keypress", (s, key) => {
    if (SCREEN.on) setImmediate(() => SCREEN.render());
    if (state.selecting || state.inMouse) return;
    // (not after enter: the input has just been sent, and the bar under it goes away with it)
    if (!state.busy && !state.asking && !(key && (key.name === "return" || key.name === "enter"))) setImmediate(() => {
      if (!/^\/\S*$/.test(rl.line)) sugg.sel = 0;
      drawBelow();
    });
    // A single key offered on screen (1–4 on the start screen, r / c / u after a task, f / s / n after a failure):
    // pressed alone, with a short pause after it, it acts; typing on makes it the start of a message.
    if (!state.busy && !state.asking && rl.line.length === 1 && (state.quick[rl.line.toLowerCase()] || rl.line === "?")) {
      const k = rl.line;
      clearTimeout(state.quickTimer);
      state.quickTimer = setTimeout(() => {
        if (rl.line !== k || state.busy) return;
        const act = k === "?" ? () => command("/help").then(showPrompt) : state.quick[k.toLowerCase()];
        rl.line = "";
        rl.cursor = 0;
        if (!SCREEN.on) process.stdout.write("\r\x1b[J");
        print("");
        act();
      }, 450);
    }
    // The first key clears the faint hint (readline has already drawn the key; this wipes the rest).
    if (state.placeholder && !state.asking && !SCREEN.on) {
      state.placeholder = false;
      process.stdout.write("\x1b[K");
    }
    if (!key) return;
    if (key.name === "escape") {
      if (state.asking) {
        state.escAnswer = true;
        rl.write(null, { ctrl: true, name: "u" });
        rl.write("\n");
      } else if (state.busy && state.abort && !state.teamView) {
        state.interrupted = true;
        state.abort.abort();
      }
    } else if (key.name === "v" && (key.ctrl || key.meta) && !state.busy && !state.asking) {
      pasteImage();
    } else if (key.name === "tab" && key.shift && !state.busy && !state.asking) {
      setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);
    }
  });

  rl.on("SIGINT", () => {
    if (state.selecting) return state.cancelSelect && state.cancelSelect();
    if (state.asking) {
      state.escAnswer = true;
      rl.write(null, { ctrl: true, name: "u" });
      return rl.write("\n");
    }
    if (state.busy && state.abort) {
      state.interrupted = true;
      return state.abort.abort();
    }
    if (rl.line) return rl.write(null, { ctrl: true, name: "u" });
    if (Date.now() - lastCtrlC < 2000) return rl.close();
    lastCtrlC = Date.now();
    if (SCREEN.on) print(c.dim("   Press Ctrl+C again to exit"));
    else process.stdout.write("\r\x1b[K" + c.dim("Press Ctrl+C again to exit") + "\n");
    rl.prompt(true);
  });

  rl.on("close", () => {
    try {
      fs.mkdirSync(api.DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, [...rl.history].reverse().join("\n") + "\n");
    } catch {}
    SCREEN.exit();
    process.stdout.write("\n");
    ui.resetTerminal();
    process.exit(0);
  });

  // Pasted text arrives as many lines at once: lines that land within 25 ms become one message.
  let lines = [], timer = null;
  rl.on("line", (line) => {
    // Enter in a choice box (and anything ↑ pulled from history meanwhile) isn't a message.
    if (state.selecting) {
      if (rl.history && rl.history[0] === line) rl.history.shift();
      return;
    }
    if (state.asking) return;
    lines.push(line);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const text = lines.join("\n");
      lines = [];
      if (state.busy) {
        // while a /team runs, what you type is a note for the team (or the agent you're watching)
        if (state.teamInput && text.trim()) return state.teamInput(text.trim());
        if (text.trim()) {
          queue.push(text);
          print(c.dim(`   Queued: ${text.split("\n")[0].slice(0, 60)}`));
        }
        return;
      }
      handleInput(text);
    }, 25);
  });
}

// ---------- sign-in ----------
async function ensureLogin() {
  try {
    state.user = await api.me();
  } catch (err) {
    if (!err.auth) throw new Error(`Can't reach ${api.baseUrl()}: ${err.message}`);
  }
  if (state.user) return;
  if (state.printMode) throw new Error("Not signed in. Run `yai` once to sign in.");
  print(c.bold("Sign in to yAI") + c.dim(` · ${api.baseUrl()}`));
  print(c.dim("Use the same account as the website. No account? Sign up at " + api.baseUrl()));
  for (let tries = 0; tries < 5; tries++) {
    const username = ((await question("Username: ")) || "").trim();
    if (!username) process.exit(1);
    const password = (await question("Password: ", { hidden: true })) || "";
    try {
      state.user = await api.login(username, password);
      print(c.green(`✓ Signed in as ${state.user}`));
      return;
    } catch (err) {
      print(c.red(`  ${err.message}`));
    }
  }
  process.exit(1);
}

async function loadModels() {
  const data = await api.models();
  state.models = data.models || [];
  state.localOffline = !!data.localOffline;
  // A /model pick is remembered; picks saved before yAI Ultra Flash became the default (2026-10-21) are dropped once.
  // yAI Ultra moved from Kimi K3 to DeepSeek V4 Pro (2026-10-22): a saved pick of the old id means the new one
  const saved = api.cfg.modelPicked === 3 ? (api.cfg.model === "kimi-k3-ultra" ? "deepseek-v4-pro" : api.cfg.model) : undefined;
  if (!state.models.some((m) => m.id === state.model)) {
    state.model = state.models.find((m) => m.id === saved)?.id || data.default || state.models.find((m) => /cloud/.test(m.id))?.id || state.models[0]?.id || "";
  }
}

// ---------- the agent loop ----------
// When the conversation passes TRIM_AT of the window, old tool output (oldest first, the last few messages
// kept) becomes a one-line note until it is back near 60%.
// /team agents set YAI_TRIM_TOKENS (2026-10-22): every step re-sends the whole conversation, so a long agent paid for
// the same old file contents dozens of times. Past that size, old tool output and the text of files it wrote are cut
// in one go, down to about 60% of it (never the last 8 steps). Cutting rewrites the start of the conversation, which the model's prompt cache
// then has to pay for once more, so it is done rarely and in one big step rather than a little every turn.
const TRIM_TOKENS = Number(process.env.YAI_TRIM_TOKENS) || 0;
function trimContext() {
  const limit = TRIM_TOKENS ? Math.min(contextChars() * TRIM_AT, TRIM_TOKENS * 3.6) : contextChars() * TRIM_AT;
  if (usedChars() < limit) return;
  const goal = TRIM_TOKENS ? limit * 0.6 : contextChars() * 0.6;
  // a team agent keeps its last 8 steps whole: a reviewer reads the whole project in a few steps and needs it all at once
  const keep = TRIM_TOKENS ? 16 : 4;
  let cut = false;
  for (let i = 1; i < state.messages.length - keep && usedChars() > goal; i++) {
    const m = state.messages[i];
    if (typeof m.content !== "string" || m.content.length <= 400) continue;
    if (m.role === "user" && m.content.startsWith("<tool_result")) {
      m.content = m.content.split("\n")[0] + "\n[old tool output removed to save space; read the file again if you need it]\n</tool_result>";
      cut = true;
    } else if (TRIM_TOKENS && m.role === "assistant" && /<tool name="write_file">/.test(m.content)) {
      // what it wrote is on disk; the call itself only needs to say which file
      m.content = m.content.replace(/<content>\n?[\s\S]*?(\n<\/content>|$)/, (all) => `<content>\n[${all.split("\n").length - 2} lines, now in the file]\n</content>`);
      cut = true;
    }
  }
  if (cut) state.trims = (state.trims || 0) + 1;
}

const TAG_ALIASES = {
  path: ["file", "file_path", "filepath", "filename"],
  old: ["old_str", "old_text", "search", "find", "original", "before"],
  new: ["new_str", "new_text", "replace", "replacement", "updated", "after"],
  command: ["cmd", "shell", "bash", "powershell"],
  content: ["text", "code", "body"],
  pattern: ["query", "regex", "glob"],
};

function parseToolCall(text) {
  // <tool name="run">, and the attribute style some models use: <tool name="run" command="npm test">.
  const head = /(^|\n)[ \t]*<tool\s+name\s*=\s*["']?([\w-]+)["']?((?:\s+[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*>/.exec(text);
  if (!head) return null;
  const name = head[2];
  const attrs = {};
  for (const m of (head[3] || "").matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1]] = m[2] ?? m[3];
  const rest = text.slice(head.index + head[0].length);
  // the last </tool> on a line of its own ends the call: file text inside it may mention </tool> itself
  const ends = [...rest.matchAll(/\n[ \t]*<\/tool>/g)];
  let end = ends.length ? ends[ends.length - 1].index : -1;
  if (end < 0) end = rest.lastIndexOf("</tool>");
  // yAI Ultra Flash sometimes ends its reply exactly where </tool> would go (2026-10-21: two read_file calls in a
  // row were sent back as "not finished"). If every argument it opened is closed and the reply ends on a closing
  // tag, the call is whole; a reply really cut off ends inside an open tag.
  let unclosed = false;
  if (end < 0) {
    const t = rest.trimEnd();
    const opened = [...t.matchAll(/<([a-z_][\w-]*)>/g)].map((m) => m[1]);
    if (!opened.length || !/<\/[a-z_][\w-]*>$/.test(t) || !opened.every((tag) => t.includes(`</${tag}>`))) return { name, cutOff: true };
    end = t.length;
    unclosed = true;
  }
  const body = rest.slice(0, end) + "\n";
  const tool = T.tools[name];
  const args = {};
  for (const p of tool ? tool.params : []) {
    // The tag the instructions ask for first, then names small models tend to use instead.
    for (const tag of [p, ...(TAG_ALIASES[p] || [])]) {
      const open = body.indexOf(`<${tag}>`);
      if (open < 0) continue;
      const from = open + tag.length + 2;
      const close = ["content", "new"].includes(p) ? body.lastIndexOf(`</${tag}>`) : body.indexOf(`</${tag}>`, from);
      if (close < from) continue;
      args[p] = body.slice(from, close).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      break;
    }
  }
  // DeepSeek (yAI Ultra Flash) sometimes writes the arguments as JSON: <tool name="search">{"pattern": "…"}</tool>.
  if (tool && !Object.keys(args).length && /^\s*\{[\s\S]*\}\s*$/.test(body)) {
    try {
      const obj = JSON.parse(body);
      for (const p of tool.params) {
        const key = [p, ...(TAG_ALIASES[p] || [])].find((k) => obj[k] !== undefined);
        if (key !== undefined) args[p] = typeof obj[key] === "string" ? obj[key] : JSON.stringify(obj[key]);
      }
    } catch {}
  }
  // Small models often skip the inner tags (<tool name="run">node --test</tool>) or use their own
  // (<cmd>, <file>). If none of the expected tags were found, the bare text is the first argument.
  for (const p of tool ? tool.params : []) {
    if (args[p] !== undefined) continue;
    const key = [p, ...(TAG_ALIASES[p] || [])].find((k) => attrs[k] !== undefined);
    if (key) args[p] = attrs[key];
  }
  if (tool && tool.params.length && !Object.keys(args).length) {
    // "command=New-Item ..." / "path: src/app.js": the argument written as name=value instead of in its tag.
    const first = tool.params[0];
    const names = [first, ...(TAG_ALIASES[first] || [])].join("|");
    const bare = body.replace(/<\/?[\w-]+>/g, "").trim().replace(new RegExp(`^(?:${names})\\s*[=:]\\s*`, "i"), "");
    const unquoted = /^(["'])[\s\S]*\1$/.test(bare) && !bare.slice(1, -1).includes(bare[0]) ? bare.slice(1, -1) : bare;
    if (unquoted && !unquoted.includes("\n")) args[first] = unquoted;
  }
  // Short values (a path, a pattern, a glob, a number) are one line: lines that are only a stray tag (</pattern>,
  // </search>, a DSML closer) are dropped, as in a scrambled call seen 2026-10-21 (<glob>x</pattern><pattern>y</glob>).
  for (const k of Object.keys(args)) {
    if (/^(content|new|old|command|questions)$/.test(k)) continue;
    const kept = String(args[k]).split("\n").map((l) => l.trim()).filter((l) => l && !/^<\/?(?:｜DSML｜[^>]*|[\w-]+)>$/.test(l));
    // except a read_file path, which may list several files, one per line
    args[k] = (name === "read_file" && k === "path" ? kept.join("\n") : kept[0]) || "";
  }
  if (unclosed) return { name, args, raw: text.trimEnd() + "\n</tool>" };
  const endTag = text.indexOf("</tool>", head.index + head[0].length + end);
  return { name, args, raw: text.slice(0, endTag >= 0 ? endTag + 7 : text.length) };
}

// Wakes the cloud GPU in the background as soon as yAI Code opens (or switches to a cloud model), so it is
// usually ready by the time the first question is typed. Failures are ignored: the first request wakes it anyway.
function prewarm() {
  const model = state.model;
  if (!/cloud/.test(model) || state.warmed.has(model) || state.warming) return false;
  state.warming = api
    .warmup(model, { signal: AbortSignal.timeout(300000), onProgress: () => {} })
    .then(() => state.warmed.add(model))
    .catch(() => {})
    .finally(() => (state.warming = null));
  return true;
}

async function ensureWarm() {
  if (state.warming) {
    spinner.text("waiting for the cloud GPU to finish waking up");
    await state.warming;
  }
  if (state.warmed.has(state.model)) return;
  spinner.text(`Starting ${modelLabel()}`);
  await api.warmup(state.model, { signal: state.abort.signal, onProgress: (t) => spinner.text(t) });
  state.warmed.add(state.model);
}

// One model reply, streamed to the screen. Stops as soon as a tool call is complete.
async function callModel() {
  spinner.start(state.warmed.has(state.model) ? undefined : `Starting ${modelLabel()}`);
  if (!state.warmed.has(state.model)) {
    await ensureWarm();
    spinner.stop();
    spinner.start();
  }
  trimContext();
  // Still nearly full after trimming (long replies, many edits): summarize and carry on with the task.
  if (usedChars() > contextChars() * AUTO_COMPACT_AT && state.messages.length > 6) {
    spinner.text("compacting the conversation (it was nearly full)");
    try {
      await summarize({ keepRecent: 4, signal: state.abort.signal });
    } catch {}
    spinner.text("thinking");
  }

  const write = ui.markdownWriter();
  let text = "", lineBuf = "", inTool = false, heldFence = null, inPlan = false;
  const emit = (line) => {
    if (inTool) return;
    // The plan the model keeps (see LOOK.PLAN_RULES): shown in the card at the bottom, not in the words.
    if (state.task) {
      const d = /<done>\s*(\d+)\s*<\/done>/.exec(line);
      // A step number past the end of the plan (a model counting its tool calls) is ignored, and progress never goes
      // backwards (2026-10-21: plans of 4 steps were marked "13 done").
      if (d && state.plan) {
        const n = Number(d[1]);
        if (n <= state.plan.steps.length && n >= state.plan.done) state.plan.done = Math.min(n, state.plan.steps.length);
      }
      if (/<offer-fix\s*\/?>/.test(line)) state.task.offerFix = true;
      line = line.replace(/<done>\s*\d+\s*<\/done>|<offer-fix\s*\/?>/g, "");
      if (inPlan || /<plan>/.test(line)) {
        const body = line.replace(/<\/?plan>/g, "");
        if (/<plan>/.test(line)) { inPlan = true; state.plan = { steps: [], done: 0 }; }
        const m = /^\s*\d+[.)]\s+(.+)/.exec(body);
        if (m) state.plan.steps.push(m[1].trim());
        if (/<\/plan>/.test(line)) inPlan = false;
        if (state.plan.steps[state.plan.done]) spinner.text(state.plan.steps[state.plan.done]);
        return;
      }
      if (d && state.plan && state.plan.steps[state.plan.done]) spinner.text(state.plan.steps[state.plan.done]);
      if (!line.trim() && (d || /offer-fix/.test(text.slice(-40)))) return;
    }
    // Kimi K3's own tool-call markers can start mid-line: show the words before them, hide the rest.
    const kimi = line.indexOf("<|open|>tools");
    if (kimi >= 0) {
      if (line.slice(0, kimi).trim()) write(line.slice(0, kimi).trimEnd());
      return void ((inTool = true), (heldFence = null));
    }
    // DeepSeek's (yAI Ultra Flash) tool-call markers, the same way.
    const ds = line.search(DSML_START);
    if (ds >= 0) {
      if (line.slice(0, ds).trim()) write(line.slice(0, ds).trimEnd());
      return void ((inTool = true), (heldFence = null));
    }
    if (/^\s*<tool[\s>]/.test(line)) return void ((inTool = true), (heldFence = null));
    if (heldFence !== null) write(heldFence), (heldFence = null);
    if (/^\s*```[\w-]*\s*$/.test(line)) return void (heldFence = line);
    write(line);
  };

  let seen = 0;
  const local = new AbortController();
  const outer = state.abort;
  const onOuter = () => local.abort();
  outer.signal.addEventListener("abort", onOuter, { once: true });
  if (outer.signal.aborted) local.abort(); // stopped already (a listener added now would never fire)
  try {
    const price = state.models.find((m) => m.id === state.model)?.price; // US$ per million tokens (yAI Ultra)
    const promptTokens = usedChars() / 3.6;
    const { usage, cost, fallback } = await api.chat({
      messages: state.messages,
      model: state.model,
      system: systemPrompt() + (state.crewActive ? CREW_PROMPT() : ""),
      context: envContext() + (TEAM_AGENT || state.crewActive ? attemptBlock() : ""),
      tools: nativeTools(),
      toolFormat: toolFormat(),
      conversationId: state.conversationId,
      signal: local.signal,
      onStatus: (status) => {
        if (!seen) spinner.text(status);
      },
      onTokens: (n) => {
        if (!seen) spinner.text("writing");
        seen = n;
        spinner.tokens(n);
        // What this reply is costing so far (an estimate; the site sends the real figure at the end).
        if (price) spinner.extra(`~$${((promptTokens * price.in + n * price.out) / 1e6).toFixed(3)}`);
      },
      onText: (piece) => {
        // DeepSeek's own API writes <｜｜DSML｜｜ …> with doubled bars where Modal's endpoint writes <｜DSML｜ …>
        // (2026-10-22); both become the single form the parser knows. A tag split across pieces is caught once whole.
        text = (text + piece).replace(DSML_BARS, "｜DSML｜");
        lineBuf = (lineBuf + piece).replace(DSML_BARS, "｜DSML｜");
        let i;
        while ((i = lineBuf.indexOf("\n")) !== -1) {
          emit(lineBuf.slice(0, i).replace(/\r$/, ""));
          lineBuf = lineBuf.slice(i + 1);
        }
        // Show long paragraphs as they arrive, wrapped at the terminal width. Not for the VS Code panel or a /team agent
        // (--stdio): whatever shows it wraps it again at its own width, and pre-cut lines broke mid-sentence there.
        const width = ui.textWidth();
        // (a table row is never cut: it's drawn whole once the table ends)
        while (!state.stdio && !inTool && lineBuf.length > width && !/^\s*(<|```|\|)/.test(lineBuf) && !lineBuf.includes("<|")) {
          const cut = lineBuf.lastIndexOf(" ", width);
          if (cut < width / 2) break;
          emit(lineBuf.slice(0, cut));
          lineBuf = lineBuf.slice(cut + 1);
        }
        if (text.includes("<|close|>tools")) return false; // Kimi K3's tool call is complete
        // DeepSeek's tool call is complete (it may close its own markup with </tool>, or yAI's with its own closer)
        const ds = text.search(DS_MARK);
        if (ds >= 0 && CALL_END.test(text.slice(ds))) return false;
        const ts = text.search(/(^|\n)[ \t]*<tool[\s>]/);
        if (ts >= 0) {
          const after = text.slice(ts);
          if (/\n[ \t]*<\/tool>[ \t]*(\r?\n|$)/.test(after) || after.includes("<tool_result")) return false;
        }
      },
    });
    state.usage.out += usage?.out ?? seen; // a reply cut at a tool call has no final usage event
    if (fallback) state.fallbacks = (state.fallbacks || 0) + 1; // replies from the fallback model (the /team board shows them)
    if (cost) {
      state.cost.session += cost.usd;
      if (cost.todayUsd != null) state.cost.todayUsd = cost.todayUsd;
      if (cost.limitUsd != null) state.cost.limitUsd = cost.limitUsd;
    } else if (price) {
      // Cut short at a tool call, so no real figure: estimate it. The part of the prompt the last request already
      // sent is billed at the cached price (2026-10-22: counting it all at full price showed /team costs ~3x too high).
      const cached = Math.min(state.lastPromptTokens || 0, promptTokens);
      state.cost.session += ((promptTokens - cached) * price.in + cached * (price.cached ?? price.in) + (usage?.out ?? seen) * price.out) / 1e6;
    }
    state.lastPromptTokens = promptTokens;
    state.teamTokens = (state.teamTokens || 0) + Math.round(promptTokens) + (usage?.out ?? seen); // for the /team board
    // new vs cached, for the /team efficiency report (the real counts when the final event came, else estimated)
    const inT = usage?.in ?? Math.round(promptTokens), cachedT = usage?.cached ?? (usage ? 0 : Math.min(state.lastPromptTokensPrev || 0, Math.round(promptTokens)));
    state.teamUsage = state.teamUsage || { new: 0, cached: 0, out: 0, real: 0, steps: 0 };
    state.teamUsage.new += Math.max(0, inT - cachedT); state.teamUsage.cached += cachedT; state.teamUsage.out += usage?.out ?? seen;
    state.teamUsage.steps++; if (usage?.in != null) state.teamUsage.real++;
    state.lastPromptTokensPrev = Math.round(promptTokens);
    seen = 0;
  } catch (err) {
    if (!state.interrupted) {
      spinner.stop();
      if (lineBuf) emit(lineBuf);
      write.end();
      throw err;
    }
  } finally {
    state.usage.out += seen;
    outer.signal.removeEventListener("abort", onOuter);
    local.abort(); // closes the stream; the server then stops the model
  }
  if (lineBuf && !state.interrupted) emit(lineBuf.replace(/\r$/, ""));
  if (heldFence !== null && !inTool) write(heldFence);
  write.end();
  if (process.env.YAI_DEBUG_DIR) {
    try { fs.writeFileSync(path.join(process.env.YAI_DEBUG_DIR, `reply-${Date.now()}.txt`), text); } catch {}
  }
  return fromDeepSeek(fromKimi(text));
}

// DeepSeek V4.1 Flash (yAI Ultra Flash) writes tool calls in its own markup (DSML, with full-width bars), e.g.
//   <｜DSML｜ calls><｜DSML｜ invoke name="write_file"><｜DSML｜ parameter name="path" string="true">snake.html</｜DSML｜ parameter>…
//   </｜DSML｜ invoke></｜DSML｜ calls>
// It becomes the usual <tool> block. A call cut off before </…invoke> is left without </tool>, so it counts as cut off.
// In practice it mixes its markup with yAI's (seen 2026-10-21 in real replies): a DSML invoke holding <path>…</path>
// tags, <｜DSML｜ parameter name="path"> closed by </path>, a <tool name="run"> holding <parameter name="command"> and
// closed by </｜DSML｜ invoke>, a DSML invoke closed by </tool>. So any opener and any closer are accepted.
// The DSML grammar (vLLM's DeepSeek V3.2/V4 parsers): <｜DSML｜tool_calls> (V3.2: function_calls) holding
// <｜DSML｜invoke name="…"> with <｜DSML｜parameter name="…" string="true|false">…</｜DSML｜parameter>; V4.1 Flash puts
// spaces inside the tags (<｜DSML｜ invoke …>), which broke vLLM's own V4 parser too (2026-10).
// A reply can be DSML only by its closers (it opened with yAI's <tool name="write_file"> and closed with
// </｜DSML｜ parameter></｜DSML｜ invoke>, 2026-10-21), so closers count as DSML too. A </tool> only ends a call on a
// line of its own, so file text that mentions </tool> doesn't end it early.
const DSML_BARS = /｜{2,}DSML｜+|｜+DSML｜{2,}/g;
const DSML_START = /<｜DSML｜\s*(?:function_|tool_)?calls>|<｜DSML｜\s*invoke\b/;
const DS_MARK = /<\/?｜DSML｜|<parameter\s+name\s*=/;
const DSML_END = /<\/｜DSML｜\s*(?:invoke|(?:function_|tool_)?calls)>/;
const CALL_END = /<\/｜DSML｜\s*(?:invoke|(?:function_|tool_)?calls)>|(?:^|\n)[ \t]*<\/tool>/;
function fromDeepSeek(text) {
  if (!DS_MARK.test(text)) return text;
  const head = /<｜DSML｜\s*invoke\s+name\s*=\s*["']?([\w-]+)["']?[^>]*>|(^|\n)[ \t]*<tool\s+name\s*=\s*["']?([\w-]+)["']?[^>]*>/.exec(text);
  const calls = text.search(/<｜DSML｜\s*(?:function_|tool_)?calls>/);
  if (!head) return calls >= 0 ? text.slice(0, calls).trimEnd() : text;
  const name = head[1] || head[3];
  const headAt = head.index + (head[2] || "").length;
  const before = text.slice(0, calls >= 0 && calls < headAt ? calls : headAt).trimEnd();
  let body = text.slice(head.index + head[0].length);
  const end = DSML_END.exec(body) || /(?:^|\n)[ \t]*<\/tool>/.exec(body);
  if (end) body = body.slice(0, end.index);
  // Arguments: <｜DSML｜ parameter name="k">, <parameter name="k"> or <k>, each closed by any of their closers. The
  // quotes are optional: in long sessions it writes <｜DSML｜ parameter name="path> (2026-10-21), and a missed opener
  // made the file text's own tags (a <model> in code) look like arguments.
  const OPEN = /<｜DSML｜\s*parameter\s+name\s*=\s*["']?([\w-]+)["']?[^>]*>|<parameter\s+name\s*=\s*["']?([\w-]+)["']?[^>]*>|<([a-z_][\w-]*)>/g;
  const args = [];
  let m, cut = false, cutKey = "";
  while ((m = OPEN.exec(body))) {
    const key = m[1] || m[2] || m[3];
    cutKey = key;
    const from = OPEN.lastIndex;
    let stop = -1, len = 0;
    const closer = new RegExp(`<\\/｜DSML｜\\s*parameter>|<\\/parameter>|<\\/${key}>`, "g");
    closer.lastIndex = from;
    const cm = closer.exec(body);
    if (cm) { stop = cm.index; len = cm[0].length; }
    if (stop < 0) {
      if (!end) { cut = true; break; } // the reply ended inside this argument
      stop = body.length;
    }
    const raw = body.slice(from, stop);
    const v = /^(content|new|old|new_str|old_str|text)$/.test(key) ? raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "") : raw.trim();
    args.push(`<${key}>\n${v}\n</${key}>`);
    OPEN.lastIndex = stop + len;
  }
  // No argument tags: the arguments may be written as JSON inside the call.
  const json = !args.length && /^\s*\{[\s\S]*\}\s*$/.test(body) ? body.trim() : "";
  // cut off inside an argument: its opening tag stays, unclosed, so parseToolCall sees the call isn't finished
  return `${before}\n\n<tool name="${name}">\n${args.join("\n") || json}${cut ? `\n<${cutKey}>\n` : end ? "\n</tool>" : ""}`;
}

// Kimi K3 (yAI Ultra) writes tool calls in its own format even when asked for <tool> blocks:
//   <|open|>tools<|sep|><|open|>call tool="list_files" index="1"<|sep|><|open|>argument key="path" type="string"<|sep|>calculator<|close|>argument<|sep|>…
// It becomes the usual <tool> block, so parsing, display and the saved conversation work the same way.
function fromKimi(text) {
  const start = text.indexOf("<|open|>tools");
  if (start < 0) return text;
  const block = text.slice(start);
  const call = /<\|open\|>call tool="([\w-]+)"[^<]*<\|sep\|>([\s\S]*?)(?:<\|close\|>call|$)/.exec(block);
  const before = text.slice(0, start).trimEnd();
  if (!call) return before;
  const args = [...call[2].matchAll(/<\|open\|>argument key="([\w-]+)"[^<]*<\|sep\|>([\s\S]*?)<\|close\|>argument/g)];
  const body = args.map(([, key, value]) => `<${key}>\n${value}\n</${key}>`).join("\n");
  return `${before}\n\n<tool name="${call[1]}">\n${body}\n</tool>`;
}

// "Run this command?" in a box: › 1 Yes · 2 Yes, and don't ask again … · 3 No, tell yAI what to do instead.
async function askPermission(title, alwaysLabel, detail, look) {
  spinner.stop();
  const options = ["Yes", alwaysLabel, "No, tell yAI what to do instead"];
  const editPlan = state.pendingEdit;
  state.pendingEdit = null;
  let i;
  if (state.askHook) i = await state.askHook({ title, detail, options, edit: editPlan });
  else if (look && process.stdout.isTTY) {
    // the v2 card: its keys map back to yes / always / no
    const keys = look.keys;
    const j = await select({ ...look, detail, options: keys.map((k) => k[1]), keys: keys.map((k) => k[0]), render: (o) => LOOK.approveLines({ ...look, detail, options: keys, selected: o.selected }) });
    const k = j >= 0 ? keys[j][0] : "n";
    i = k === "y" ? 0 : k === "a" ? 1 : j < 0 ? -1 : 2;
  } else i = await select({ title, detail, options });
  if (i === 0) return "yes";
  if (i === 1) return "always";
  if (i < 0 || state.askHook) return { no: true, feedback: "" };
  const fb = await question(`   ${c.accent("›")} ${c.ink("What should yAI do instead?")} ${c.faint("(Enter to just stop)")} `);
  return { no: true, feedback: (fb || "").trim() };
}

function commandPrefix(cmd) {
  const words = cmd.trim().split(/\s+/);
  return words.length > 1 && !words[1].startsWith("-") ? `${words[0]} ${words[1]}` : words[0];
}

// Runs one tool call and returns { output, stop }.
async function execTool(call) {
  ctx.budget = toolBudget();
  const tool = T.tools[call.name];
  if (!tool) return { output: `Error: unknown tool "${call.name}". Available: ${Object.keys(T.tools).join(", ")}.` };
  spinner.stop();
  try {
    if (tool.readOnly) {
      const doing = { read_file: "reading", list_files: "listing files", find_files: "finding files", search: "searching the files" }[call.name];
      if (doing) spinner.start(doing);
      if (state.task) call.name === "read_file" ? state.task.reads++ : state.task.searches++;
      try {
        return { output: await tool.run(ctx, call.args) };
      } finally {
        if (doing) spinner.stop();
      }
    }

    // MCP tools: read-only ones (the server says so) run straight away; others ask first, like commands.
    if (tool.kind === "mcp") {
      const shownArgs = Object.entries(call.args || {}).map(([k, v]) => `${k}=${String(v).replace(/\s+/g, " ").slice(0, 40)}`).join(" ");
      ui.toolHeader(`MCP ${tool.server}`, `${tool.tool}${shownArgs ? " " + shownArgs : ""}`);
      if (!tool.readOnlyHint) {
        if (state.mode === "plan" || (state.printMode && !state.allowCommands)) {
          ui.toolResult("Not allowed here (read-only)", { color: c.yellow });
          return { output: "Not allowed: read-only mode. Only MCP tools marked read-only can run." };
        }
        const allowedMcp = project().mcpAllowed || [];
        if (!state.printMode && state.mode !== "yolo" && !allowedMcp.includes(call.name)) {
          ui.cancelRow();
          const ans = await askPermission("Use this MCP tool?", "Yes, and don't ask again for this tool", `${tool.server} · ${tool.tool}`, {
            title: "Can I use this tool?", explain: `It comes from the ${tool.server} MCP server, and it may change things outside this folder.`, tag: "MCP", tagFill: "soft",
            keys: [["y", "Yes, use it"], ["a", "Always allow it"], ["n", "No"]],
          });
          if (ans.no) return rejected(ans);
          if (ans === "always") {
            project().mcpAllowed = [...allowedMcp, call.name];
            api.save();
          }
          ui.toolHeader(`MCP ${tool.server}`, tool.tool);
        }
      }
      spinner.start("waiting for the tool");
      let text;
      try {
        text = await tool.call(call.args || {});
      } catch (err) {
        spinner.stop();
        ui.toolResult(err.message, { color: c.red, quiet: true });
        return { output: `Error: the MCP tool failed: ${err.message}` };
      }
      spinner.stop();
      const lines = text.split("\n");
      ui.toolResult(lines.slice(0, 3).join("\n") + (lines.length > 3 ? `\n… ${lines.length - 3} more lines` : ""), { color: text.startsWith("Error") ? c.red : undefined, quiet: true, summary: `${lines.length} line${lines.length === 1 ? "" : "s"}` });
      return { output: T.clipOutput(text, ctx.budget) };
    }

    // ask_user: a small form of questions; the answers go back to the model.
    if (tool.kind === "ask") {
      let questions;
      try {
        const raw = String(call.args.questions || "").trim().replace(/^```\w*\n?|```$/g, "");
        questions = (JSON.parse(raw) || []).slice(0, 4).map((q, i) => ({
          header: ui.clip(String(q.header || `Question ${i + 1}`), 18),
          question: String(q.question || q.header || ""),
          options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o) => (typeof o === "string" ? { label: o } : { label: String(o.label || ""), description: String(o.description || "") })).filter((o) => o.label),
        })).filter((q) => q.question && q.options.length);
      } catch {
        throw new T.ToolError('<questions> must be JSON: [{"header":"…","question":"…","options":[{"label":"…","description":"…"}]}]');
      }
      if (!questions.length) throw new T.ToolError("Give at least one question with options.");
      if (state.printMode) return { output: "No one is here to answer. Decide yourself, and say what you assumed." };
      const res = await askForm(questions);
      if (res.chat) {
        ui.note(c.dim("the questions are set aside · tell yAI what you think"));
        return { output: "The user wants to talk this over before answering. Stop here and wait for their message.", stop: true };
      }
      if (!res.answers) {
        ui.note(`${c.yellow("■")} ${c.dim("questions dismissed")}`);
        return { output: "The user dismissed the questions. Stop and wait for their next message.", stop: true };
      }
      const lines = questions.map((q, i) => `- ${q.header}: ${res.answers[i] ? res.answers[i].label : "(no answer)"}`);
      ui.note(`${c.green("✓")} ${c.dim("answered · " + questions.map((q, i) => `${q.header}: ${res.answers[i] ? res.answers[i].label : "—"}`).join(" · "))}`);
      return { output: `The user answered:\n${lines.join("\n")}` };
    }

    // /team's checkers may run checks that change nothing (a syntax check, the tests, a linter) without asking: one
    // plain command, judged read-only by the same rules as the approval cards. The read-only roles (YAI_REPORT_ONLY)
    // and the tester, docs writer and fixer (YAI_SAFE_CHECKS) get this.
    if ((process.env.YAI_REPORT_ONLY || process.env.YAI_SAFE_CHECKS) && tool.kind === "run") {
      const command = String(call.args.command || "").trim();
      // one plain command, or several joined by ; or && where every part is read-only on its own
      const parts = command.split(/\s*(?:;|&&)\s*/).filter(Boolean);
      const plain = (p) => !/[;&|`><]|\$\(/.test(p) && LOOK.riskOf(p).tag === "read-only";
      if (command && parts.length <= 8 && parts.every(plain) && String(call.args.background || "").trim() !== "true") {
        ui.toolHeader(process.platform === "win32" ? "PowerShell" : "Bash", command);
        return { output: await T.execRun(ctx, call.args, state.abort.signal) };
      }
    }

    if (state.mode === "plan" || (state.printMode && !state.allowEdits)) {
      ui.toolHeader(tool.kind === "run" ? "Shell" : "Edit", call.args.path || call.args.command || "");
      ui.toolResult(state.printMode ? "Not allowed here (read-only)" : "Skipped: plan mode is on", { color: c.yellow });
      return { output: "Not allowed: read-only mode. Do not edit files or run commands. Investigate with read-only tools, then describe your plan or answer." };
    }

    if (tool.kind === "edit" && state.tutor) {
      ui.toolHeader("Edit", call.args.path || "");
      ui.toolResult("Skipped: tutor mode is on", { color: c.yellow });
      return { output: "Not allowed in tutor mode: the student writes the code. Point them to the place and give a hint instead." };
    }

    if (tool.kind === "edit") {
      const plan = tool.prepare(ctx, call.args);
      if (plan.before === plan.after) return { output: "No change: the new content is the same as the old." };
      const name = path.basename(plan.abs);
      const counts = T.showEdit(ctx, plan) || { added: 0, removed: 0 };
      if (state.mode !== "acceptEdits" && state.mode !== "yolo") {
        state.pendingEdit = plan; // the phone and VS Code show the change itself
        const ans = await askPermission(plan.created ? `Create ${name}?` : `Apply this edit to ${name}?`, "Yes, and apply edits without asking", "", {
          title: plan.created ? `Can I create ${name}?` : `Can I change ${name}?`,
          explain: plan.created ? `A new file, ${counts.added} line${counts.added === 1 ? "" : "s"}. It's shown above.` : `${counts.added} line${counts.added === 1 ? "" : "s"} added and ${counts.removed} removed, shown above. /undo puts it back.`,
          keys: [["y", plan.created ? "Yes, create it" : "Yes, apply it"], ["a", "Always, this session"], ["n", "No"]],
        });
        if (ans.no) return rejected(ans);
        if (ans === "always") state.mode = "acceptEdits";
      }
      state.undo.push({ abs: plan.abs, before: plan.before, created: plan.created });
      T.applyEdit(ctx, plan);
      if (state.task) {
        const f = relPath(plan.abs), was = state.task.files.get(f) || { a: 0, d: 0 };
        state.task.files.set(f, { a: was.a + counts.added, d: was.d + counts.removed });
      }
      ui.note(`${c.green("✓")} ${c.dim(plan.created ? "created · 1 new file" : "applied · 1 file changed")}`);
      return { output: `${plan.created ? "Created" : "Updated"} ${relPath(plan.abs)}.` };
    }

    // Shell commands
    const command = (call.args.command || "").trim();
    if (!command) throw new T.ToolError("<command> is required. Put the command between the tags, e.g. <command>node --test</command>");
    // Paths inside the project are shown relative to it, so the row shows the file, not C:\Users\…
    const shownCommand = command.split(ctx.root + path.sep).join("").split(ctx.root).join(".");
    ui.toolHeader(process.platform === "win32" ? "PowerShell" : "Bash", shownCommand);
    const chained = /[;&|`><]|\$\(/.test(command);
    const allowed = !state.printMode && !chained && (SAFE_COMMANDS.test(command) || project().allowedCommands.includes(commandPrefix(command)));
    if (state.printMode && !state.allowCommands) {
      ui.toolResult("Not allowed here", { color: c.yellow });
      return { output: "Running commands isn't allowed in this mode." };
    }
    if (!allowed && state.mode !== "yolo" && !(state.printMode && state.allowCommands)) {
      // The question shows the command, so the waiting step row is dropped and redrawn after.
      ui.cancelRow();
      const prefix = commandPrefix(command);
      const risk = LOOK.riskOf(command);
      const ans = await askPermission("Run this command?", chained ? "Yes, this once" : `Yes, and don't ask again for ${prefix}`, shownCommand, {
        title: LOOK.approveTitle(command), explain: risk.explain, tag: risk.tag, tagFill: risk.fill,
        keys: chained ? [["y", "Yes, run it"], ["n", "No, skip"]] : [["y", "Yes, run it"], ["a", `Always allow ${prefix}`], ["n", "No, skip"]],
      });
      if (ans.no) return rejected(ans);
      if (ans === "always" && !chained) {
        project().allowedCommands.push(prefix);
        api.save();
      }
      ui.toolHeader(process.platform === "win32" ? "PowerShell" : "Bash", shownCommand);
    }
    if (String(call.args.background || "").trim() === "true") return { output: await T.startBackground(ctx, command) };
    return { output: await T.execRun(ctx, call.args, state.abort.signal) };
  } catch (err) {
    spinner.stop();
    if (!(err instanceof T.ToolError) && !err.code) throw err;
    const shown = { read_file: "Read", list_files: "List", find_files: "Find", search: "Search", edit_file: "Update", write_file: "Write", run: "Bash" };
    ui.toolHeader(shown[call.name] || call.name, call.args.path || call.args.pattern || call.args.command || "(nothing given)");
    ui.toolResult(err.message, { color: c.red, quiet: true });
    return { output: `Error: ${err.message}` };
  }
}

function rejected(ans) {
  ui.note(`${c.red("✕")} ${c.dim("declined")}` + (ans.feedback ? c.dim(` · ${ans.feedback}`) : ""));
  if (!ans.feedback) return { output: "The user rejected this action and wants you to stop. Wait for their next instruction.", stop: true };
  return { output: `The user rejected this action and said: ${ans.feedback}` };
}

// A reply whose last line says what it's about to do ("Let me read app.js:", "Now I'll write the CSS.") but has no
// tool call. Questions and finished summaries don't count.
function announcesStep(text) {
  const last = String(text).trim().split("\n").filter((l) => l.trim()).pop() || "";
  if (/\?\s*$/.test(last)) return false;
  return /:\s*$/.test(last) || /\b(let me|let's|(now|next|first|then),? (i'll|i will|i'm going to|let me))\b/i.test(last);
}

// Runs a full request: model reply → tool → model reply … until the model answers without a tool.
// /crew: what the main chat knows about its background agents
const CREW_PROMPT = () => `

# Your crew (/crew)
You can hand separate pieces of work to background agents with the commission tool, when you like: a self-contained module or data behind an interface you specify, sound, sprites or textures, research, a QA pass (role qa: it reviews the project like a user or player and reports problems) or tests (role tester). Give each one everything it needs in <task> and the files it owns; pick model lite for a simple, mechanical job and flash for one that needs thought. At most ${state.crewMax || 4} work at once. They work while you go on; their reports reach you after your steps, or call crew_wait. Keep the core yourself, don't commission what takes you a few steps, and before you finish call crew_wait and fit in their work. A watcher looks over you and them: follow its instructions.`;
async function runAgent(content) {
  // /crew: reports from background agents that finished while this chat was idle open its next turn
  if (ctx.crew?.reports.length) content = ctx.crew.reports.splice(0).map((x) => `Your background agent "${x.name}" has finished. Its report:\n${x.report}`).join("\n\n") + "\n\n" + content;
  pushUser([...state.pendingContext, content].join("\n\n"));
  state.pendingContext = [];
  state.busy = true;
  state.interrupted = false;
  state.abort = new AbortController();
  syncMute();
  const started = Date.now();
  const startOut = state.usage.out;
  print("");
  ui.resetSections();
  let cutOffs = 0; // replies in a row that were cut off mid-step
  let lastError = "", sameError = 0; // the same tool error repeated back to back
  let failedRuns = 0; // commands in a row that failed
  const failedCommands = new Set();
  const doneSteps = new Map(); // look-only step + what had changed when it ran -> its step number
  // Long files read whole (over 300 lines, no range), with the file's time then: path -> mtime. Only for /team agents
  // (they trim old file contents early); see the repeat guard.
  const readWhole = new Map();
  const wholeOf = (call) => {
    if (!TRIM_TOKENS || call.name !== "read_file" || call.args?.offset) return [];
    return T.splitPaths(call.args?.path, root).filter((p) => !/:\d+(-\d+)?$/.test(p.trim())).map((p) => {
      try {
        const abs = path.resolve(root, p.trim());
        const st = fs.statSync(abs);
        return st.size > 9000 && fs.readFileSync(abs, "utf8").split("\n").length > 300 ? { p: p.trim(), abs, mtime: st.mtimeMs } : null;
      } catch { return null; }
    }).filter(Boolean);
  };
  const noteWhole = (call) => { for (const f of wholeOf(call)) readWhole.set(f.abs, f.mtime); };
  const wholeAgain = (call) => { const hit = wholeOf(call).filter((f) => readWhole.get(f.abs) === f.mtime).map((f) => f.p); return hit.length ? hit : null; };
  // The lines of each file read so far, while their text is still in the conversation: abs -> { mtime, have: [[from,
  // to, step entry]] }. A read inside lines already there isn't run again (2026-10-22: mergers re-read overlapping
  // ranges, 120-180 then 100-200 then 150-170, that the exact-repeat check let through).
  const readRanges = new Map();
  const rangesOf = (call) => {
    if (call.name !== "read_file" || call.args?.offset || call.args?.limit) return [];
    const paths = T.splitPaths(call.args?.path, root).slice(0, 8); // read_file reads the first 8
    return paths.map((p) => {
      const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(p.trim());
      try {
        const abs = path.resolve(root, m[1]);
        // read_file's own limits: a whole read shows 600 lines, or 400 each when several files are read at once
        const from = m[2] ? +m[2] : 1;
        return { p: p.trim(), abs, mtime: fs.statSync(abs).mtimeMs, from, to: Math.min(from + 1999, m[2] ? (m[3] ? +m[3] : from + 199) : paths.length > 1 ? 400 : 600) };
      } catch { return null; }
    }).filter(Boolean);
  };
  const stillThere = (ref) => ref?.msg && state.messages.includes(ref.msg) && !/old tool output removed/.test(String(ref.msg.content || ""));
  const haveLines = (call) => {
    const rs = rangesOf(call);
    if (!rs.length) return null;
    const hits = rs.map((r) => {
      const f = readRanges.get(r.abs);
      const h = f && f.mtime === r.mtime && f.have.find(([a, b, ref]) => a <= r.from && b >= r.to && stillThere(ref));
      return h && { p: r.p, step: h[2].step };
    });
    return hits.every(Boolean) ? hits : null;
  };
  const noteRanges = (call, ref) => {
    for (const r of rangesOf(call)) {
      let f = readRanges.get(r.abs);
      if (!f || f.mtime !== r.mtime) readRanges.set(r.abs, (f = { mtime: r.mtime, have: [] }));
      f.have.push([r.from, r.to, ref]);
    }
  };
  let reads = 0; // /team agents: reads and searches before their first change
  let refusedInRow = 0; // steps refused as repeats, one after another
  let crewHolds = 0; // /crew: times the chat was held to wait for its background agents
  // the watcher's directive in force: { text, block: ["check_page", "read:<path>", "edits-only"], left: steps, ack: false }
  let directive = null, awaitingAck = false;
  // is this step blocked by it? A read block ends when the file is edited, "edits-only" with the first edit.
  const blockedBy = (call) => {
    if (!directive || directive.left <= 0) return "";
    const arg = call.args || {}, target = String(arg.path || arg.pattern || arg.command || "").replace(/\\/g, "/");
    for (const b of directive.block) {
      if (b === "edits-only" && !directive.edited && LOOK_STEPS.has(call.name) || b === "edits-only" && !directive.edited && ["check_page", "page_eval"].includes(call.name)) return "edits only: make your change now, no more looking first";
      if (b.startsWith("read:") && !directive.editedPaths?.has(b.slice(5)) && ["read_file", "search"].includes(call.name) && target.includes(b.slice(5))) return `no reading ${b.slice(5)} again until you change it`;
      if (!b.includes(":") && b !== "edits-only" && call.name === b) return `no ${b} for now`;
    }
    return "";
  };
  const recentProse = []; let textRepeats = 0, repeatTextNow = false; // the same reasoning written again
  const sameRuns = new Map(); // a command's first 60 characters -> { n: times run, undo: changes made by then }
  let planAt = -1, planSteps = 0; // the plan step being worked on, and tool calls made on it
  let repeats = 0; // look-only steps asked for again with nothing changed
  let resultOf = null; // this step's doneSteps entry, to remember which message holds its result
  let lastUndo = state.undo.length, idle = 0; // /team agents: steps since their last change
  const undoStart = state.undo.length;
  const costStart = state.cost.session;
  state.task = { files: new Map(), tests: null, failure: null, offerFix: false, reads: 0, searches: 0 };
  state.plan = null;
  if (process.stdout.isTTY && !state.stdio) ui.setLive(() => (panelOpen() ? [] : LOOK.planLines(state.plan, { files: state.task.files })));
  let reviewed = false;
  let nudges = 0; // replies that announced a step but stopped before it
  let emptyRetried = false; // an empty reply gets one quiet retry
  let planReady = false; // plan mode finished with a plan: ask to go ahead
  try {
    // /duo: the partner model's plan goes in with the request.
    if (state.duo && !state.tutor) {
      spinner.start("planning");
      const plan = await X.duoPlan(content);
      spinner.stop();
      if (plan) pushUser(plan);
    }
    for (let step = 0; step < MAX_STEPS; step++) {
      // paused from the /team board: wait here, between steps, until it's resumed or stopped
      while (state.paused && !state.interrupted) await new Promise((r) => setTimeout(r, 250));
      if (state.interrupted) { print(c.yellow("   ■ stopped")); return; }
      const text = await callModel();
      teamProgress();
      spinner.stop();
      if (state.interrupted) {
        if (text.trim()) state.messages.push({ role: "assistant", content: text });
        print(c.yellow("   ■ stopped") + c.dim(" · what should yAI do instead?"));
        return;
      }
      // An empty reply usually means the conversation no longer fits the model; say so instead of
      // ending silently.
      if (!text.trim()) {
        // the shared endpoint sometimes sends back nothing once; one quiet retry before giving up (2026-10-21)
        if (!emptyRetried && contextPercent() < 85) {
          emptyRetried = true;
          ui.note(c.dim("· the model sent back nothing · asking again"));
          step--;
          continue;
        }
        state.messages.push({ role: "assistant", content: "(no reply)" });
        if (TEAM_AGENT) ui.event({ type: "error", message: "the model sent back nothing, twice" });
        const full = contextPercent() >= 85;
        ui.note(`${c.yellow("!")} ${c.ink("No reply from the model.")} ${c.dim(full ? "The conversation is too long for it: /compact, /clear, or a bigger model with /model." : "Try again, or pick another model with /model.")}`);
        break;
      }
      emptyRetried = false; // a reply came: the next empty one gets its own quiet retry
      const call = parseToolCall(text);
      if ((TEAM_AGENT || state.crewActive) && awaitingAck) {
        awaitingAck = false;
        if (!/^\W*following the watcher/i.test(text.trim())) ui.event({ type: "directive-ignored" });
      }
      // The same reasoning written again (2026-10-22: a takeover agent wrote "the atlas is 256×256… this is correct"
      // paragraph after paragraph): what it says before its tool call, compared with its last few replies.
      if (TEAM_AGENT) {
        const prose = text.slice(0, Math.max(0, text.search(/<tool[\s>]|<｜|<\|/) === -1 ? text.length : text.search(/<tool[\s>]|<｜|<\|/))).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
        const grams = new Set(prose.split(" ").map((w, i, all) => all.slice(i, i + 3).join(" ")).filter((g) => g.split(" ").length === 3));
        const same = grams.size >= 25 && recentProse.some((p) => { let n = 0; for (const g of grams) if (p.has(g)) n++; return n / Math.min(grams.size, p.size) >= 0.6; });
        if (same) { textRepeats++; ui.event({ type: "repeat-text", count: textRepeats }); }
        if (grams.size >= 25) { recentProse.push(grams); if (recentProse.length > 4) recentProse.shift(); }
        repeatTextNow = same;
      }
      state.messages.push({ role: "assistant", content: call && call.raw ? call.raw : text });
      if (!call && state.crewActive && ctx.crew?.open.size && crewHolds < 2 && !state.interrupted) {
        crewHolds++;
        pushUser(`Your background agents are still working (${[...ctx.crew.open].join(", ")}). Call crew_wait for them, fit in their work, and then finish.`);
        continue;
      }
      if (!call) {
        // "Now I'll create the CSS file:" and then nothing: the model said what it would do and ended its reply
        // without the tool call (yAI 3 Coder does this a lot). Push it on, at most twice per request.
        if (announcesStep(text) && nudges < 2) {
          nudges++;
          ui.note(c.dim("· it stopped before the step it described · continuing"));
          pushUser("Go ahead: make that tool call now, without repeating what you're about to do.");
          continue;
        }
        // /duo: the partner reviews what changed, and anything it finds goes back to the coder once.
        if (state.duo && !reviewed && !state.interrupted) {
          reviewed = true;
          const fixes = await X.duoReview(content, undoStart);
          if (fixes) {
            pushUser(fixes);
            continue;
          }
        }
        break;
      }
      let result;
      resultOf = null;
      if (call.cutOff) {
        // No </tool>: either the reply really hit its length limit (a long one), or a small model simply
        // stopped without finishing the step (a short one). They need different advice. Two in a row
        // and yAI stops, so a model stuck on the same mistake can't loop.
        const long = text.length > 6000;
        cutOffs++;
        if (cutOffs >= 2) {
          state.messages[state.messages.length - 1].content = long ? "(my reply was cut off again)" : "(I didn't finish that step again)";
          if (TEAM_AGENT) ui.event({ type: "error", message: long ? "its reply was cut off twice" : "it twice wrote a step without finishing it" });
          ui.note(`${c.yellow("!")} ${c.ink(long ? "yAI's reply was cut off twice: it tried to write more than one reply can hold." : "yAI twice wrote a step without finishing it.")} ${c.dim(long ? "Ask for something shorter, or use a bigger model (/model)." : "Small models do this; try a bigger one (/model).")}`);
          break;
        }
        result = {
          output: long
            ? `Error: your ${call.name} call was cut off before it was closed because the reply hit its length limit, so nothing was written. Don't repeat it. Write the content in parts of at most 60 lines: write_file with the first part, then write_file with append set to true for each next part. If the user only asked for text (an answer, an essay, an explanation), just reply with it instead of writing a file.`
            : `Error: your ${call.name} call isn't finished: it was never closed, so nothing happened. Write the whole step again in the tool-call format from your instructions, with every tag opened and closed (for edit_file: path, then old, then new) and the call closed at the end.`,
        };
        ui.note(`${c.yellow("!")} ${c.dim(long ? "that step was cut off · asking yAI to split it up" : "that step wasn't finished · asking yAI to write it again")}`);
      } else {
        cutOffs = 0;
        // "Nothing changed" = none of yAI's own edits since, and (for a file) the file on disk is untouched, since
        // another /team agent may have written it.
        let sig = "";
        if (LOOK_STEPS.has(call.name)) {
          let mtime = "";
          if (call.name === "read_file") mtime = T.splitPaths(call.args?.path, root).map((p) => { try { return fs.statSync(path.resolve(root, p.trim().replace(/:\d+(-\d+)?$/, ""))).mtimeMs; } catch { return 0; } }).join(",");
          sig = `${call.name} ${JSON.stringify(call.args || {})} @${state.undo.length} ${mtime}`;
        }
        // A result that was trimmed away (trimContext) may be run again: its text is gone. What stops a reader thrashing
        // (2026-10-22: a reviewer read a whole game, had it trimmed, re-read it… 48 reads; a merger on a 6,000-line
        // Minecraft clone was refused the files it needed and stopped) is the rule below: a long file read whole is
        // never read whole again unless it changed; the agent is pointed to the lines it needs instead.
        const before = sig && doneSteps.get(sig);
        const lost = before && !stillThere(before); // trimmed, or summarized away with the old messages
        const again = !before || lost ? wholeAgain(call) : null;
        const everything = call.name === "search" && /^\s*(\^?\.[*+]?\$?|\^|\$|\\[sSwW][*+]?|\[\\s\\S\][*+]?)?\s*$/.test(String(call.args?.pattern ?? ""));
        const inside = !(before && !lost) && !again && !everything ? haveLines(call) : null;
        // the same command with small changes, over and over (2026-10-22: a /team fixer ran 20+ node -e scripts that all
        // began the same way, each a little different, and never edited anything): the 5th like it isn't run
        const runKey = call.name === "run" ? String(call.args?.command || "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
        const like = runKey.length >= 30 ? sameRuns.get(runKey) : null;
        const samey = !TEAM_AGENT && !!like && like.undo === state.undo.length && like.n >= 4;
        const blocked = TEAM_AGENT || state.crewActive ? blockedBy(call) : "";
        if (blocked) {
          directive.defied = (directive.defied || 0) + 1;
          ui.event({ type: "directive-defied", count: directive.defied, what: blocked });
          ui.note(c.yellow("· blocked by the watcher: " + blocked));
          result = { output: "Blocked by yAI's watcher (" + blocked + "; " + directive.left + " more steps). Its instruction: " + directive.text };
        } else if ((before && !lost) || again || everything || inside || samey) {
          repeats++;
          if (directive) directive.left--;
          result = {
            output: (samey
              ? `You have run commands starting "${runKey}" ${like.n} times without changing any file, so this one wasn't run. More variations won't tell you more: change the code now (edit_file), use check_page for a web page, or finish with your report.`
              : everything
              ? `A search for everything just reads the whole file again. Search for one name (a function, a variable, an id), or read a line range (path:120-180).`
              : inside
                ? `You already have ${inside.map((x) => `${x.p} (read in step ${x.step + 1})`).join(", ")}: those lines are further up and the file hasn't changed since, so ${inside.length === 1 ? "it wasn't" : "they weren't"} read again. Use what you have.`
              : again
                ? `${again.join(", ")} ${again.length === 1 ? "is a long file you already read whole" : "are long files you already read whole"}, and ${again.length === 1 ? "it hasn't" : "they haven't"} changed since: the text is further up, or was removed to save space. Don't read it whole again: read only the lines you need (path:120-180, several ranges in one read_file), or search for one name.`
                : `You already did this exact step (step ${before.step + 1}) and nothing has changed since, so it wasn't run again: its result is the same as before, further up. Use what you already have.`) +
              (repeats >= 3 ? ` You have now repeated ${repeats} steps you already did. Stop looking again: make your change now (write_file or edit_file), or give your final answer with what you know.` : "") +
              // the second refusal in a row: which tool gets new evidence (2026-10-22: an agent kept asking to "look at
              // the screenshot" with the same refused command)
              (++refusedInRow >= 2 ? ` To get NEW evidence instead: to see the screen, check_page with <look_for> (a specific question); to measure something in the page (a value, a size, a pixel colour, a WebGL error), page_eval; to test an idea, make one change with edit_file and check it.` : ""),
          };
          ui.note(c.dim(samey ? "· the same command again, a little changed · not run" : everything ? "· a search for everything · not run" : inside ? "· lines it already has · not read again" : again ? `· ${again.length === 1 ? "a long file" : "long files"} read whole before · asked for the lines it needs` : `· same step as before (${call.name}) · not run again`));
        } else {
          refusedInRow = 0;
          result = await execTool(call);
          if (directive) {
            directive.left--;
            if (["edit_file", "write_file"].includes(call.name) && !String(result.output).startsWith("Error")) { directive.edited = true; const p = String(call.args?.path || "").split("\\").join("/"); for (const b of directive.block) if (b.startsWith("read:") && p.includes(b.slice(5))) (directive.editedPaths ||= new Set()).add(b.slice(5)); }
            if (directive.left <= 0) directive = null;
          }
          if (runKey.length >= 30) sameRuns.set(runKey, like && like.undo === state.undo.length ? { n: like.n + 1, undo: like.undo } : { n: 1, undo: state.undo.length });
          // a /team agent's command still runs (the watcher decides when it's gone on too long); it's told, though
          if (TEAM_AGENT && like && like.undo === state.undo.length && like.n >= 4) result.output += `\nYou have now run commands starting "${runKey}" ${like.n + 1} times without changing a file. More variations rarely tell you more: change the code, use check_page, or finish.`;
          if (sig) doneSteps.set(sig, (resultOf = { step, msg: null }));
          if (call.name === "read_file") { noteWhole(call); if (resultOf && !/^Error|characters cut/.test(String(result.output))) noteRanges(call, resultOf); }
        }
      }
      if (state.interrupted) {
        pushUser(`<tool_result name="${call.name}">\nInterrupted by the user.\n</tool_result>`);
        print(c.yellow("   ■ stopped") + c.dim(" · what should yAI do instead?"));
        return;
      }
      // Failing commands: a small model will try variations of the same broken command forever (2026-10-20:
      // fifteen mkdir attempts). Say so when it repeats one, push it to rethink after three failures in a row,
      // and stop after five.
      if (call.name === "run" && !call.cutOff) {
        const failed = /\n\[(exit code [1-9]\d*|command [^\]]+)\]$/.test(String(result.output));
        // for the summary and the failure card
        const tc = LOOK.testCounts(result.output);
        if (tc) state.task.tests = tc;
        state.task.failure = failed ? { command: String((call.args || {}).command || ""), output: String(result.output), tests: tc } : null;
        const cmd = String((call.args || {}).command || "").trim().toLowerCase();
        if (!failed) failedRuns = 0;
        else {
          failedRuns++;
          if (failedCommands.has(cmd)) result.output += "\nThis exact command already failed earlier in this task. Don't run it again; work out why it fails first.";
          failedCommands.add(cmd);
          if (failedRuns === 3) result.output += "\nThree commands in a row have failed. Stop trying variations: read the error, check your assumptions (does the path exist? is it a file or a folder?), and if you still can't see why, tell the user what's going wrong.";
        }
      }
      // A /team agent that has written its files and then keeps checking without changing anything (2026-10-22: chess
      // builders printed bits of their own files with node -e for 40-100 steps) is told to finish, then stopped.
      if (TEAM_AGENT) {
        if (state.undo.length !== lastUndo) { lastUndo = state.undo.length; idle = 0; }
        else if (state.undo.length > undoStart) idle++;
        if (idle === 15) result.output += "\nYou have taken 15 steps since your last change. Your files are written: finish now with your report, unless something is clearly broken (then fix it in one edit).";
        // An agent that may write but only reads (2026-10-22: mergers read for many minutes before a first edit, or
        // never made one when the pieces already fit) is told to act, then stopped. Read-only checkers are exempt.
        if (!process.env.YAI_REPORT_ONLY && state.undo.length === undoStart && LOOK_STEPS.has(call.name)) {
          reads++;
          if (reads === 20) result.output += "\nYou have looked at the project 20 times without changing anything. Stop reading: make the fixes you've found now, or, if the pieces already fit, finish with your report saying so.";
          if (reads >= 32 && !TEAM_AGENT) { ui.note(`${c.yellow("!")} ${c.ink("yAI kept reading without changing anything, so it was stopped.")}`); ui.event({ type: "error", message: "it kept looking without changing anything, so yAI stopped it" }); pushUser(`<tool_result name="${call.name}">\n${result.output}\n</tool_result>`); break; }
        }
      }
      // The plan's progress depends on the model saying <done>N</done>, which it often forgets (2026-10-22: boards sat on
      // step 1 for a whole run). After 6 steps on one plan step, it's asked whether that step is finished.
      if (state.plan?.steps.length && state.plan.done < state.plan.steps.length) {
        if (planAt !== state.plan.done) { planAt = state.plan.done; planSteps = 0; }
        if (++planSteps % 6 === 0) result.output += `\n(Your plan's step ${state.plan.done + 1} is "${state.plan.steps[state.plan.done]}". If it's finished, start your next reply with <done>${state.plan.done + 1}</done>, or a higher number if later steps are finished too.)`;
      }
      // /crew: the watcher sees the main chat's steps
      if (state.crewActive) { (state.crewSteps ||= []).push(`- ${call.name} ${String((call.args || {}).path || (call.args || {}).command || (call.args || {}).pattern || "").replace(/\s+/g, " ").slice(0, 100)} → ${String(result.output).split("\n")[0].slice(0, 90)}`); if (state.crewSteps.length > 60) state.crewSteps.splice(0, 30); }
      if ((TEAM_AGENT || state.crewActive) && !String(result.output).startsWith("Error")) {
        const arg = call.args || {};
        if (["edit_file", "write_file"].includes(call.name)) logAttempt(`${call.name === "write_file" ? (arg.append ? "appended to" : "wrote") : "edited"} ${String(arg.path || "").trim()}${ctx.flip ? ` · BACK TO AN EARLIER VERSION (${ctx.flip.n}×)` : ""}${arg.old ? `: "${String(arg.old).replace(/\s+/g, " ").trim().slice(0, 50)}" → "${String(arg.new ?? "").replace(/\s+/g, " ").trim().slice(0, 50)}"` : ""}`);
        else if (call.name === "check_page") logAttempt(`check_page${arg.keys ? ` (${String(arg.keys).slice(0, 30)})` : ""} → ${String(result.output).split("\n").filter((l) => /^(FROZEN|BLANK|SAME SCREEN|Compared with your last check|Errors in the browser|No errors)/.test(l)).map((l) => l.replace(/\s+/g, " ").slice(0, 110)).join(" · ") || "checked"}`);
        else if (call.name === "run") logAttempt(`ran ${String(arg.command || "").replace(/\s+/g, " ").slice(0, 70)} → ${/\n\[(exit code [1-9]\d*|command [^\]]+)\]$/.test(String(result.output)) ? "FAILED" : "ok"}`);
      }
      if (repeatTextNow) result.output += `\nYou just wrote nearly the same reasoning as before (${textRepeats} time${textRepeats === 1 ? "" : "s"} now). Thinking it over again won't settle it: get one new fact (page_eval to measure it, check_page with <look_for> to see it) or make one change and check it.`;
      // a flip-flop: this edit put a file back to a version it already had
      if (ctx.flip) {
        const f = ctx.flip; ctx.flip = null;
        result.output += `\nThis puts ${f.path} back to a version it already had (${f.n === 1 ? "the first time" : `${f.n} times now`}): you're going back and forth. Stop and decide: say what you expect to happen and why this version is right, then commit to it. If you don't know which is right, check one specific thing (check_page with <look_for>) instead of changing it again.`;
        ui.event({ type: "flip", path: f.path, count: f.n });
      }
      pushUser(`<tool_result name="${call.name}">\n${result.output}\n</tool_result>`);
      if (resultOf) resultOf.msg = state.messages[state.messages.length - 1];
      // notes the user sent from the /team board while this agent worked, read with this step's result
      if (ctx.screenNotes?.length) pushUser(ctx.screenNotes.splice(0).join("\n\n"));
      if (ctx.crew?.reports.length) pushUser(ctx.crew.reports.splice(0).map((x) => `Your helper "${x.name}" has finished. Its report:\n${x.report}`).join("\n\n") + (ctx.crew.open.size ? `\nStill working: ${[...ctx.crew.open].join(", ")}.` : "\nNo helper is working now."));
      if (state.chat?.length) pushUser(`Team chat, from the other agents:\n${state.chat.splice(0).map((m) => `- ${m}`).join("\n")}\nReply with team_say only if it needs an answer from you.`);
      if (state.directives?.length) {
        const ds = state.directives.splice(0), last = ds[ds.length - 1];
        directive = { text: ds.map((x) => x.text).join(" "), block: [...new Set(ds.flatMap((x) => x.block))], left: last.steps };
        awaitingAck = true;
        const blocks = directive.block.map((b) => (b === "edits-only" ? "only edits until you've made your change (no reading, searching or checking)" : b.startsWith("read:") ? `no reading ${b.slice(5)} until you change it` : `no ${b}`));
        pushUser([
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "⚠ INSTRUCTION FROM yAI'S WATCHER. It sees every step you take. Do this before anything else:",
          directive.text,
          ...(blocks.length ? [`Blocked for your next ${directive.left} steps: ${blocks.join("; ")}.`] : []),
          'Start your next reply with one line: "Following the watcher: <what you will do differently>". Then do it.',
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ].join("\n"));
        ui.event({ type: "note-read", count: ds.length });
      }
      if (state.notes?.length) {
        const n = state.notes.length;
        pushUser(state.notes.splice(0).map((x) => `A note from the user, sent while you work: ${x}`).join("\n"));
        ui.event({ type: "note-read", count: n }); // the board marks the note as read
      }
      if (idle >= 25 && !TEAM_AGENT) { // /team agents: the watcher decides when to stop them (2026-10-22, Yousef)
        ui.note(`${c.yellow("!")} ${c.ink("yAI kept checking without changing anything, so it was stopped.")} ${c.dim("Its changes are kept.")}`);
        break;
      }
      if (failedRuns >= 5 && !TEAM_AGENT) {
        ui.note(`${c.yellow("!")} ${c.ink("Five commands in a row failed, so yAI stopped.")} ${c.dim("Tell it what to do differently, or try a bigger model (/model).")}`);
        break;
      }
      // The same failing step over and over (a small model stuck on one mistake): stop after three.
      if (String(result.output).startsWith("Error") && result.output === lastError) {
        if (++sameError >= 2 && !TEAM_AGENT) {
          ui.note(`${c.yellow("!")} ${c.ink("yAI kept repeating the same failing step, so it was stopped.")} ${c.dim("Try a bigger model (/model) or rephrase the request.")}`);
          break;
        }
      } else sameError = 0;
      lastError = result.output;
      if (result.stop) return;
      if (repeats >= 6 && !TEAM_AGENT) {
        ui.note(`${c.yellow("!")} ${c.ink("yAI kept repeating steps it had already done, so it was stopped.")} ${c.dim(TEAM_AGENT ? "Its report is what it found so far." : "Try a bigger model (/model) or say what to do next.")}`);
        break;
      }
      if (step === MAX_STEPS - 1) {
        if (state.stdio) ui.note(`paused after ${MAX_STEPS} steps`);
        else print(c.yellow(`   ‖ paused after ${MAX_STEPS} steps · say "continue" to keep going`));
      }
    }
    const secs = Math.round((Date.now() - started) / 1000);
    const out = state.usage.out - startOut;
    const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    state.lastStats = out ? `↓ ${kTokens(out)} tok · ${Math.round(out / Math.max(1, secs))} tok/s · ${took}` : `done in ${took}`;
    state.task.over = true; // the plan panel closes, so the summary gets the full width
    // a task that ended well finished its plan, whatever the model last marked
    if (state.plan && !state.task.failure && !state.task.offerFix) state.plan.done = state.plan.steps.length;
    if (!state.interrupted) finishTask({ took, secs: took.replace("s", " s"), out, cost: state.cost.session - costStart, undoStart });
    if (state.mode === "plan" && !state.printMode && !state.interrupted) planReady = true;
    if (JSON.stringify(state.messages).length > COMPACT_HINT_AT) print(c.yellow(" context is getting long · /compact summarizes it so you can keep going"));
  } catch (err) {
    spinner.stop();
    print(c.red(`   ✕ ${err.message}`));
    if (TEAM_AGENT) ui.event({ type: "error", message: err.message }); // the board marks it failed (2026-10-22: it showed ✓)
    if (err.auth) state.user = null;
  } finally {
    spinner.stop();
    ui.setLive(null);
    state.busy = false;
    state.abort = null;
    syncMute();
    saveSession();
  }
  // (a read-only checker in /team only reports; it has no plan to carry out)
  if (planReady && !process.env.YAI_REPORT_ONLY) await approvePlan();
}

// After a request (v2): a failure gets a card that says what failed, with keys to fix it, see the fix first or leave it;
// a task that changed files gets a summary (tests, files, time) and keys for what to do next. A plain answer gets neither.
function finishTask({ took, out, cost, undoStart }) {
  const t = state.task;
  if (!t || state.printMode || state.stdio || !process.stdout.isTTY) return;
  const f = t.failure;
  if (f && (t.offerFix || !t.files.size)) {
    state.phase = "attention";
    const lines = f.output.replace(/\n\[[^\]]*\]$/, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    const header = f.tests && f.tests.failed ? `${f.tests.failed} test${f.tests.failed === 1 ? "" : "s"} failed` : "The command failed";
    print("");
    // the lines that say what failed (the test's name, the error, expected and actual), not the end of a stack dump
    const telling = [...new Set(lines.filter((l) => /✖|not ok|FAILED|Error\b|error:|expected|actual|assert/i.test(l) && !/^\s*at /.test(l) && !/failing tests:?\s*$/i.test(l) && !/^\s*code:/.test(l)).map((l) => l.trim()))];
    for (const l of LOOK.failureLines({ header, lines: [`$ ${f.command}`, ...(telling.length ? telling.slice(0, 4) : lines.slice(-3))] })) print(l);
    print("");
    print(LOOK.buttons([["f", "Fix it"], ["s", "Show me the fix first"], ["n", "Leave it, I'll look"]]));
    state.quick = {
      f: () => handleInput("Yes, fix it."),
      s: () => handleInput("Show me the fix first, as a diff in your reply. Don't change any files yet."),
      n: () => { state.phase = "ready"; state.quick = {}; print(c.dim("   OK, leaving it as it is.")); showPrompt(); },
      e: () => { print(""); for (const l of lines.slice(-60)) print("   " + c.dim(l)); showPrompt(); },
    };
    return;
  }
  if (!t.files.size) return void (state.phase = "ready");
  state.phase = "finished";
  state.phaseLabel = `Finished in ${took.replace(/(\d)s$/, "$1 s")}`;
  let a = 0, d = 0;
  for (const n of t.files.values()) (a += n.a), (d += n.d);
  const tests = t.tests;
  const cards = [
    tests ? { label: "Tests", value: tests.failed ? `${tests.failed} failed` : `${tests.passed} passed`, sub: tests.failed ? `${tests.passed} passed` : "all green", dot: !tests.failed } : { label: "Tests", value: "Not run", sub: "ask yAI to run them" },
    { label: "Files changed", value: `${t.files.size} file${t.files.size === 1 ? "" : "s"}`, sub: `+${a} −${d} lines · ${ui.clip([...t.files.keys()].join(", "), 40)}` },
    { label: "Time and tokens", value: took.replace(/(\d)s$/, "$1 s"), sub: `${kTokens(out)} tokens · ${cost > 0 ? "$" + cost.toFixed(3) : "free (local)"}` },
  ];
  print("");
  for (const l of LOOK.cards(cards)) print(l);
  print("");
  print(`  ${c.faint("What next?")}`);
  print(LOOK.buttons([["r", "Review changes"], ["c", "Commit with a message"], ["u", "Undo everything"]]));
  state.quick = {
    r: () => handleInput("/review"),
    c: () => handleInput("/commit"),
    u: () => { undoAll(undoStart); state.phase = "ready"; state.quick = {}; showPrompt(); },
  };
}
// Takes back every edit since the request started (newest first).
function undoAll(from) {
  let n = 0;
  while (state.undo.length > from) {
    undoLast();
    n++;
  }
  if (n) ui.note(c.dim(`all ${n} change${n === 1 ? "" : "s"} from that task are undone`));
}

// Plan mode ends with a plan to approve (2026-10-20): go ahead with edits approved automatically, go ahead asking
// before each edit, or keep planning.
async function approvePlan() {
  print("");
  const options = ["Yes, and auto-approve edits", "Yes, but ask before each edit", "No, keep planning"];
  const title = "Go ahead with this plan?";
  const i = state.askHook ? await state.askHook({ title, options }) : await select({ title, note: "yAI carries it out", options });
  if (i < 0 || i === 2) return print(c.dim("   Still in plan mode. Tell yAI what to change, or ⇧⇥ to leave it."));
  state.mode = i === 0 ? "acceptEdits" : "default";
  ui.note(`${c.green("✓")} ${c.ink("Plan approved")} ${c.dim(i === 0 ? "· edits are applied without asking" : "· asking before each edit")}`);
  await runAgent("The plan is approved. Carry it out now, step by step. When you're done, say briefly what you changed and how you checked it.");
}

// ---------- Pasted screenshots (2026-10-20): Ctrl+V / Alt+V / /paste put the clipboard image in the prompt ----------
// The image is saved under ~/.yai/clipboard and stands in the prompt as [image N]; on send, a model that can see
// (yAI Ultra first) describes it, like an @image mention.
const CLIP_DIR = path.join(os.homedir(), ".yai", "clipboard");
function clipboardImage() {
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const out = path.join(CLIP_DIR, `paste-${Date.now()}.png`);
  const run = (cmd, args, opts = {}) => require("child_process").spawnSync(cmd, args, { timeout: 8000, windowsHide: true, ...opts });
  if (process.platform === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[System.Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' }`;
    run("powershell.exe", ["-NoProfile", "-STA", "-Command", ps]);
  } else if (process.platform === "darwin") {
    run("osascript", ["-e", `set f to open for access POSIX file "${out}" with write permission`, "-e", "try", "-e", "write (the clipboard as «class PNGf») to f", "-e", "end try", "-e", "close access f"]);
  } else {
    const r = run("wl-paste", ["--type", "image/png"], { maxBuffer: 40e6 });
    const buf = r.status === 0 && r.stdout?.length ? r.stdout : run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], { maxBuffer: 40e6 }).stdout;
    if (buf?.length) fs.writeFileSync(out, buf);
  }
  try {
    if (fs.statSync(out).size > 0) return out;
    fs.unlinkSync(out);
  } catch {}
  return null;
}
function pasteImage({ fromCommand = false } = {}) {
  const file = clipboardImage();
  if (!file) {
    if (fromCommand) return print(c.yellow("   There's no image on the clipboard. Copy a screenshot first (Win+Shift+S on Windows), then Alt+V."));
    print(c.faint("   no image on the clipboard"));
    return rl.prompt(true);
  }
  state.pasted.push(file);
  const token = `[image ${state.pasted.length}] `;
  if (fromCommand) {
    // /paste: the token goes into the next prompt, ready to type the question after it.
    print(`   ${c.accent("▣")} ${c.ink(`image ${state.pasted.length}`)} ${c.dim("pasted · ask about it after the tag")}`);
    return setImmediate(() => rl.write(token));
  }
  rl.write(token);
}

// ---------- /usage: today against the limits, the last 30 days (the website's usage page, in the terminal) ----------
async function usageCommand() {
  let u;
  try {
    const r = await fetch(`${api.baseUrl()}/api/hub?op=usage`, { headers: { Cookie: api.cfg.cookie || "", "User-Agent": "yai-code/1.0" } });
    u = await r.json();
    if (!r.ok) throw new Error(u.error || `error ${r.status}`);
  } catch (err) {
    return print(c.yellow(`   Couldn't load your usage: ${err.message}`));
  }
  const t = u.today;
  const day = u.days[u.days.length - 1] || {};
  const month = {};
  for (const d of u.days) for (const [k, v] of Object.entries(d)) if (k !== "day") month[k] = (month[k] || 0) + v;
  const num = (n) => Number(n || 0).toLocaleString("en-US");
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n || 0));
  const inner = Math.min(ui.width() - 3, 96);
  const barW = Math.max(10, Math.min(28, inner - 52));
  const bar = (used, limit) => {
    if (!limit) return c.faint("no limit");
    const f = Math.min(1, used / limit);
    const n = Math.round(f * barW);
    const fill = f >= 0.8 ? c.accent : c.ink;
    return fill("█".repeat(n)) + c.line("░".repeat(barW - n));
  };
  const row = (label, value, used, limit, note) =>
    ` ${c.dim(label.padEnd(16))}${c.bold(c.ink(value.padEnd(16)))}${bar(used, limit)}  ${c.faint(note || "")}`;
  const hrs = Math.max(0, Math.round((new Date(t.resetsAt) - Date.now()) / 3600000));
  const msgs = (d) => (d.messages || 0) + (d.codeMessages || 0);
  const rows = [
    ` ${c.bold(c.ink("Your usage"))} ${c.dim(`· ${u.user}${t.admin ? " · admin, no media limits" : ""}`)}${" ".repeat(Math.max(2, inner - 40 - u.user.length))}${c.faint(`resets in ${hrs} h`)}`,
    "",
    row("Messages", num(msgs(day)), 0, 0, day.codeMessages ? `${num(day.codeMessages)} in yAI Code` : ""),
    row("yAI Ultra", `$${t.ultra.spentUsd.toFixed(2)} of $${t.ultra.limitUsd}`, t.ultra.spentUsd, t.ultra.limitUsd, `$${Math.max(0, t.ultra.limitUsd - t.ultra.spentUsd).toFixed(2)} left`),
    row("Images", t.images.limit ? `${t.images.used} of ${t.images.limit}` : String(t.images.used), t.images.used, t.images.limit),
    row("Videos", t.videos.limit ? `${t.videos.used} of ${t.videos.limit}` : String(t.videos.used), t.videos.used, t.videos.limit),
    row("Web searches", `${t.searches.used} of ${t.searches.limit}`, t.searches.used, t.searches.limit),
    "",
    ` ${c.faint("Last 30 days")}  ${c.ink(num(msgs(month)))} ${c.dim("messages")}  ${c.ink(short((month.tokensIn || 0) + (month.tokensOut || 0)))} ${c.dim("tokens")}  ${c.ink(num(month.images))} ${c.dim("images")}  ${c.ink(num(month.searches))} ${c.dim("searches")}  ${c.ink(`$${((month.ultraMicros || 0) / 1e6).toFixed(2)}`)} ${c.dim("on Ultra")}`,
  ];
  const models = Object.entries(month).filter(([k]) => k.startsWith("m:")).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (models.length) rows.push(` ${c.faint("Models")}        ${models.map(([k, v]) => `${c.ink(k.slice(2))} ${c.dim(num(v))}`).join(c.faint("  ·  "))}`);
  rows.push("", ` ${c.faint("Full history: ")}${c.dim(api.baseUrl() + "/usage")}`);
  print("");
  ui.frame(rows, { indent: 1, inner });
}

// ---------- @file mentions and !commands ----------
async function expandMentions(text) {
  // pasted text goes back in whole where its tag stands
  text = text.replace(/\[Pasted text #(\d+) \+\d+ lines?\]/g, (m, n) => state.pastedText[Number(n) - 1] ?? m);
  const extra = [];
  const images = [];
  ui.resetSections(); // the attached files sit right under the user's message
  for (const m of text.matchAll(/(^|\s)@("[^"]+"|[^\s]+)/g)) {
    const p = m[2].replace(/^"|"$/g, "").replace(/[.,;:!?)]+$/, "");
    let abs;
    try {
      abs = T.resolve(ctx, p);
    } catch {
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    if (X.isImage(abs) && fs.statSync(abs).isFile()) {
      images.push(abs);
      continue;
    }
    if (fs.statSync(abs).isDirectory()) {
      const list = [...T.walk(ctx, abs, 2)].slice(0, 200).map(({ entry, level }) => "  ".repeat(level) + entry.name + (entry.isDirectory() ? "/" : ""));
      extra.push(`<folder path="${relPath(abs)}">\n${list.join("\n")}\n</folder>`);
      ui.toolHeader("List", relPath(abs) + "/");
      ui.toolResult(`Listed ${list.length} entries`);
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (buf.length > 300000 || buf.subarray(0, 8000).includes(0)) {
      ui.toolHeader("Read", relPath(abs));
      ui.toolResult("skipped · binary or too large", { color: c.yellow });
      continue;
    }
    const lines = buf.toString("utf8").split(/\r?\n/);
    ctx.readFiles.add(abs);
    extra.push(`<file path="${relPath(abs)}">\n${lines.map((l, i) => `${i + 1}\t${l}`).join("\n")}\n</file>`);
    ui.toolHeader("Read", relPath(abs));
    ui.toolResult(`Read ${lines.length} line${lines.length === 1 ? "" : "s"}`);
  }
  for (const m of text.matchAll(/\[image (\d+)\]/g)) {
    const file = state.pasted[Number(m[1]) - 1];
    if (file && fs.existsSync(file) && !images.includes(file)) images.push(file);
  }
  // Images: a model that can see describes them, since the coder can't ("@mockup.png build this").
  if (images.length) extra.push(...(await X.describeImages(images)));
  return extra.length ? `${text}\n\n${extra.join("\n\n")}` : text;
}

async function shellCommand(command) {
  state.busy = true;
  state.abort = new AbortController();
  syncMute();
  try {
    ui.toolHeader(process.platform === "win32" ? "PowerShell" : "Bash", command);
    const { out, code } = await T.runCommand(ctx, command, 600, state.abort.signal);
    const lines = out ? out.split("\n") : [];
    const shown = lines.slice(0, 40).join("\n") + (lines.length > 40 ? `\n… ${lines.length - 40} more lines` : "");
    ui.toolResult(shown, { color: code ? c.red : undefined, summary: code ? `exit ${code}` : lines.length ? `${lines.length} line${lines.length === 1 ? "" : "s"}` : "no output" });
    state.pendingContext.push(`I ran \`${command}\` myself (exit code ${code}). Output:\n\`\`\`\n${T.clipOutput(out, 8000)}\n\`\`\``);
  } finally {
    state.busy = false;
    state.abort = null;
    syncMute();
  }
}

// ---------- slash commands ----------
const HELP = [
  ["/model [name|#]", "Switch model"],
  ["/mode [ask|auto|plan]", "ask before edits · auto-edit · read-only planning (⇧⇥ cycles)"],
  ["/clear", "Start a new conversation"],
  ["/compact [focus]", "Summarize the conversation to free up context, keeping the most detail about <focus>"],
  ["/clone <[image 1]|@file|url> [notes]", "Rebuild a page from a screenshot or a live site, then compare and fix it once"],
  ["/remote", "Take tasks from your phone (the site's Run on your PC page); also: yai remote"],
  ["/init", "Write a YAI.md with notes about this project"],
  ["/status", "Account, model, folder and usage"],
  ["/usage", "Today's use against the limits (Ultra $, images, videos, searches) and the last 30 days"],
  ["/paste", "Paste the clipboard image into the prompt as [image N] (or Alt+V / Ctrl+V)"],
  ["/login, /logout", "Sign in or out of your yAI account"],
  ["/plan", "Think first: read-only planning mode"],
  ["/undo", "Revert the last edit yAI made (not commands)"],
  ["/resume", "Pick an earlier conversation in this folder to continue (yai -c continues the latest)"],
  ["/theme [name]", "yAI Dark · yAI Light · Midnight · Classic Blue · Paper · Amber"],
  ["/fix [test command]", "Run the tests and let yAI fix them until they pass · /fix watch reruns on save"],
  ["/review [focus]", "A second model reviews your uncommitted changes (runs the tests too)"],
  ["/commit [note]", "Write a commit message for your changes and commit"],
  ["/look [url|file] [focus]", "Screenshot the page (desktop + phone) and get a design review"],
  ["/showcase [url|file]", "Record a demo video of your page into yai-media/"],
  ["/team <task>", "A lead splits the task; 2 to 4 agents do the parts at the same time, each on its own files"],
  ["/crew <task>", "One main builder builds it and hands separate jobs to helpers as it goes; the checks run after it"],
  ["/connections", "Services connected on the website (GitHub, LEARN, weather, maps, papers…)"],
  ["/focus [name|off]", "Keep a knowledge pack (~/.yai/packs/<name>.md) in every message; /<name> is a shortcut, yai <name> starts there"],
  ["/pr [note]", "Push this branch and open a GitHub pull request written from the diff"],
  ["/issues", "Pick an open GitHub issue of this repo and let yAI work on it"],
  ["/deploy [prod]", "Deploy this folder with the Vercel CLI (a preview, or production) and print the link"],
  ["/duo", "Two models: yAI Q3.8 Max (or another hosted model) plans and reviews, the coder writes"],
  ["/tutor", "Learning mode: hints and explanations, no finished solutions"],
  ["/share", "Publish this conversation at an unlisted link"],
  ["/bench [model]", "Run the 6-task coding benchmark (44 tests) on a model; scores are kept in ~/.yai/bench.json"],
  ["/mcp [add|remove|restart]", "MCP servers and their tools (also read from .mcp.json)"],
  ["/tasks [stop n]", "Commands yAI left running in the background (dev servers, watchers)"],
  ["/web <question>", "Search the web and answer from the results, with sources"],
  ["/image [16:9] [@photo] <prompt>", "Make an image, or edit a photo; saved in yai-media/"],
  ["/video [16:9] <prompt>", "Make a 5-second video with sound; saved in yai-media/"],
  ["/config url <url>", "Point yai at a different yAI site"],
  ["/exit", "Quit (or Ctrl+C twice)"],
];
const COMMAND_NAMES = ["/help", "/model", "/mode", "/plan", "/undo", "/resume", "/clone", "/remote", "/theme", "/clear", "/compact", "/init", "/status", "/usage", "/paste", "/fix", "/review", "/commit", "/look", "/showcase", "/duo", "/team", "/crew", "/connections", "/pr", "/issues", "/deploy", "/tutor", "/share", "/bench", "/web", "/mcp", "/tasks", "/image", "/video", "/login", "/logout", "/config", "/exit"];
// The suggestions while a /command is typed (v2): a plain title, and a line saying what it does or what's on now.
function COMMAND_INFO() {
  const pct = contextPercent();
  const info = {
    "/help": ["Show every command", "with what each one does"],
    "/model": ["Switch model", `Now: ${modelLabel()}. Try yAI Ultra for harder tasks.`],
    "/mode": ["Change how much I ask", `Now: ${MODE_WORDS[state.mode]}`],
    "/plan": ["Plan first, change nothing", "read-only: I look around and propose a plan"],
    "/undo": ["Undo my last change", state.undo.length ? `${state.undo.length} change${state.undo.length === 1 ? "" : "s"} this session` : "nothing to undo yet"],
    "/resume": ["Pick up an earlier conversation", "in this folder"],
    "/clear": ["Start a new conversation", "this one stays in /resume"],
    "/compact": ["Free up memory", `${pct}% of memory used in this session`],
    "/status": ["See where things stand", "account, model, folder, memory and spend"],
    "/usage": ["See today's usage", "against your daily limits"],
    "/review": ["Review my changes", "a second model looks them over and runs the tests"],
    "/commit": ["Commit with a message", "I write the message from the changes"],
    "/fix": ["Make the tests pass", "run them and fix what fails"],
    "/team": ["Split the work between agents", "2 to 4 work at the same time"],
    "/crew": ["One builder with helpers", "it hands out side jobs as it goes"],
    "/deploy": ["Deploy this folder", "a Vercel preview link (or /deploy prod)"],
    "/pr": ["Open a pull request", "push the branch, I write the description"],
    "/issues": ["Work on a GitHub issue", "pick one of this repo's open issues"],
    "/connections": ["See your connected services", "GitHub, LEARN, weather, maps, papers…"],
    "/duo": ["Plan and review with a second model", state.duo ? "on" : "off"],
    "/tutor": ["Learning mode", "hints instead of finished answers"],
    "/web": ["Search the web", "and answer with sources"],
    "/init": ["Write notes about this project", "YAI.md, read at the start of every conversation"],
    "/focus": ["Focus on a company or project", state.focus ? `Now: ${state.focus.title}` : "load a knowledge pack into every message"],
    ...Object.fromEntries(FOCUS.list().map((p) => [`/${p.name}`, [`${p.title} focus`, state.focus?.name === p.name ? "on now · /focus off to stop" : `everything about ${p.title}`]])),
    "/look": ["Review how a page looks", "screenshots on desktop and phone"],
    "/clone": ["Rebuild a page", "from a screenshot or a live site"],
    "/showcase": ["Record a demo video", "of your page"],
    "/image": ["Make an image", "or edit a photo"],
    "/video": ["Make a short video", "5 seconds, with sound"],
    "/paste": ["Paste a screenshot", "from the clipboard"],
    "/theme": ["Change the colours", ui.THEMES[ui.themeKey]?.name || ""],
    "/remote": ["Take tasks from your phone", "the site's Run on your PC page"],
    "/share": ["Share this conversation", "at an unlisted link"],
    "/bench": ["Benchmark a model", "6 coding tasks, 44 tests"],
    "/mcp": ["Manage MCP servers", "and their tools"],
    "/tasks": ["Background commands", "dev servers and watchers I left running"],
    "/login": ["Sign in", "to your yAI account"],
    "/logout": ["Sign out", ""],
    "/config": ["Use a different yAI site", ""],
    "/exit": ["Quit", "or Ctrl+C twice"],
  };
  return COMMAND_NAMES.map((n) => [n, ...(info[n] || [n.slice(1), ""])]);
}

// ---------- /theme ----------
const THEME_KEYS = Object.keys(ui.THEMES);
async function chooseTheme(arg) {
  let key;
  if (!arg) {
    const i = await select({
      title: "Theme", note: "the whole conversation is redrawn in it",
      options: THEME_KEYS.map((k) => `${ui.THEMES[k].name.padEnd(14)}${ui.THEMES[k].note}${k === ui.themeKey ? "  (current)" : ""}`),
      selected: Math.max(0, THEME_KEYS.indexOf(ui.themeKey)),
    });
    if (i < 0) return;
    key = THEME_KEYS[i];
  } else {
    const q = arg.toLowerCase();
    key = THEME_KEYS[Number(q) - 1] || THEME_KEYS.find((k) => k === q || ui.THEMES[k].name.toLowerCase().replace(/^yai /, "").startsWith(q.replace(/^yai /, "")));
    if (!key) return print(c.yellow(`No theme matches "${arg}". Try dark, light, midnight, blue, paper or amber.`));
  }
  ui.setTheme(key);
  api.cfg.theme = key;
  api.save();
  // Text already on screen keeps the old colours, so the screen is cleared and the conversation redrawn in the new
  // theme (Yousef 2026-10-20: "if u change theme … it changes all the theme of the previous chats").
  redrawTranscript();
  ui.note(`${c.green("✓")} ${c.ink("Theme: " + ui.THEMES[key].name)}`);
}

// The welcome box's rows (model, project, notes, account).
function welcomeRows() {
  const git = gitStatus();
  const cur = state.models.find((m) => m.id === state.model);
  const where = !cur ? "" : cur.price ? "hosted" : cur.cloud || /cloud/.test(cur.id) ? "cloud GPU" : "your PC";
  const rows = [["model", modelLabel(), cur ? c.faint(`· ${where} · ${Math.round((cur.context || 8192) / 1000)}k context`) : ""]];
  rows.push(["project", shortPath(root), git ? c.faint(`· ${git.branch}${git.modified ? ` · ${git.modified} modified` : ""}`) : ""]);
  const notes = ["YAI.md", "CLAUDE.md", "AGENTS.md"].find((n) => fs.existsSync(path.join(root, n)));
  if (notes) rows.push(["context", notes, c.faint(`· ${fs.readFileSync(path.join(root, notes), "utf8").split("\n").length} lines`)]);
  else rows.push(["context", "no notes yet", c.faint("· /init writes YAI.md")]);
  rows.push(["account", state.user || "signed out", state.localOffline ? c.yellow("· PC offline, cloud models only") : ""]);
  return rows;
}

// Clears the screen (and scrollback) and prints the welcome box and this conversation again: your messages, yAI's
// words and a row for each step it took (tool output itself isn't kept, so steps show without their results).
const STEP_NAMES = { read_file: "Read", list_files: "List", find_files: "Find", search: "Search", edit_file: "Edit", write_file: "Create", run: "Run", web_search: "Web search", web_fetch: "Fetch", task_output: "Task output", task_stop: "Stop task", service: "Service" };
function redrawTranscript() {
  if (!process.stdout.isTTY || state.printMode || SCREEN.on) return; // the full-window app redraws itself
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  ui.resetSections();
  ui.welcome({ version: VERSION, rows: welcomeRows() });
  for (const m of state.messages) {
    if (typeof m.content !== "string") continue;
    if (m.role === "user") {
      if (m.content.startsWith("<tool_result")) continue;
      if (m.content.startsWith("This conversation continues from")) {
        print("");
        ui.note(c.faint("(the conversation before this was summarised by /compact)"));
        continue;
      }
      print("");
      ui.resetSections();
      ui.userLine(m.content.split(/\n\n<(?:file|folder) path=/)[0]);
      continue;
    }
    const call = parseToolCall(m.content);
    const at = m.content.search(/(^|\n)[ \t]*<tool[\s>]/);
    const prose = call && at >= 0 ? m.content.slice(0, at) : m.content;
    if (prose.trim()) {
      const write = ui.markdownWriter();
      for (const line of prose.trim().split("\n")) write(line);
      write.end();
    }
    if (call && call.name && !call.cutOff) {
      const a = call.args || {};
      const name = call.name.startsWith("mcp__") ? `MCP ${call.name.split("__")[1]}` : STEP_NAMES[call.name] || call.name;
      ui.toolHeader(name, a.path || a.command || a.pattern || a.query || a.url || a.id || "");
      ui.toolResult("");
    }
  }
  print("");
}

// ---------- /undo ----------
function undoLast() {
  const u = state.undo.pop();
  if (!u) return print(c.dim("   Nothing to undo. (/undo reverts edits yAI made this session, not commands.)"));
  try {
    if (u.created) fs.unlinkSync(u.abs);
    else fs.writeFileSync(u.abs, u.before);
  } catch (err) {
    return print(c.red(`   Couldn't undo: ${err.message}`));
  }
  ctx.readFiles.delete(u.abs);
  ui.note(`${c.yellow("↺")} ${c.ink(u.created ? `removed ${relPath(u.abs)}` : `reverted ${relPath(u.abs)}`)}`);
  // yAI hears about it, so it doesn't build on the change that was taken back.
  state.pendingContext.push(`I undid your last change: ${u.created ? `${relPath(u.abs)} was deleted` : `${relPath(u.abs)} is back to how it was before your edit`}. Re-read it before changing it again.`);
}

// ---------- /resume: pick any earlier conversation in this folder ----------
function folderSessions() {
  let names = [];
  try {
    names = fs.readdirSync(SESSIONS_DIR).filter((f) => f === `${projectKey}.json` || (f.startsWith(`${projectKey}-`) && f.endsWith(".json")));
  } catch {}
  return names
    .map((f) => { try { return { ...JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8")), file: f }; } catch { return null; } })
    .filter((s) => s && s.messages?.length && (s.id !== state.conversationId || !state.messages.length))
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}
const typedCount = (s) => s.messages.filter((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("<tool_result")).length;
function loadSession(s) {
  state.messages = s.messages;
  state.conversationId = s.id || crypto.randomUUID();
  state.title = s.title || null;
  state.pendingContext = [];
  ctx.readFiles.clear();
  redrawTranscript();
  ui.note(`${c.green("✓")} ${c.ink(`Continuing “${sessionTitle(s)}”`)} ${c.dim(`· ${typedCount(s)} messages · ${ago(s.savedAt)}`)}`);
}
async function resumeSession(arg = "") {
  const list = folderSessions();
  if (!list.length) return print(c.dim("   No earlier conversations in this folder."));
  if (arg === "last" || list.length === 1 || state.stdio || !process.stdout.isTTY) return loadSession(list[0]);
  const shown = list.slice(0, 9);
  const i = await select({
    title: "Resume a conversation", note: `${list.length} in this folder`,
    options: shown.map((s) => `${sessionTitle(s)} ${c.faint(`· ${ago(s.savedAt)} · ${typedCount(s)} message${typedCount(s) === 1 ? "" : "s"}`)}`),
    hint: "↑↓ choose · enter resume · esc cancel",
  });
  if (i >= 0) loadSession(shown[i]);
}
// The first thing the user asked in a saved conversation, for the welcome box and /resume.
function sessionTitle(s) {
  if (s.title) return s.title; // kept from the first message, so /compact doesn't change it
  const first = (s.messages || []).find((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("<tool_result"));
  // Only what was typed: attached @files are added after it as <file> / <folder> blocks.
  const typed = (first?.content || "").split(/\n\n<(?:file|folder) path=/)[0];
  return ui.middle(typed.replace(/\s+/g, " ").trim(), 48) || "untitled";
}
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

// ---------- /image and /video: the web app's Make Image / Make Video, saved into the project ----------
const MEDIA_DIR = "yai-media";
const ASPECTS = ["1:1", "16:9", "9:16"];
const PHOTO_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const MAX_PHOTO_BYTES = 2_200_000; // the site takes up to 3 MB of base64

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "media";
// yai-media/<prompt-slug>.png, then -2, -3 … so nothing is ever overwritten.
function mediaFile(prompt, ext) {
  const dir = path.join(root, MEDIA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${slug(prompt)}${n > 1 ? "-" + n : ""}${ext}`);
    if (!fs.existsSync(file)) return file;
  }
}
// A wait that Esc can cut short.
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("stopped"))), { once: true });
  });

async function makeMedia(kind, arg) {
  const words = arg.split(/\s+/).filter(Boolean);
  const aspect = ASPECTS.includes(words[0]) ? words.shift() : undefined;
  const photo = words[0] && words[0].startsWith("@") ? words.shift().slice(1) : null;
  const prompt = words.join(" ");
  if (!prompt) return print(c.yellow(`Usage: /${kind} [16:9|9:16|1:1] ${kind === "image" ? "[@photo.jpg] " : ""}<what you want>`));
  if (photo && kind === "video") return print(c.yellow("Animating a photo is turned off for now. Describe the video instead."));
  if (!state.user) await ensureLogin();

  let image;
  if (photo) {
    const abs = T.resolve(ctx, photo);
    const mime = PHOTO_TYPES[path.extname(abs).toLowerCase()];
    if (!mime) return print(c.yellow("Attach a .jpg, .png or .webp photo."));
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      return print(c.red(`File not found: ${photo}`));
    }
    if (buf.length > MAX_PHOTO_BYTES) return print(c.yellow("That photo is over 2 MB. Make it smaller first (the website shrinks photos for you)."));
    image = `data:${mime};base64,${buf.toString("base64")}`;
  }

  state.busy = true;
  state.interrupted = false;
  state.abort = new AbortController();
  syncMute();
  ui.resetSections();
  print("");
  ui.toolHeader(kind === "video" ? "Video" : "Image", (photo ? `@${photo} ` : "") + prompt);
  let job;
  try {
    const started = await api.startMedia({ kind, prompt, image, aspect });
    job = started.job;
    spinner.start(`starting ${started.label || kind}`);
    let result;
    while (!result) {
      await wait(kind === "video" ? 5000 : 2500, state.abort.signal);
      const s = await api.pollMedia(job, state.abort.signal);
      if (s.error) throw new Error(s.error);
      if (s.image || s.video) result = s;
      else spinner.text(s.state === "waking" ? `waking the GPU (${s.elapsed}s, can take a few minutes)` : `making the ${kind} (${s.elapsed}s)`);
    }
    let file, buf;
    if (result.image) {
      const [, mime, b64] = result.image.match(/^data:([^;]+);base64,(.*)$/);
      buf = Buffer.from(b64, "base64");
      file = mediaFile(prompt, { "image/png": ".png", "image/webp": ".webp" }[mime] || ".jpg");
    } else {
      spinner.text("downloading the video");
      buf = await api.downloadVideo(result.video.id, state.abort.signal);
      file = mediaFile(prompt, ".mp4");
    }
    fs.writeFileSync(file, buf);
    spinner.stop();
    ui.toolResult(`saved ${T.rel(ctx, file)}`, { color: c.green });
    // yAI hears about it, so "use that image on the page" works in the next message.
    state.pendingContext.push(`I made ${kind === "video" ? "a video" : "an image"} with /${kind} ("${prompt}") and saved it as ${T.rel(ctx, file)}.`);
  } catch (err) {
    spinner.stop();
    if (job && state.interrupted) api.cancelMedia(job);
    ui.toolResult(state.interrupted ? "stopped" : err.message, { color: state.interrupted ? c.yellow : c.red });
  } finally {
    state.busy = false;
    state.abort = null;
    syncMute();
  }
}

const INIT_PROMPT =
  "Look through this project and create a YAI.md file at the root with notes for future sessions: what the project is, " +
  "how to install, run, build and test it, the important folders and files, and any conventions you notice. " +
  "Keep it under 60 lines and only include things you verified in the files. If YAI.md already exists, improve it.";

async function chooseModel(arg) {
  await loadModels();
  if (!arg) {
    if (state.localOffline) print(c.yellow("   The PC is offline, so only cloud models are listed."));
    const picked = await modelPicker();
    if (!picked) return;
    arg = picked.id;
  }
  const m = findModel(arg);
  if (!m) return print(c.yellow(`No model matches "${arg}".`));
  state.model = m.id;
  api.cfg.model = m.id;
  api.cfg.modelPicked = 3;
  api.save();
  prewarm(); // a newly picked cloud model starts waking right away
  ui.note(`${c.green("✓")} ${c.ink("Model: " + m.label)}` + (m.cloud || /cloud/.test(m.id) ? "" : c.dim(" · small local models can struggle with multi-step tool use")));
}

// Replaces the conversation with a summary of it (plus the last `keepRecent` messages, so a task in progress
// carries on). The request has to fit the window too, which a full conversation no longer does, so long tool
// output is cut down first and, if that isn't enough, the oldest messages after the first request are left out.
async function summarize({ keepRecent = 0, signal, focus = "" } = {}) {
  const recent = keepRecent ? state.messages.slice(-keepRecent) : [];
  const slim = state.messages.slice(0, state.messages.length - recent.length).map((m) =>
    typeof m.content === "string" && m.content.length > 1500 ? { ...m, content: m.content.slice(0, 700) + "\n[…cut for the summary]" } : m
  );
  while (JSON.stringify(slim).length > contextChars() * 0.6 && slim.length > 3) slim.splice(1, 1);
  let summary = "";
  await ensureWarm();
  await api.chat({
    messages: [
      ...slim,
      {
        role: "user",
        content:
          "Summarize our conversation so far so we can continue in a fresh context. Include: what I asked for, decisions made, " +
          "files you changed and how, the current state, and what's left to do. Be specific with file paths and names. No tool calls." +
          (focus ? ` Keep the most detail about: ${focus}.` : ""),
      },
    ],
    model: state.model,
    system: systemPrompt(),
    conversationId: state.conversationId,
    signal,
    onTokens: (n) => spinner.tokens(n),
    onText: (p) => void (summary += p),
  });
  if (!summary.trim()) throw new Error("The model returned an empty summary");
  state.messages = [
    { role: "user", content: `This conversation continues from an earlier one. Summary of it:\n\n${summary.replace(/<tool[\s\S]*$/, "").trim()}` },
    { role: "assistant", content: "Got it. I'll continue from there." },
    ...recent,
  ];
  ctx.readFiles.clear();
}

async function compact(focus = "") {
  if (state.messages.length < 2) return print(c.dim("Nothing to compact yet."));
  state.busy = true;
  state.interrupted = false;
  state.abort = new AbortController();
  syncMute();
  const saved = state.messages;
  try {
    spinner.start(focus ? `compacting, keeping ${focus}` : "Compacting");
    await summarize({ signal: state.abort.signal, focus });
    spinner.stop();
    print(c.green("   Compacted the conversation") + c.dim(` (${kTokens(Math.round(JSON.stringify(saved).length / 3.6))} → ${kTokens(Math.round(JSON.stringify(state.messages).length / 3.6))} tokens)`));
  } catch (err) {
    spinner.stop();
    state.messages = saved;
    print(c.red(`   ${state.interrupted ? "Interrupted" : err.message}`));
  } finally {
    state.busy = false;
    state.abort = null;
    syncMute();
    saveSession();
  }
}

async function command(line) {
  const cmd = line.split(/\s+/)[0].toLowerCase();
  const arg = line.slice(cmd.length).trim();
  switch (cmd) {
    case "/help":
    case "/?":
      return showHelp();
    case "/model":
      return chooseModel(arg);
    case "/mode": {
      const want = { default: "default", ask: "default", accept: "acceptEdits", edits: "acceptEdits", auto: "acceptEdits", "auto-edit": "acceptEdits", yolo: "yolo", all: "yolo", everything: "yolo", plan: "plan" }[arg.toLowerCase()];
      state.mode = want || MODES[(MODES.indexOf(state.mode) + 1) % MODES.length];
      return print(c.dim(`   mode: ${{ default: "ask · asks before edits and commands", acceptEdits: "auto-edit · applies edits without asking", yolo: "yolo · auto-accepts edits, commands and deletions", plan: "plan · read-only" }[state.mode]}`));
    }
    case "/clear":
    case "/new":
      state.messages = [];
      state.pendingContext = [];
      state.conversationId = crypto.randomUUID();
      state.title = null;
      ctx.readFiles.clear();
      if (SCREEN.on) SCREEN.clear();
      else if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      return print(c.dim("New conversation."));
    case "/compact":
      return compact(arg);
    case "/clone":
      return X.clone(arg, state.pasted);
    case "/remote":
      return remoteMode();
    case "/init":
      return runAgent(INIT_PROMPT);
    case "/image":
    case "/video":
      return makeMedia(cmd.slice(1), arg);
    case "/theme":
      return chooseTheme(arg);
    case "/fix":
      return X.fix(arg);
    case "/review":
      return X.review(arg);
    case "/commit":
      return X.commit(arg);
    case "/look":
      return X.look(arg);
    case "/showcase":
      return X.showcase(arg);
    case "/duo":
      return X.toggleDuo(arg);
    case "/team":
      return TEAM.team(arg);
    case "/crew": {
      // /crew <task>: this chat, with background agents it commissions; /crew off ends it (2026-10-23)
      if (/^\s*off\s*$/i.test(arg)) { CREW.stop(); return print(c.dim("   /crew is off: this is a plain chat again.")); }
      const m = /^([1-8])\s+([\s\S]+)$/.exec(arg.trim());
      state.crewMax = m ? Number(m[1]) : 4;
      const task = (m ? m[2] : arg).trim();
      if (!task) return print(c.yellow("   Usage: /crew <task>   (or /crew 6 <task> for up to 6 background agents at once). /crew off ends it."));
      state.crewTask = task;
      CREW.start();
      // a researcher first, always (it shows under "Background agents"); its report opens the chat's first turn
      ui.note(`${c.accent("◆")} ${c.ink("A researcher looks into the topic first")} ${c.dim("· on Ultra Flash · it writes RESEARCH.md")}`);
      state.busy = true; // the panel shows while it works
      spinner.start("the researcher is looking into the topic");
      try { await CREW.research(); } finally { spinner.stop(); state.busy = false; }
      if (state.interrupted || !state.crewActive) return print(c.dim("   Stopped."));
      ui.note(`${c.accent("◆")} ${c.ink("/crew: this chat works on it, and hands separate jobs to background agents")} ${c.dim("· they show under the plan · /crew off ends it")}`);
      return runAgent(`${task}\n\n(The researcher's notes are in RESEARCH.md, with the topic's facts, how it's usually built and a checklist: read them before you build.)`);
    }
    case "/connections":
      return CONN.connections();
    case "/focus":
      return FOCUS.command(arg);
    case "/pr":
      return CONN.pr(arg);
    case "/issues":
      return CONN.issues();
    case "/deploy":
      return CONN.deploy(arg);
    case "/tutor":
      return X.toggleTutor(arg);
    case "/share":
      return X.share();
    case "/bench":
      return BENCH.bench(arg);
    case "/mcp":
      return mcpCommand(arg);
    case "/web":
      return webCommand(arg);
    case "/usage":
      return usageCommand();
    case "/paste":
      return pasteImage({ fromCommand: true });
    case "/tasks":
      return tasksCommand(arg);
    case "/undo":
      return undoLast();
    case "/resume":
      return resumeSession(arg);
    case "/plan":
      state.mode = "plan";
      return ui.note(`${c.yellow("◆")} ${c.ink("plan mode")} ${c.dim("· read-only: yAI investigates and proposes a plan · ⇧⇥ to leave")}`);
    case "/status": {
      const tokens = Math.round(JSON.stringify(state.messages).length / 3.6);
      print("");
      print(`  Account   ${state.user ? c.green(state.user) : c.red("signed out")} ${c.dim("· " + api.baseUrl())}`);
      print(`  Model     ${modelLabel()}${state.localOffline ? c.yellow(" · PC offline, cloud only") : ""}`);
      print(`  Folder    ${root}`);
      print(`  Mode      ${{ default: "ask · asks before edits and commands", acceptEdits: "auto-edit · applies edits without asking", yolo: "yolo · auto-accepts edits, commands and deletions", plan: "plan · read-only" }[state.mode]}${state.tutor ? " · tutor" : ""}${state.duo ? " · duo" : ""}`);
      print(`  Context   ~${kTokens(tokens)} tokens in ${state.messages.length} messages`);
      print(`  Usage     ↓ ${kTokens(state.usage.out)} tokens generated this session`);
      if (state.cost.session > 0) print(`  Cost      $${state.cost.session.toFixed(3)} of yAI Ultra this session${state.cost.todayUsd != null ? ` · $${state.cost.todayUsd.toFixed(2)} of $${state.cost.limitUsd} today` : ""}`);
      print(`  Version   yAI Code ${VERSION}`);
      const allowed = project().allowedCommands;
      if (allowed.length) print(`  Allowed   ${allowed.join(", ")} ${c.dim("(commands that run without asking here)")}`);
      return;
    }
    case "/login":
      await api.logout();
      state.user = null;
      await ensureLogin();
      return loadModels().catch((e) => print(c.red(e.message)));
    case "/logout":
      await api.logout();
      print(c.dim("Signed out."));
      return rl.close();
    case "/config": {
      const [key, value] = arg.split(/\s+/);
      if (key !== "url" || !value) return print(c.yellow("Usage: /config url https://your-site.vercel.app"));
      api.cfg.url = /^https?:\/\//.test(value) ? value : "https://" + value;
      delete api.cfg.cookie;
      api.save();
      print(c.green(`   Site: ${api.baseUrl()}`));
      state.warmed.clear();
      await ensureLogin();
      return loadModels().catch((e) => print(c.red(e.message)));
    }
    case "/exit":
    case "/quit":
      return rl.close();
    default:
      // a focus pack's own name, e.g. /acme (on, or off with "/acme off")
      if (FOCUS.read(cmd.slice(1))) return /^off$/i.test(String(arg || "").trim()) ? FOCUS.off() : FOCUS.on(cmd.slice(1));
      print(c.yellow(`Unknown command ${cmd}. Type /help.`));
  }
}

// readline has echoed what was typed after "› "; redraw it as the user's message on the panel.
function restyleInput(text) {
  if (SCREEN.on) {
    SCREEN.toBottom();
    SCREEN.endStart();
    print("");
    return ui.userLine(text);
  }
  if (!process.stdout.isTTY || text.includes("\n")) return;
  const rows = Math.max(1, Math.ceil((3 + text.length) / ui.columns()));
  // the key bar under the input, the input itself and the status row over it make way for the message
  process.stdout.write("\r\x1b[J" + "\x1b[1A".repeat(rows + 1) + "\r\x1b[J");
  ui.userLine(text);
}

async function handleInput(input) {
  state.placeholder = false;
  clearTimeout(state.quickTimer);
  let text = input.trim();
  if (!text) {
    // an empty enter: the prompt is drawn again in the same place, not under the old one
    if (process.stdout.isTTY && !state.stdio && !SCREEN.on) process.stdout.write("\r\x1b[J" + "\x1b[1A".repeat(3) + "\r\x1b[J");
    return showPrompt();
  }
  restyleInput(input);
  // A new message starts afresh: the keys offered after the last task go away.
  state.quick = {};
  state.phase = "ready";
  state.hint = "";
  if (state.prefix && !text.startsWith("/")) text = state.prefix + text;
  state.prefix = "";
  if (state.mcpStart) await state.mcpStart; // MCP servers start in the background; their tools are needed now
  // A long paste stands in the prompt as [Pasted text #N]; a pasted "/team …" (2026-10-22) is still a command, and so
  // is "/team " followed by a paste. /team's task may be pasted over several lines.
  const pasted = text.replace(/\[Pasted text #(\d+) \+\d+ lines?\]/g, (m, n) => state.pastedText[Number(n) - 1] ?? m).trim();
  if (pasted !== text && /^\/[a-z?]+(\s|$)/i.test(pasted)) text = /^\/(team|crew)\s/i.test(pasted) ? pasted.replace(/\s*\n\s*/g, " ") : pasted;
  try {
    if (text.startsWith("/") && !text.includes("\n") && /^\/[a-z?]+(\s|$)/i.test(text)) await command(text);
    else if (text.startsWith("!")) await shellCommand(text.slice(1).trim());
    else {
      if (!state.user) await ensureLogin();
      await runAgent(await expandMentions(text));
    }
  } catch (err) {
    spinner.stop();
    print(c.red(err.message));
  }
  while (queue.length && !state.busy) {
    const next = queue.shift();
    ui.userLine(next);
    await runAgent(await expandMentions(next));
  }
  showPrompt();
}

// A change in a few lines of text, for the phone (yai remote): the changed lines with a line of context.
function diffText(plan) {
  const lines = (t) => (t ? String(t).replace(/\r\n/g, "\n").split("\n") : []);
  const ops = ui.lineDiff(lines(plan.before), lines(plan.after));
  const keep = new Set();
  ops.forEach((o, i) => { if (o.t !== " ") for (let k = i - 1; k <= i + 1; k++) keep.add(k); });
  const out = [];
  let last = -2;
  ops.forEach((o, i) => {
    if (!keep.has(i)) return;
    if (i > last + 1 && out.length) out.push("  …");
    out.push(`${o.t === " " ? " " : o.t} ${o.text}`);
    last = i;
  });
  return `${plan.created ? "New file" : "Change to"} ${relPath(plan.abs)}\n${out.slice(0, 120).join("\n")}`;
}

// Turns what yai prints into plain lines: colours dropped, spinner redraws (\r) settled, cursor moves removed.
function plainLines(text) {
  return String(text)
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .split("\n")
    .map((line) => line.split("\r").filter((p, i, all) => i === all.length - 1 || p).pop() || "")
    .map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
    .join("\n");
}

// ---------- yai remote: tasks from the phone (2026-10-20) ----------
// yAI Code waits for tasks sent from the site's Run on your PC page (/remote), runs each one here as if it had been
// typed, and sends what it prints back to the phone. Questions it would ask here (may I edit this file?) come to the
// phone as buttons. Esc or Ctrl+C while it's waiting stops listening.
const MACHINE_ID = crypto.createHash("sha1").update(`${os.hostname()}|${root.toLowerCase()}`).digest("hex").slice(0, 16);
async function remoteMode() {
  if (state.remote) return print(c.dim("   Already listening for tasks."));
  if (!state.user) await ensureLogin();
  // a session: this run of yai remote (the phone shows it as one chat, with every task sent to it)
  const SESSION = crypto.randomBytes(8).toString("hex");
  const hello = () => api.hub("remote-hello", { method: "POST", body: { machine: MACHINE_ID, session: SESSION, name: os.hostname(), folder: root, model: modelLabel() } });
  try {
    await hello();
  } catch (err) {
    return print(c.red(`   Couldn't connect to ${api.baseUrl()}: ${err.message}`));
  }
  const R = (state.remote = { tasks: [], wake: null, current: null, answers: new Map(), stopped: false });
  const pollAbort = new AbortController();
  const push = (task, events, status) => api.hub("remote-push", { method: "POST", body: { task: task.id, events, status } }).catch(() => {});
  print("");
  ui.note(`${c.accent("◆")} ${c.ink("Listening for tasks from your phone")} ${c.dim(`· ${api.baseUrl()}/remote · esc to stop listening`)}`);

  // The poller: new tasks, answers to questions, stops. Runs alongside the task being worked on.
  (async () => {
    while (!R.stopped) {
      try {
        const r = await api.hub(`remote-poll&m=${MACHINE_ID}`, { signal: pollAbort.signal });
        for (const t of r.tasks) R.tasks.push(t);
        if (r.tasks.length && R.wake) R.wake();
        for (const a of r.answers) {
          const resolve = R.answers.get(a.ask);
          if (resolve) { R.answers.delete(a.ask); resolve(a.choice); }
        }
        for (const s of r.stop) {
          if (R.current && R.current.id === s.task) {
            state.interrupted = true;
            state.abort?.abort();
            for (const resolve of R.answers.values()) resolve(-1);
            R.answers.clear();
          } else R.tasks = R.tasks.filter((t) => t.id !== s.task);
        }
      } catch (err) {
        if (R.stopped) break;
        if (/register/i.test(err.message)) await hello().catch(() => {});
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();

  try {
    for (;;) {
      // Waiting: esc (or Ctrl+C) stops listening.
      if (!R.tasks.length) {
        state.busy = true;
        state.abort = new AbortController();
        syncMute();
        spinner.start("waiting for a task from your phone");
        const got = await new Promise((resolve) => {
          R.wake = () => resolve(true);
          state.abort.signal.addEventListener("abort", () => resolve(false), { once: true });
        });
        R.wake = null;
        spinner.stop();
        state.busy = false;
        state.abort = null;
        syncMute();
        if (!got) break;
      }
      const task = R.tasks.shift();
      if (!task) continue;
      R.current = task;
      const before = state.mode;
      state.mode = ["default", "acceptEdits", "yolo", "plan"].includes(task.mode) ? task.mode : "default";
      // Background tasks (2026-10-21): the work goes on a new branch that's committed and pushed when it's done, then
      // the PC goes back to the branch it was on, so you can start it from your phone and review a branch later.
      const gitRun = (args) => { const r = require("child_process").spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
      let bg = null;
      if (task.mode === "background") {
        state.mode = "acceptEdits";
        if (!gitRun(["rev-parse", "--is-inside-work-tree"]).ok) ui.note(c.yellow("This folder isn't a git repository, so the work stays as plain changes (no branch)."));
        else if (gitRun(["status", "--porcelain"]).out) ui.note(c.yellow("There are uncommitted changes here, so the work isn't put on a separate branch."));
        else {
          const from = gitRun(["branch", "--show-current"]).out;
          const name = `yai/${task.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task"}-${task.id.slice(0, 5)}`;
          if (gitRun(["switch", "-c", name]).ok) { bg = { from, name }; ui.note(c.dim(`working on a new branch: ${name}`)); push(task, [{ t: "ev", ev: { type: "note", text: `Working on a new branch: ${name} (it gets committed and pushed when done)` } }]); }
        }
      }
      await push(task, [], "running");
      print("");
      ui.userLine(task.text);
      ui.note(c.dim(`from your phone · ${{ default: "asks before changes", acceptEdits: "edits without asking", yolo: "auto-accepts everything", plan: "plan only" }[state.mode]}`));
      // What yAI says and does goes to the phone as events (its words, each step and result, each edit), in batches,
      // so the phone draws it like a chat (2026-10-21; it used to be the terminal's text).
      let queue = [];
      ui.setTap((ev) => { if (ev.type !== "user") queue.push({ t: "ev", ev }); });
      const flush = async () => {
        if (!queue.length) return;
        const batch = queue;
        queue = [];
        await push(task, batch);
      };
      const timer = setInterval(flush, 700);
      state.askHook = async ({ title, detail, options, edit }) => {
        const id = crypto.randomBytes(4).toString("hex");
        await flush();
        await push(task, [{ t: "ask", id, title, detail: edit ? diffText(edit) : detail || "", options }]);
        spinner.start("waiting for your answer on the phone");
        const choice = await new Promise((resolve) => R.answers.set(id, resolve));
        spinner.stop();
        await push(task, [{ t: "answered", id }]);
        ui.note(c.dim(`answered on the phone: ${options[choice] || "stop"}`));
        return choice;
      };
      let failedMsg = "";
      try {
        await runAgent(await expandMentions(task.text));
      } catch (err) {
        failedMsg = err.message;
      } finally {
        clearInterval(timer);
        ui.setTap(null);
        await flush();
        state.askHook = null;
        state.mode = before;
        R.current = null;
      }
      // the background branch: commit, push, and go back
      if (bg) {
        const ui2 = (t) => { ui.setTap((ev) => queue2.push({ t: "ev", ev })); ui.note(t); ui.setTap(null); };
        const queue2 = [];
        gitRun(["add", "-A"]);
        if (gitRun(["diff", "--cached", "--quiet"]).ok) {
          ui2(c.dim(`nothing changed, so ${bg.name} was removed`));
          gitRun(["switch", bg.from]);
          gitRun(["branch", "-D", bg.name]);
        } else {
          const msg = `yAI: ${task.text.split("\n")[0].slice(0, 70)}\n\nDone by yAI Code from a Remote task.`;
          const committed = gitRun(["-c", "user.name=yAI Code", "-c", `user.email=${api.cfg.user || "yai"}@users.noreply.yai`, "commit", "-q", "-m", msg]).ok;
          const hasRemote = gitRun(["remote"]).out.split("\n").includes("origin");
          const pushed = committed && hasRemote && gitRun(["push", "-u", "origin", bg.name]).ok;
          gitRun(["switch", bg.from]);
          ui2(committed ? (pushed ? `Committed on ${bg.name} and pushed to origin. Back on ${bg.from}.` : `Committed on ${bg.name}${hasRemote ? " (the push failed; push it yourself)" : " (no remote to push to)"}. Back on ${bg.from}.`) : c.yellow(`Couldn't commit on ${bg.name}; the changes are there, uncommitted.`));
        }
        await push(task, queue2);
      }
      const status = failedMsg ? "error" : state.interrupted ? "stopped" : "done";
      await push(task, [failedMsg ? { t: "error", text: failedMsg } : { t: "done", text: state.lastStats || "" }], status);
      state.interrupted = false;
    }
  } finally {
    R.stopped = true;
    pollAbort.abort();
    state.remote = null;
    await api.hub("remote-bye", { method: "POST", body: { machine: MACHINE_ID } }).catch(() => {});
    ui.note(c.dim("stopped listening for tasks"));
  }
}

// ---------- yai --stdio: the VS Code extension (2026-10-20) ----------
// One JSON object per line each way. In:  { type: "prompt", text } · { type: "command", text: "/compact" } ·
// { type: "answer", id, choice } · { type: "stop" } · { type: "mode", mode } · { type: "model", id }.
// Out: { type: "ready", version, user, model, models, mode, folder } · { type: "out", text } (what yai prints, with
// colours) · { type: "status", text, tokens, extra } · { type: "busy" } · { type: "ask", id, title, detail, options,
// edit?: { path, before, after, created } } · { type: "done", stats, cost, context, mode } · { type: "error", message }.
async function stdioMode() {
  state.stdio = true;
  const write = process.stdout.write.bind(process.stdout);
  const send = (obj) => write(JSON.stringify(obj) + "\n");
  // Everything yai prints becomes an "out" event, so the protocol lines stay whole.
  process.stdout.write = (chunk, enc, cb) => {
    const text = String(chunk);
    if (text) send({ type: "out", text });
    if (typeof enc === "function") enc();
    else if (typeof cb === "function") cb();
    return true;
  };
  ui.spinner.hook = (s) => send(s ? { type: "status", ...s } : { type: "status", text: null });
  ui.setSink(send); // the panel draws yAI's words, steps and diffs itself
  ui.setTheme(process.env.YAI_THEME || api.cfg.theme || "dark", { paint: false }); // VS Code says light or dark
  const answers = new Map();
  // /team's picker in the panel (2026-10-22): the rows go out, each one's tick and model come back
  const picks = new Map();
  state.pickTeamHook = (data) => {
    const id = crypto.randomBytes(4).toString("hex");
    send({ type: "team-pick", id, ...data });
    return new Promise((resolve) => picks.set(id, resolve));
  };
  state.askHook = ({ title, detail, options, edit }) => {
    const id = crypto.randomBytes(4).toString("hex");
    send({ type: "ask", id, title, detail: detail || "", options, ...(edit && { edit: { path: relPath(edit.abs), abs: edit.abs, before: edit.before, after: edit.after, created: !!edit.created } }) });
    return new Promise((resolve) => answers.set(id, resolve));
  };
  try {
    if (!(await api.me().catch(() => null))) {
      send({ type: "error", message: `Not signed in. Open a terminal, run yai once and sign in, then reopen this panel.`, auth: true });
      return process.exit(1);
    }
    state.user = api.cfg.user;
    await loadModels();
    if (!process.env.YAI_NO_MCP && MCP.configured().length) await MCP.startAll({ approve: async () => true }).catch(() => {});
    await CONN.load();
    FOCUS.boot(STARTUP_FOCUS, { quiet: true });
  } catch (err) {
    send({ type: "error", message: err.message });
    return process.exit(1);
  }
  const info = () => ({ model: state.model, models: state.models.map((m) => ({ id: m.id, label: m.label, price: !!m.price })), mode: state.mode, cost: state.cost, fallbacks: state.fallbacks || 0, context: contextPercent() });
  send({ type: "ready", version: VERSION, user: state.user, folder: root, ...info() });

  const work = [];
  let running = false;
  async function next() {
    if (running) return;
    running = true;
    while (work.length) {
      const job = work.shift();
      send({ type: "busy" });
      try {
        if (job.type === "command") await command(job.text);
        else {
          // /crew: helpers' reports that came while the main builder was idle open its next turn
          const waiting = ctx.crew?.reports.length ? ctx.crew.reports.splice(0).map((x) => `Your helper "${x.name}" has finished. Its report:\n${x.report}`).join("\n\n") + "\n\n" : "";
          await runAgent(waiting + (await expandMentions(job.text)));
        }
      } catch (err) {
        spinner.stop();
        send({ type: "error", message: err.message });
      }
      send({ type: "done", stats: state.lastStats || "", ...info() });
      state.interrupted = false;
    }
    running = false;
  }
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "prompt" && String(msg.text || "").trim()) { work.push({ type: "prompt", text: String(msg.text) }); next(); }
    else if (msg.type === "command" && /^\/\w+/.test(msg.text || "")) { work.push({ type: "command", text: String(msg.text) }); next(); }
    else if (msg.type === "answer") { const r = answers.get(msg.id); if (r) { answers.delete(msg.id); r(Number(msg.choice)); } }
    else if (msg.type === "team-pick-answer") { const r = picks.get(msg.id); if (r) { picks.delete(msg.id); r(msg.result || null); } }
    else if (msg.type === "team-action" && state.teamAction) state.teamAction(msg);
    else if (msg.type === "stop") {
      state.interrupted = true;
      state.abort?.abort();
      for (const r of answers.values()) r(-1);
      for (const r of picks.values()) r(null);
      picks.clear();
      answers.clear();
    } else if (msg.type === "mode" && MODES.includes(msg.mode)) { state.mode = msg.mode; send({ type: "done", stats: state.lastStats || "", ...info() }); }
    else if (msg.type === "model" && state.models.some((m) => m.id === msg.id)) { state.model = msg.id; prewarm(); send({ type: "done", stats: state.lastStats || "", ...info() }); }
    else if (msg.type === "new") { command("/clear").then(() => send({ type: "done", stats: "", ...info() })); }
    // from the /team board: a note read with the agent's next step result, and pause / resume between steps
    else if (msg.type === "note" && String(msg.text || "").trim()) (state.notes ||= []).push(String(msg.text).slice(0, 2000));
    // a directive from the watcher: an instruction, maybe with blocks, to acknowledge (see the step loop)
    else if (msg.type === "directive" && String(msg.text || "").trim()) (state.directives ||= []).push({ text: String(msg.text).slice(0, 1500), block: (Array.isArray(msg.block) ? msg.block : []).map(String).slice(0, 6), steps: Math.min(Math.max(Number(msg.steps) || 8, 2), 30) });
    // a message on the team chat from another agent (the board passes it on)
    else if (msg.type === "crew" && msg.name) { ctx.crew = ctx.crew || { open: new Set(), reports: [] }; ctx.crew.open.delete(String(msg.name)); ctx.crew.reports.push({ name: String(msg.name), report: String(msg.report || "(no report)").slice(0, 4000) }); }
    else if (msg.type === "chat" && String(msg.text || "").trim()) (state.chat ||= []).push(`${String(msg.from || "an agent").slice(0, 40)}${msg.to ? " (to you)" : ""}: ${String(msg.text).slice(0, 600)}`);
    else if (msg.type === "pause") state.paused = true;
    else if (msg.type === "resume") state.paused = false;
  });
  lines.on("close", () => process.exit(0));
}

// ---------- start ----------
function usage() {
  console.log(`yAI Code ${VERSION}

  yai                    start in the current folder
  yai -c, --continue     continue the last conversation in this folder
  yai -r, --resume       pick an earlier conversation in this folder
  yai remote             take tasks from your phone (${api.baseUrl()}/remote)
  yai --stdio            for the VS Code extension: JSON lines on stdin and stdout
  yai -p "task"          answer once and exit (read-only)
      --accept-edits     with -p: allow file edits
      --allow-commands   with -p: allow shell commands
  yai -m <model>         pick a model by name or number
  yai --plan             start in plan (read-only) mode
  yai --url <site>       use a different yAI site

Sign-in and settings are stored in ${path.join(api.DIR, "config.json")}`);
}

async function main() {
  const args = process.argv.slice(2);
  let printPrompt = null, modelArg = null, resume = false, remote = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") return usage();
    if (a === "-v" || a === "--version") return console.log(VERSION);
    if (a === "--stdio") return stdioMode();
    if (a === "remote" && i === 0) remote = true;
    else if (a === "-c" || a === "--continue") resume = "last";
    else if (a === "-r" || a === "--resume") resume = "pick";
    else if (a === "-m" || a === "--model") modelArg = args[++i];
    else if (a === "-p" || a === "--print") printPrompt = args[++i] || "";
    else if (a === "--plan") state.mode = "plan";
    else if (a === "--accept-edits") state.allowEdits = true;
    else if (a === "--allow-commands") state.allowCommands = true;
    else if (a === "--url") {
      api.cfg.url = args[++i];
      api.save();
    } else if (printPrompt === null && !a.startsWith("-")) printPrompt = a;
  }

  if (printPrompt !== null) {
    state.printMode = true;
    ui.setTheme(api.cfg.theme || "dark", { paint: false }); // a one-off answer leaves the terminal's colours alone
    if (!process.stdin.isTTY) {
      let piped = "";
      for await (const chunk of process.stdin) piped += chunk;
      if (piped.trim()) printPrompt += `\n\n${piped.trim()}`;
    }
    if (state.allowEdits) state.mode = "acceptEdits";
    await ensureLogin();
    await loadModels();
    if (modelArg) state.model = findModel(modelArg)?.id || state.model;
    if (!process.env.YAI_NO_MCP) await MCP.startAll();
    await runAgent(await expandMentions(printPrompt));
    process.exit(0);
  }

  if (!process.stdin.isTTY) {
    console.error("yai needs an interactive terminal. For scripts use: yai -p \"task\"");
    process.exit(1);
  }

  ui.setTheme(api.cfg.theme || "dark");
  process.on("exit", () => ui.resetTerminal()); // the terminal gets its own colours back however yai ends
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004h"); // bracketed paste: a paste arrives marked, so its line breaks don't send
    process.on("exit", () => process.stdout.write("\x1b[?2004l"));
  }
  setupReadline();
  await ensureLogin();
  try {
    await loadModels();
  } catch (err) {
    print(c.red(`Couldn't load models: ${err.message}`));
  }
  if (modelArg) {
    const m = findModel(modelArg);
    if (m) state.model = m.id;
    else print(c.yellow(`No model matches "${modelArg}".`));
  }

  // The full-window app, unless YAI_CLASSIC=1 asks for the plain scrolling terminal.
  if (!process.env.YAI_CLASSIC) {
    SCREEN.enter();
    syncMute();
  }
  // The start screen (v2): a greeting, what yAI saw in the project, four numbered starters, and the last conversation.
  const here = recentSessions(6).find((r) => r.here);
  const start = LOOK.welcome({ user: state.user, projectName: path.basename(root), root, version: VERSION, recent: here, logo: !SCREEN.on });
  for (const l of start) print(l);
  SCREEN.centerFirst(start.length + 1);
  if (prewarm()) print(`  ${c.faint(`${modelLabel()} is waking up in the background while you type`)}`);
  state.phase = "welcome";
  state.quick = {
    1: () => { state.prefix = "Fix this: "; state.hint = "Paste the error, or describe what's broken"; showPrompt(); },
    2: () => { state.prefix = "Add this feature. Plan it first, then ask before changing files: "; state.hint = "Describe the feature"; showPrompt(); },
    3: () => handleInput("Explain this project: give me a short tour of how the code fits together. Read the key files first."),
    4: () => handleInput("/review"),
    ...(here && { r: () => { state.quick = {}; state.phase = "ready"; resumeSession("last").then(showPrompt); } }),
  };

  // First time in a folder: ask before working in it.
  if (!project().trusted) {
    print("");
    const i = await select({
      title: "Trust this folder?", note: "yAI reads files here and asks before changes", detail: root,
      options: ["Yes, trust it", "Yes, for this session only", "No, quit"],
    });
    if (i === 0) {
      project().trusted = true;
      api.save();
    } else if (i !== 1) {
      print(c.dim("   OK. Start yai in a folder you trust."));
      return rl.close();
    }
  }

  CONN.load(); // the connected services, for the service tool (in the background)
  FOCUS.boot(STARTUP_FOCUS);
  // MCP servers start after the folder is trusted; their tools are ready by the time the first answer needs them.
  if (!process.env.YAI_NO_MCP && MCP.configured().length) {
    const announce = () => {
      const m = mcpSummary();
      if (m) ui.note(`${m.failed.length ? c.yellow("!") : c.green("✓")} ${c.ink("MCP: " + m.text)}${m.failed.length ? c.dim(` · didn't start: ${m.failed.join(", ")} (/mcp)`) : ""}`);
    };
    if (SCREEN.on) {
      // in the background: you can type straight away, and a message waits for them
      state.mcpStart = MCP.startAll({ approve: approveMcp }).catch(() => {}).then(() => { state.mcpStart = null; announce(); });
    } else {
      spinner.start("starting MCP servers");
      await MCP.startAll({ approve: approveMcp });
      spinner.stop();
      announce();
    }
  }
  if (resume) await resumeSession(resume === "last" ? "last" : "");
  if (remote) await remoteMode();
  showPrompt();
}

main().catch((err) => {
  spinner.stop();
  SCREEN.exit(); // back to the normal screen first, so the error stays readable
  console.error(c.red(err.message));
  ui.resetTerminal();
  process.exit(1);
});
