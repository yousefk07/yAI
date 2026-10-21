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
const MODES = ["default", "acceptEdits", "plan"];
const MAX_STEPS = 50; // tool calls per request before yAI stops to check in
// Share of the model's window at which old tool output is dropped, and at which the conversation is
// summarized automatically so a task never stops at 100%.
const TRIM_AT = 0.75;
const AUTO_COMPACT_AT = 0.9;
const COMPACT_HINT_AT = 350_000;
const SAFE_COMMANDS = /^(git (status|diff|log|show|branch)|ls|dir|pwd|cat|type|Get-ChildItem|Get-Content|Get-Location|node (-v|--version|--check)|npm (-v|--version|ls)|where|which)\b/i;

// ---------- state ----------
const root = path.resolve(process.cwd());
const ctx = T.makeContext(root);
const state = {
  pasted: [], // clipboard images pasted this session: [image N] is pasted[N - 1]
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
  let lines = ui.selectLines({ ...opts, selected: sel });
  for (const l of lines) process.stdout.write(l + "\n");
  const wasMuted = ui.rlOutput.muted;
  ui.rlOutput.muted = true;
  state.selecting = true;
  return new Promise((resolve) => {
    const redraw = () => {
      const next = ui.selectLines({ ...opts, selected: sel });
      process.stdout.write(`\x1b[${lines.length}A`);
      for (const l of next) process.stdout.write("\r\x1b[K" + l + "\n");
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
      process.stdout.write(`\x1b[${lines.length}A\r\x1b[J`);
      rl.write(null, { ctrl: true, name: "u" });
      ui.rlOutput.muted = wasMuted;
      resolve(i);
    };
    const onKey = (s, key = {}) => {
      if (key.name === "up" || key.name === "k") { sel = (sel + opts.options.length - 1) % opts.options.length; redraw(); }
      else if (key.name === "down" || key.name === "j" || key.name === "tab") { sel = (sel + 1) % opts.options.length; redraw(); }
      else if (key.name === "return" || key.name === "enter") done(sel);
      else if (key.name === "escape" || (key.ctrl && key.name === "c")) done(-1);
      else if (/^[1-9]$/.test(s || "") && Number(s) <= opts.options.length) { sel = Number(s) - 1; redraw(); done(sel); }
    };
    state.cancelSelect = () => done(-1);
    process.stdin.on("keypress", onKey);
  });
}

// ---------- /help: the commands, grouped, in columns ----------
const HELP_GROUPS = [
  ["Session", [["/clear", "start a new conversation"], ["/resume", "pick an earlier conversation"], ["/compact", "summarise (/compact <focus>)"], ["/undo", "revert yAI's last edit"], ["/share", "publish at an unlisted link"]]],
  ["Model", [["/model", "switch model"], ["/duo", "plan + review with 2 models"], ["/bench", "run the coding benchmark"], ["/status", "account, model and usage"], ["/usage", "today's limits, last 30 days"]]],
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
const SPEED = { "kimi-k3-ultra": "~48 tok/s", "deepseek-v4.1-flash": "fast", "qwen3-coder-30b-cloud": "~60 tok/s" };
async function modelPicker() {
  let ultraLeft = "";
  try {
    const u = await (await fetch(`${api.baseUrl()}/api/hub?op=usage`, { headers: { Cookie: api.cfg.cookie || "", "User-Agent": "yai-code/1.0" } })).json();
    if (u.today) ultraLeft = `$${Math.max(0, u.today.ultra.limitUsd - u.today.ultra.spentUsd).toFixed(2)} left`;
  } catch {}
  const W = { name: 24, where: 10, ctx: 9, speed: 11 };
  const rowOf = (m) => {
    const where = m.price || m.id === "kimi-k3-ultra" ? "hosted" : m.cloud || /cloud/.test(m.id) ? "cloud GPU" : "your PC";
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

function systemPrompt() {
  const shell = process.platform === "win32"
    ? "Windows PowerShell 5.1 (chain commands with ; — a && b and a || b also work, yAI converts them)"
    : `bash on ${os.type()}`;
  const toolDocs = Object.entries(T.tools)
    .map(([name, t]) => `- ${name}(${t.params.join(", ")}): ${t.describe}`)
    .join("\n");
  const branch = gitBranch();
  return `You are yAI Code, a coding agent working in the user's terminal. You help with software tasks in their project: you read, search and edit files and run commands.

# Environment
- Project folder: ${root}${branch ? ` (git branch: ${branch})` : nestedRepos().length ? ` (not a git repository; these folders in it are: ${nestedRepos().join(", ")} — run git there with git -C <folder> ...)` : ""}
- Shell: ${shell}
- Date: ${new Date().toDateString()}
- Permission mode: ${state.tutor ? "TUTOR (you may read files and run commands such as tests; editing files is off)" : state.mode === "plan" ? "PLAN (read-only: investigate, then present a plan; do not edit or run anything)" : state.mode === "acceptEdits" ? "edits are applied automatically" : "the user approves each edit and command"}
- Top-level files: ${topLevel() || "(empty folder)"}
All paths are relative to the project folder. You cannot access anything outside it.

# Tools
To use a tool, end your message with a block in exactly this format, each tag on its own line:

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
</tool>

Available tools:
${toolDocs}

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
- Be brief. Before a tool call, write at most one short sentence. When the task is done, say what you changed in a few sentences, without a tool call.
- Use Markdown sparingly; the user reads your replies in a terminal.${state.tutor ? X.TUTOR_PROMPT : ""}${projectNotes()}`;
}

// ---------- readline, prompt and keys ----------
let rl;
let lastCtrlC = 0;
const queue = [];

function syncMute() {
  ui.rlOutput.muted = state.busy && !state.asking;
}

// The prompt: "› ", with a faint hint while it's empty.
const PLACEHOLDER = "Ask yAI, or / for commands";
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
const MODE_NAMES = { default: "ask before running", acceptEdits: "auto-approve edits", plan: "plan · read-only" };
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

function showPrompt() {
  if (state.printMode) return;
  print("");
  print(footerLine());
  print(ruleLine());
  rl.setPrompt(promptText());
  rl.prompt(true);
  showPlaceholder();
}
function showPlaceholder() {
  if (!process.stdout.isTTY || rl.line) return;
  process.stdout.write(c.faint(PLACEHOLDER) + `\x1b[${PLACEHOLDER.length}D`);
  state.placeholder = true;
}

function setMode(mode, { announce = true } = {}) {
  state.mode = mode;
  if (announce && !state.busy) {
    process.stdout.write("\r\x1b[K\x1b[2A\r\x1b[K" + footerLine() + "\n" + ruleLine() + "\n");
    rl.setPrompt(promptText());
    rl.prompt(true);
    showPlaceholder();
  }
}

// rl.question, but the answer doesn't end up in the ↑ history.
// Returns null if the user pressed Esc.
function question(q, { hidden = false } = {}) {
  state.asking = true;
  state.escAnswer = false;
  syncMute();
  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(q);
      ui.rlOutput.muted = true;
    }
    rl.question(hidden ? "" : q, (answer) => {
      if (rl.history && rl.history[0] === answer) rl.history.shift();
      if (hidden) {
        ui.rlOutput.muted = false;
        process.stdout.write("\n");
      }
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

  process.stdin.on("keypress", (s, key) => {
    if (state.selecting) return;
    // The first key clears the faint hint (readline has already drawn the key; this wipes the rest).
    if (state.placeholder && !state.asking) {
      state.placeholder = false;
      process.stdout.write("\x1b[K");
    }
    if (!key) return;
    if (key.name === "escape") {
      if (state.asking) {
        state.escAnswer = true;
        rl.write(null, { ctrl: true, name: "u" });
        rl.write("\n");
      } else if (state.busy && state.abort) {
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
    process.stdout.write("\r\x1b[K" + c.dim("Press Ctrl+C again to exit") + "\n");
    rl.prompt(true);
  });

  rl.on("close", () => {
    try {
      fs.mkdirSync(api.DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, [...rl.history].reverse().join("\n") + "\n");
    } catch {}
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
  const saved = api.cfg.modelPicked === 3 ? api.cfg.model : undefined;
  if (!state.models.some((m) => m.id === state.model)) {
    state.model = state.models.find((m) => m.id === saved)?.id || data.default || state.models.find((m) => /cloud/.test(m.id))?.id || state.models[0]?.id || "";
  }
}

// ---------- the agent loop ----------
// When the conversation passes TRIM_AT of the window, old tool output (oldest first, the last few messages
// kept) becomes a one-line note until it is back near 60%.
function trimContext() {
  const limit = contextChars();
  if (usedChars() < limit * TRIM_AT) return;
  for (let i = 0; i < state.messages.length - 4 && usedChars() > limit * 0.6; i++) {
    const m = state.messages[i];
    if (m.role === "user" && typeof m.content === "string" && m.content.startsWith("<tool_result") && m.content.length > 400) {
      m.content = m.content.split("\n")[0] + "\n[old tool output removed to save space; read the file again if you need it]\n</tool_result>";
    }
  }
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
  let end = rest.search(/\n[ \t]*<\/tool>/);
  if (end < 0) end = rest.lastIndexOf("</tool>");
  if (end < 0) return { name, cutOff: true };
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
  let text = "", lineBuf = "", inTool = false, heldFence = null;
  const emit = (line) => {
    if (inTool) return;
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
  try {
    const price = state.models.find((m) => m.id === state.model)?.price; // US$ per million tokens (yAI Ultra)
    const promptTokens = usedChars() / 3.6;
    const { usage, cost } = await api.chat({
      messages: state.messages,
      model: state.model,
      system: systemPrompt(),
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
        text += piece;
        lineBuf += piece;
        let i;
        while ((i = lineBuf.indexOf("\n")) !== -1) {
          emit(lineBuf.slice(0, i).replace(/\r$/, ""));
          lineBuf = lineBuf.slice(i + 1);
        }
        // Show long paragraphs as they arrive, wrapped at the terminal width.
        const width = ui.textWidth();
        while (!inTool && lineBuf.length > width && !/^\s*(<|```)/.test(lineBuf) && !lineBuf.includes("<|")) {
          const cut = lineBuf.lastIndexOf(" ", width);
          if (cut < width / 2) break;
          emit(lineBuf.slice(0, cut));
          lineBuf = lineBuf.slice(cut + 1);
        }
        if (text.includes("<|close|>tools")) return false; // Kimi K3's tool call is complete
        if (DSML_END.test(text)) return false; // DeepSeek's tool call is complete
        const ts = text.search(/(^|\n)[ \t]*<tool[\s>]/);
        if (ts >= 0) {
          const after = text.slice(ts);
          if (/\n[ \t]*<\/tool>[ \t]*(\r?\n|$)/.test(after) || after.includes("<tool_result")) return false;
        }
      },
    });
    state.usage.out += usage?.out ?? seen; // a reply cut at a tool call has no final usage event
    if (cost) {
      state.cost.session += cost.usd;
      if (cost.todayUsd != null) state.cost.todayUsd = cost.todayUsd;
      if (cost.limitUsd != null) state.cost.limitUsd = cost.limitUsd;
    } else if (price) state.cost.session += (promptTokens * price.in + (usage?.out ?? seen) * price.out) / 1e6; // cut short: estimate
    seen = 0;
  } catch (err) {
    if (!state.interrupted) {
      spinner.stop();
      if (lineBuf) emit(lineBuf);
      throw err;
    }
  } finally {
    state.usage.out += seen;
    outer.signal.removeEventListener("abort", onOuter);
    local.abort(); // closes the stream; the server then stops the model
  }
  if (lineBuf && !state.interrupted) emit(lineBuf.replace(/\r$/, ""));
  if (heldFence !== null && !inTool) write(heldFence);
  if (process.env.YAI_DEBUG_DIR) {
    try { fs.writeFileSync(path.join(process.env.YAI_DEBUG_DIR, `reply-${Date.now()}.txt`), text); } catch {}
  }
  return fromDeepSeek(fromKimi(text));
}

// DeepSeek V4.1 Flash (yAI Ultra Flash) writes tool calls in its own markup (DSML, with full-width bars), e.g.
//   <｜DSML｜ calls><｜DSML｜ invoke name="write_file"><｜DSML｜ parameter name="path" string="true">snake.html</｜DSML｜ parameter>…
//   </｜DSML｜ invoke></｜DSML｜ calls>
// It becomes the usual <tool> block. A call cut off before </…invoke> is left without </tool>, so it counts as cut off.
const DSML_START = /<｜DSML｜\s*(?:function_)?calls>|<｜DSML｜\s*invoke\b/;
const DSML_END = /<\/｜DSML｜\s*(?:(?:function_)?calls|invoke)>/;
function fromDeepSeek(text) {
  const m = DSML_START.exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index).trimEnd();
  const block = text.slice(m.index);
  const inv = /<｜DSML｜\s*invoke\s+name="([\w-]+)"[^>]*>([\s\S]*?)(<\/｜DSML｜\s*invoke>|$)/.exec(block);
  if (!inv) return before;
  const params = [...inv[2].matchAll(/<｜DSML｜\s*parameter\s+name="([\w-]+)"[^>]*>([\s\S]*?)<\/｜DSML｜\s*parameter>/g)];
  const body = params.map(([, key, value]) => {
    const v = /^(content|new|old|new_str|old_str|text)$/.test(key) ? value.replace(/^\r?\n/, "").replace(/\r?\n$/, "") : value.trim();
    return `<${key}>\n${v}\n</${key}>`;
  }).join("\n");
  // No parameter tags: the arguments may be written as JSON inside the invoke.
  const json = !params.length && /^\s*\{[\s\S]*\}\s*$/.test(inv[2]) ? inv[2].trim() : "";
  return `${before}\n\n<tool name="${inv[1]}">\n${body || json}${inv[3] ? "\n</tool>" : ""}`;
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
async function askPermission(title, alwaysLabel, detail) {
  spinner.stop();
  const options = ["Yes", alwaysLabel, "No, tell yAI what to do instead"];
  const editPlan = state.pendingEdit;
  state.pendingEdit = null;
  const i = state.askHook ? await state.askHook({ title, detail, options, edit: editPlan }) : await select({ title, detail, options });
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
    if (tool.readOnly) return { output: await tool.run(ctx, call.args) };

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
        if (!state.printMode && !allowedMcp.includes(call.name)) {
          ui.cancelRow();
          const ans = await askPermission("Use this MCP tool?", "Yes, and don't ask again for this tool", `${tool.server} · ${tool.tool}`);
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
      T.showEdit(ctx, plan);
      if (state.mode !== "acceptEdits") {
        state.pendingEdit = plan; // the phone and VS Code show the change itself
        const ans = await askPermission(plan.created ? `Create ${name}?` : `Apply this edit to ${name}?`, "Yes, and apply edits without asking");
        if (ans.no) return rejected(ans);
        if (ans === "always") state.mode = "acceptEdits";
      }
      state.undo.push({ abs: plan.abs, before: plan.before, created: plan.created });
      T.applyEdit(ctx, plan);
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
    if (!allowed && !(state.printMode && state.allowCommands)) {
      // The question shows the command, so the waiting step row is dropped and redrawn after.
      ui.cancelRow();
      const prefix = commandPrefix(command);
      const ans = await askPermission("Run this command?", chained ? "Yes, this once" : `Yes, and don't ask again for ${prefix}`, shownCommand);
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
async function runAgent(content) {
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
  const undoStart = state.undo.length;
  let reviewed = false;
  let nudges = 0; // replies that announced a step but stopped before it
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
      const text = await callModel();
      spinner.stop();
      if (state.interrupted) {
        if (text.trim()) state.messages.push({ role: "assistant", content: text });
        print(c.yellow("   ■ stopped") + c.dim(" · what should yAI do instead?"));
        return;
      }
      // An empty reply usually means the conversation no longer fits the model; say so instead of
      // ending silently.
      if (!text.trim()) {
        state.messages.push({ role: "assistant", content: "(no reply)" });
        const full = contextPercent() >= 85;
        ui.note(`${c.yellow("!")} ${c.ink("No reply from the model.")} ${c.dim(full ? "The conversation is too long for it: /compact, /clear, or a bigger model with /model." : "Try again, or pick another model with /model.")}`);
        break;
      }
      const call = parseToolCall(text);
      state.messages.push({ role: "assistant", content: call && call.raw ? call.raw : text });
      if (!call) {
        // "Now I'll create the CSS file:" and then nothing: the model said what it would do and ended its reply
        // without the tool call (yAI 3 Coder does this a lot). Push it on, at most twice per request.
        if (announcesStep(text) && nudges < 2) {
          nudges++;
          ui.note(c.dim("· it stopped before the step it described · continuing"));
          pushUser("Go ahead: make that tool call now (the <tool> block), without repeating what you're about to do.");
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
      if (call.cutOff) {
        // No </tool>: either the reply really hit its length limit (a long one), or a small model simply
        // stopped without finishing the step (a short one). They need different advice. Two in a row
        // and yAI stops, so a model stuck on the same mistake can't loop.
        const long = text.length > 6000;
        cutOffs++;
        if (cutOffs >= 2) {
          state.messages[state.messages.length - 1].content = long ? "(my reply was cut off again)" : "(I didn't finish that step again)";
          ui.note(`${c.yellow("!")} ${c.ink(long ? "yAI's reply was cut off twice: it tried to write more than one reply can hold." : "yAI twice wrote a step without finishing it.")} ${c.dim(long ? "Ask for something shorter, or use a bigger model (/model)." : "Small models do this; try a bigger one (/model).")}`);
          break;
        }
        result = {
          output: long
            ? `Error: your ${call.name} call was cut off before </tool> because the reply hit its length limit, so nothing was written. Don't repeat it. Write the content in parts of at most 60 lines: write_file with the first part, then write_file with <append>true</append> for each next part. If the user only asked for text (an answer, an essay, an explanation), just reply with it instead of writing a file.`
            : `Error: your ${call.name} call isn't finished: it never reached </tool>, so nothing happened. Write the whole step again, with every tag opened and closed (for edit_file: <path>, then <old>…</old>, then <new>…</new>), ending with </tool> on its own line.`,
        };
        ui.note(`${c.yellow("!")} ${c.dim(long ? "that step was cut off · asking yAI to split it up" : "that step wasn't finished · asking yAI to write it again")}`);
      } else {
        cutOffs = 0;
        result = await execTool(call);
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
        const cmd = String((call.args || {}).command || "").trim().toLowerCase();
        if (!failed) failedRuns = 0;
        else {
          failedRuns++;
          if (failedCommands.has(cmd)) result.output += "\nThis exact command already failed earlier in this task. Don't run it again; work out why it fails first.";
          failedCommands.add(cmd);
          if (failedRuns === 3) result.output += "\nThree commands in a row have failed. Stop trying variations: read the error, check your assumptions (does the path exist? is it a file or a folder?), and if you still can't see why, tell the user what's going wrong.";
        }
      }
      pushUser(`<tool_result name="${call.name}">\n${result.output}\n</tool_result>`);
      if (failedRuns >= 5) {
        ui.note(`${c.yellow("!")} ${c.ink("Five commands in a row failed, so yAI stopped.")} ${c.dim("Tell it what to do differently, or try a bigger model (/model).")}`);
        break;
      }
      // The same failing step over and over (a small model stuck on one mistake): stop after three.
      if (String(result.output).startsWith("Error") && result.output === lastError) {
        if (++sameError >= 2) {
          ui.note(`${c.yellow("!")} ${c.ink("yAI kept repeating the same failing step, so it was stopped.")} ${c.dim("Try a bigger model (/model) or rephrase the request.")}`);
          break;
        }
      } else sameError = 0;
      lastError = result.output;
      if (result.stop) return;
      if (step === MAX_STEPS - 1) print(c.yellow(`   ‖ paused after ${MAX_STEPS} steps · say "continue" to keep going`));
    }
    const secs = Math.round((Date.now() - started) / 1000);
    const out = state.usage.out - startOut;
    const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    state.lastStats = out ? `↓ ${kTokens(out)} tok · ${Math.round(out / Math.max(1, secs))} tok/s · ${took}` : `done in ${took}`;
    if (state.mode === "plan" && !state.printMode && !state.interrupted) planReady = true;
    if (JSON.stringify(state.messages).length > COMPACT_HINT_AT) print(c.yellow(" context is getting long · /compact summarizes it so you can keep going"));
  } catch (err) {
    spinner.stop();
    print(c.red(`   ✕ ${err.message}`));
    if (err.auth) state.user = null;
  } finally {
    spinner.stop();
    state.busy = false;
    state.abort = null;
    syncMute();
    saveSession();
  }
  if (planReady) await approvePlan();
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
    process.stdout.write(`\r\x1b[K${c.faint("   no image on the clipboard")}\n`);
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
  ["/duo", "Two models: yAI Q3.8 Max (or another hosted model) plans and reviews, the coder writes"],
  ["/tutor", "Learning mode: hints and explanations, no finished solutions"],
  ["/share", "Publish this conversation at an unlisted link"],
  ["/bench [model]", "Run the 6-task coding benchmark (44 tests) on a model; scores go to the leaderboard"],
  ["/mcp [add|remove|restart]", "MCP servers and their tools (also read from .mcp.json)"],
  ["/tasks [stop n]", "Commands yAI left running in the background (dev servers, watchers)"],
  ["/web <question>", "Search the web and answer from the results, with sources"],
  ["/image [16:9] [@photo] <prompt>", "Make an image, or edit a photo; saved in yai-media/"],
  ["/video [16:9] <prompt>", "Make a 5-second video with sound; saved in yai-media/"],
  ["/config url <url>", "Point yai at a different yAI site"],
  ["/exit", "Quit (or Ctrl+C twice)"],
];
const COMMAND_NAMES = ["/help", "/model", "/mode", "/plan", "/undo", "/resume", "/clone", "/remote", "/theme", "/clear", "/compact", "/init", "/status", "/usage", "/paste", "/fix", "/review", "/commit", "/look", "/showcase", "/duo", "/tutor", "/share", "/bench", "/web", "/mcp", "/tasks", "/image", "/video", "/login", "/logout", "/config", "/exit"];

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
const STEP_NAMES = { read_file: "Read", list_files: "List", find_files: "Find", search: "Search", edit_file: "Edit", write_file: "Create", run: "Run", web_search: "Web search", web_fetch: "Fetch", task_output: "Task output", task_stop: "Stop task" };
function redrawTranscript() {
  if (!process.stdout.isTTY || state.printMode) return;
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
      const want = { default: "default", ask: "default", accept: "acceptEdits", edits: "acceptEdits", auto: "acceptEdits", "auto-edit": "acceptEdits", plan: "plan" }[arg.toLowerCase()];
      state.mode = want || MODES[(MODES.indexOf(state.mode) + 1) % MODES.length];
      return print(c.dim(`   mode: ${{ default: "ask · asks before edits and commands", acceptEdits: "auto-edit · applies edits without asking", plan: "plan · read-only" }[state.mode]}`));
    }
    case "/clear":
    case "/new":
      state.messages = [];
      state.pendingContext = [];
      state.conversationId = crypto.randomUUID();
      state.title = null;
      ctx.readFiles.clear();
      if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
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
      print(`  Mode      ${{ default: "ask · asks before edits and commands", acceptEdits: "auto-edit · applies edits without asking", plan: "plan · read-only" }[state.mode]}${state.tutor ? " · tutor" : ""}${state.duo ? " · duo" : ""}`);
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
      print(c.yellow(`Unknown command ${cmd}. Type /help.`));
  }
}

// readline has echoed what was typed after "› "; redraw it as the user's message on the panel.
function restyleInput(text) {
  if (!process.stdout.isTTY || text.includes("\n")) return;
  const rows = Math.max(1, Math.ceil((3 + text.length) / ui.columns()));
  process.stdout.write("\x1b[1A\r\x1b[K".repeat(rows));
  ui.userLine(text);
}

async function handleInput(input) {
  state.placeholder = false;
  const text = input.trim();
  if (!text) return showPrompt();
  restyleInput(input);
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
  const hello = () => api.hub("remote-hello", { method: "POST", body: { machine: MACHINE_ID, name: os.hostname(), folder: root, model: modelLabel() } });
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
      state.mode = ["default", "acceptEdits", "plan"].includes(task.mode) ? task.mode : "default";
      await push(task, [{ t: "out", text: `› ${task.text}\n` }], "running");
      print("");
      ui.userLine(task.text);
      ui.note(c.dim(`from your phone · ${{ default: "asks before changes", acceptEdits: "edits without asking", plan: "plan only" }[state.mode]}`));
      // What yai prints goes to the phone too, in batches.
      const write = process.stdout.write.bind(process.stdout);
      let buf = "";
      process.stdout.write = (chunk, ...rest) => { buf += String(chunk); return write(chunk, ...rest); };
      const flush = async () => {
        const cut = buf.lastIndexOf("\n");
        if (cut < 0) return;
        const text = plainLines(buf.slice(0, cut + 1));
        buf = buf.slice(cut + 1);
        if (text.trim()) await push(task, [{ t: "out", text }]);
      };
      const timer = setInterval(flush, 900);
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
        buf += "\n";
        await flush();
        process.stdout.write = write;
        state.askHook = null;
        state.mode = before;
        R.current = null;
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
  } catch (err) {
    send({ type: "error", message: err.message });
    return process.exit(1);
  }
  const info = () => ({ model: state.model, models: state.models.map((m) => ({ id: m.id, label: m.label, price: !!m.price })), mode: state.mode, cost: state.cost, context: contextPercent() });
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
        else await runAgent(await expandMentions(job.text));
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
    else if (msg.type === "stop") {
      state.interrupted = true;
      state.abort?.abort();
      for (const r of answers.values()) r(-1);
      answers.clear();
    } else if (msg.type === "mode" && MODES.includes(msg.mode)) { state.mode = msg.mode; send({ type: "done", stats: state.lastStats || "", ...info() }); }
    else if (msg.type === "model" && state.models.some((m) => m.id === msg.id)) { state.model = msg.id; prewarm(); send({ type: "done", stats: state.lastStats || "", ...info() }); }
    else if (msg.type === "new") { command("/clear").then(() => send({ type: "done", stats: "", ...info() })); }
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

  // The welcome box (the design's start screen): model, project, instructions, account.
  const rows = welcomeRows();
  if (prewarm()) rows.push(["gpu", "waking up", c.faint("· in the background while you type")]);
  ui.welcome({ version: VERSION, rows });

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

  // MCP servers start after the folder is trusted; their tools are ready by the time the first answer needs them.
  if (!process.env.YAI_NO_MCP && MCP.configured().length) {
    spinner.start("starting MCP servers");
    await MCP.startAll({ approve: approveMcp });
    spinner.stop();
    const m = mcpSummary();
    if (m) ui.note(`${m.failed.length ? c.yellow("!") : c.green("✓")} ${c.ink("MCP: " + m.text)}${m.failed.length ? c.dim(` · didn't start: ${m.failed.join(", ")} (/mcp)`) : ""}`);
  }
  if (resume) await resumeSession(resume === "last" ? "last" : "");
  if (remote) await remoteMode();
  // Tips and recent sessions, as in the design's start screen
  print("");
  const k = (key, text) => `${c.accent(key)}  ${c.dim(text)}`;
  print(` ${c.faint("Tips")}`);
  print(` ${[k("/model", "switch model"), k("@", "mention a file"), k("/help", "all commands")].join("     ")}`);
  print(` ${[k("shift+tab", "cycle ask · auto-approve · plan"), k("!", "run a command yourself")].join("     ")}`);
  const recent = recentSessions(3);
  if (recent.length) {
    print("");
    print(` ${c.faint("Recent sessions")}`);
    for (const r of recent) print(` ${c.faint(r.when.padEnd(12))}${c.ink(r.title)}${r.here ? c.faint("  · /resume") : c.faint(`  · ${r.folder}`)}`);
  }
  showPrompt();
}

main().catch((err) => {
  spinner.stop();
  console.error(c.red(err.message));
  ui.resetTerminal();
  process.exit(1);
});
