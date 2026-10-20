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

const VERSION = require("../package.json").version || "1.0.0";
const MODES = ["default", "acceptEdits", "plan"];
const MAX_STEPS = 50; // tool calls per request before yAI stops to check in
const TRIM_AT = 250_000; // characters of conversation before old tool output is dropped
const COMPACT_HINT_AT = 350_000;
const SAFE_COMMANDS = /^(git (status|diff|log|show|branch)|ls|dir|pwd|cat|type|Get-ChildItem|Get-Content|Get-Location|node (-v|--version|--check)|npm (-v|--version|ls)|where|which)\b/i;

// ---------- state ----------
const root = path.resolve(process.cwd());
const ctx = T.makeContext(root);
const state = {
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
};
const projectKey = crypto.createHash("sha1").update(root.toLowerCase()).digest("hex").slice(0, 16);
const project = () => ((api.cfg.projects ||= {})[projectKey] ||= { path: root, allowedCommands: [] });
const SESSION_FILE = path.join(api.DIR, "sessions", `${projectKey}.json`);
const HISTORY_FILE = path.join(api.DIR, "history");

// ---------- helpers ----------
const relPath = (abs) => T.rel(ctx, abs);
const modelLabel = (id = state.model) => state.models.find((m) => m.id === id)?.label || id || "no model";
const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

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
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ root, model: state.model, savedAt: new Date().toISOString(), messages: state.messages }));
  } catch {}
}

function gitBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
  } catch {
    return "";
  }
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
  const shell = process.platform === "win32" ? "PowerShell on Windows" : `bash on ${os.type()}`;
  const toolDocs = Object.entries(T.tools)
    .map(([name, t]) => `- ${name}(${t.params.join(", ")}): ${t.describe}`)
    .join("\n");
  const branch = gitBranch();
  return `You are yAI Code, a coding agent working in the user's terminal. You help with software tasks in their project: you read, search and edit files and run commands.

# Environment
- Project folder: ${root}${branch ? ` (git branch: ${branch})` : ""}
- Shell: ${shell}
- Date: ${new Date().toDateString()}
- Permission mode: ${state.mode === "plan" ? "PLAN (read-only: investigate, then present a plan; do not edit or run anything)" : state.mode === "acceptEdits" ? "edits are applied automatically" : "the user approves each edit and command"}
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
- Read a file before editing it. Copy <old> exactly from the read_file output, without the line numbers.
- Make small, focused edit_file changes; use write_file only for new files or full rewrites. Keep the project's existing style.
- A reply has a length limit. Write long files in parts of at most 60 lines: write_file with the first part, then write_file with <append>true</append> for the rest.
- If the user asks for text (an answer, an essay, an explanation) and doesn't ask for a file, reply with the text itself; don't write a file.
- After changing code, check it when you can (run the tests, or a quick syntax check such as node --check file.js).
- If a tool returns an error, fix the cause and try again instead of repeating the same call.
- Questions get answers, not edits. Don't change files the user didn't ask about.
- Be brief. Before a tool call, write at most one short sentence. When the task is done, say what you changed in a few sentences, without a tool call.
- Use Markdown sparingly; the user reads your replies in a terminal.${projectNotes()}`;
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
  return ` ${c.user("›")} `;
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

// How full the model's context is: the conversation and instructions against the model's window
// (24k tokens on the cloud GPU, about 8k for the local models), at roughly 3.6 characters a token.
const contextChars = () => (/cloud/.test(state.model) ? 24000 : 8192) * 3.6;
const usedChars = () => JSON.stringify(state.messages).length + systemPrompt().length;
function contextPercent() {
  return Math.min(100, Math.round((usedChars() / contextChars()) * 100));
}
// How much of a file or a command's output can go back to the model and still leave it room to
// answer. A small local model can't take a 400-line file whole, so the middle is cut instead.
function toolBudget() {
  return Math.max(2500, Math.min(40000, Math.floor(contextChars() * 0.85 - usedChars())));
}

// The line above the prompt: "main ● 2 modified   ctx 23%   approvals: ask        ⇧⇥ plan mode   /undo".
const MODE_NAMES = { default: "ask", acceptEdits: "auto-edit", plan: "plan · read-only" };
function footerLine() {
  const left = [];
  const git = gitStatus();
  if (git) left.push(c.faint(git.branch) + (git.modified ? " " + c.yellow(`● ${git.modified} modified`) : ""));
  left.push(c.faint(`ctx ${contextPercent()}%`));
  left.push(c.faint("approvals: ") + (state.mode === "default" ? c.faint("ask") : c.yellow(MODE_NAMES[state.mode])));
  const right = [c.faint(state.mode === "plan" ? "⇧⇥ leave plan" : "⇧⇥ plan mode"), c.faint(state.undo.length ? "/undo" : "/help")];
  return ui.footer(left, right);
}

function showPrompt() {
  if (state.printMode) return;
  print("");
  print(footerLine());
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
    process.stdout.write("\r\x1b[K\x1b[1A\r\x1b[K" + footerLine() + "\n");
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
    } else if (key.name === "tab" && key.shift && !state.busy && !state.asking) {
      setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);
    }
  });

  rl.on("SIGINT", () => {
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
  const saved = api.cfg.model;
  if (!state.models.some((m) => m.id === state.model)) {
    state.model = state.models.find((m) => m.id === saved)?.id || state.models.find((m) => /cloud/.test(m.id))?.id || data.default || state.models[0]?.id || "";
  }
}

// ---------- the agent loop ----------
function trimContext() {
  let size = JSON.stringify(state.messages).length;
  if (size < TRIM_AT) return;
  for (let i = 0; i < state.messages.length - 8 && size > TRIM_AT * 0.7; i++) {
    const m = state.messages[i];
    if (m.role === "user" && m.content.startsWith("<tool_result") && m.content.length > 400) {
      size -= m.content.length;
      m.content = m.content.split("\n")[0] + "\n[old tool output removed to save space]\n</tool_result>";
    }
  }
}

function parseToolCall(text) {
  const head = /(^|\n)[ \t]*<tool\s+name\s*=\s*["']?([\w-]+)["']?\s*>/.exec(text);
  if (!head) return null;
  const name = head[2];
  const rest = text.slice(head.index + head[0].length);
  let end = rest.search(/\n[ \t]*<\/tool>/);
  if (end < 0) end = rest.lastIndexOf("</tool>");
  if (end < 0) return { name, cutOff: true };
  const body = rest.slice(0, end) + "\n";
  const tool = T.tools[name];
  const args = {};
  for (const p of tool ? tool.params : []) {
    const open = body.indexOf(`<${p}>`);
    if (open < 0) continue;
    const from = open + p.length + 2;
    const close = ["content", "new"].includes(p) ? body.lastIndexOf(`</${p}>`) : body.indexOf(`</${p}>`, from);
    if (close < from) continue;
    args[p] = body.slice(from, close).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  }
  // Small models often skip the inner tags (<tool name="run">node --test</tool>) or use their own
  // (<cmd>, <file>). If none of the expected tags were found, the bare text is the first argument.
  if (tool && tool.params.length && !Object.keys(args).length) {
    const bare = body.replace(/<\/?[\w-]+>/g, "").trim();
    if (bare && !bare.includes("\n")) args[tool.params[0]] = bare;
  }
  const endTag = text.indexOf("</tool>", head.index + head[0].length + end);
  return { name, args, raw: text.slice(0, endTag >= 0 ? endTag + 7 : text.length) };
}

async function ensureWarm() {
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

  const write = ui.markdownWriter();
  let text = "", lineBuf = "", inTool = false, heldFence = null;
  const emit = (line) => {
    if (inTool) return;
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
    const { usage } = await api.chat({
      messages: state.messages,
      model: state.model,
      system: systemPrompt(),
      conversationId: state.conversationId,
      signal: local.signal,
      onTokens: (n) => {
        seen = n;
        spinner.tokens(n);
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
        while (!inTool && lineBuf.length > width && !/^\s*(<|```)/.test(lineBuf)) {
          const cut = lineBuf.lastIndexOf(" ", width);
          if (cut < width / 2) break;
          emit(lineBuf.slice(0, cut));
          lineBuf = lineBuf.slice(cut + 1);
        }
        const ts = text.search(/(^|\n)[ \t]*<tool[\s>]/);
        if (ts >= 0) {
          const after = text.slice(ts);
          if (/\n[ \t]*<\/tool>[ \t]*(\r?\n|$)/.test(after) || after.includes("<tool_result")) return false;
        }
      },
    });
    state.usage.out += usage?.out ?? seen; // a reply cut at a tool call has no final usage event
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
  return text;
}

// "Apply edit to math.js?" then "[Y] Yes  [A] Yes to All  [N] No  (default is "Y"):", PowerShell-style.
// One letter, Enter means yes.
async function askPermission(questionText, alwaysLabel) {
  spinner.stop();
  print(`   ${c.ink(questionText)}`);
  const line = ui.choices([["Y", "Yes"], ["A", alwaysLabel], ["N", "No"]], "Y");
  for (;;) {
    const raw = await question(line);
    if (raw === null) return { no: true, feedback: "" };
    const a = raw.trim().toLowerCase();
    if (a === "" || a === "y" || a === "yes" || a === "1") return "yes";
    if (a === "a" || a === "always" || a === "2") return "always";
    if (a === "n" || a === "no" || a === "3") {
      const fb = await question(`   ${c.ink("What should yAI do instead?")} ${c.dim("(Enter to just stop):")} `);
      return { no: true, feedback: (fb || "").trim() };
    }
  }
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
    if (tool.readOnly) return { output: tool.run(ctx, call.args) };

    if (state.mode === "plan" || (state.printMode && !state.allowEdits)) {
      ui.toolHeader(tool.kind === "run" ? "Shell" : "Edit", call.args.path || call.args.command || "");
      ui.toolResult(state.printMode ? "Not allowed here (read-only)" : "Skipped: plan mode is on", { color: c.yellow });
      return { output: "Not allowed: read-only mode. Do not edit files or run commands. Investigate with read-only tools, then describe your plan or answer." };
    }

    if (tool.kind === "edit") {
      const plan = tool.prepare(ctx, call.args);
      if (plan.before === plan.after) return { output: "No change: the new content is the same as the old." };
      const name = path.basename(plan.abs);
      T.showEdit(ctx, plan);
      if (state.mode !== "acceptEdits") {
        const ans = await askPermission(plan.created ? `Create ${name}?` : `Apply edit to ${name}?`, "Yes to All");
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
      const ans = await askPermission(`Run ${c.bold(ui.middle(shownCommand, ui.columns() - 12))}?`, chained ? "Yes, this once" : `Always for "${prefix}"`);
      if (ans.no) return rejected(ans);
      if (ans === "always" && !chained) {
        project().allowedCommands.push(prefix);
        api.save();
      }
      ui.toolHeader(process.platform === "win32" ? "PowerShell" : "Bash", shownCommand);
    }
    return { output: await T.execRun(ctx, call.args, state.abort.signal) };
  } catch (err) {
    spinner.stop();
    if (!(err instanceof T.ToolError) && !err.code) throw err;
    const shown = { read_file: "Read", list_files: "List", find_files: "Find", search: "Search", edit_file: "Update", write_file: "Write", run: "Bash" };
    ui.toolHeader(shown[call.name] || call.name, call.args.path || call.args.pattern || call.args.command || "(nothing given)");
    ui.toolResult(err.message, { color: c.red });
    return { output: `Error: ${err.message}` };
  }
}

function rejected(ans) {
  ui.note(`${c.red("✕")} ${c.dim("declined")}` + (ans.feedback ? c.dim(` · ${ans.feedback}`) : ""));
  if (!ans.feedback) return { output: "The user rejected this action and wants you to stop. Wait for their next instruction.", stop: true };
  return { output: `The user rejected this action and said: ${ans.feedback}` };
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
  try {
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
      if (!call) break;
      let result;
      if (call.cutOff) {
        // A model that keeps writing the same too-long step would loop forever; give it one more try.
        cutOffs++;
        if (cutOffs >= 2) {
          state.messages[state.messages.length - 1].content = "(my reply was cut off again)";
          ui.note(`${c.yellow("!")} ${c.ink("yAI's reply was cut off twice: it tried to write more than one reply can hold.")} ${c.dim("Ask for something shorter, or use a bigger model (/model).")}`);
          break;
        }
        result = { output: `Error: your ${call.name} call was cut off before </tool> because the reply hit its length limit, so nothing was written. Don't repeat it. Write the content in parts of at most 60 lines: write_file with the first part, then write_file with <append>true</append> for each next part. If the user only asked for text (an answer, an essay, an explanation), just reply with it instead of writing a file.` };
        ui.note(`${c.yellow("!")} ${c.dim("that step was cut off · asking yAI to split it up")}`);
      } else {
        cutOffs = 0;
        result = await execTool(call);
      }
      if (state.interrupted) {
        pushUser(`<tool_result name="${call.name}">\nInterrupted by the user.\n</tool_result>`);
        print(c.yellow("   ■ stopped") + c.dim(" · what should yAI do instead?"));
        return;
      }
      pushUser(`<tool_result name="${call.name}">\n${result.output}\n</tool_result>`);
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
    if (secs >= 5) print(c.faint(`\n done in ${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}${out ? ` · ${kTokens(out)} tokens` : ""}`));
    if (state.mode === "plan") print(c.dim(" ⇧⇥ to leave plan mode, then tell yAI to go ahead"));
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
}

// ---------- @file mentions and !commands ----------
function expandMentions(text) {
  const extra = [];
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
  ["/compact", "Summarize the conversation to free up context"],
  ["/init", "Write a YAI.md with notes about this project"],
  ["/status", "Account, model, folder and usage"],
  ["/login, /logout", "Sign in or out of your yAI account"],
  ["/plan", "Think first: read-only planning mode"],
  ["/undo", "Revert the last edit yAI made (not commands)"],
  ["/resume", "Continue the last conversation in this folder"],
  ["/theme [name]", "Midnight · Classic Blue · Paper · Amber"],
  ["/image [16:9] [@photo] <prompt>", "Make an image, or edit a photo; saved in yai-media/"],
  ["/video [16:9] <prompt>", "Make a 5-second video with sound; saved in yai-media/"],
  ["/config url <url>", "Point yai at a different yAI site"],
  ["/exit", "Quit (or Ctrl+C twice)"],
];
const COMMAND_NAMES = ["/help", "/model", "/mode", "/plan", "/undo", "/resume", "/theme", "/clear", "/compact", "/init", "/status", "/image", "/video", "/login", "/logout", "/config", "/exit"];

// ---------- /theme ----------
const THEME_KEYS = Object.keys(ui.THEMES);
async function chooseTheme(arg) {
  if (!arg) {
    print("");
    THEME_KEYS.forEach((k, i) => {
      const t = ui.THEMES[k];
      const mark = k === ui.themeKey ? c.accent("◆") : " ";
      print(` ${mark} ${String(i + 1)}. ${c.bold(c.ink(t.name.padEnd(13)))} ${c.dim(t.note)}`);
    });
    arg = ((await question(c.dim(" Pick a theme (number or name, Enter to keep): "))) || "").trim();
    if (!arg) return;
  }
  const q = arg.toLowerCase();
  const key = THEME_KEYS[Number(q) - 1] || THEME_KEYS.find((k) => k === q || ui.THEMES[k].name.toLowerCase().startsWith(q));
  if (!key) return print(c.yellow(`No theme matches "${arg}". Try midnight, blue, paper or amber.`));
  ui.setTheme(key);
  api.cfg.theme = key;
  api.save();
  ui.note(`${c.green("✓")} ${c.ink("Theme: " + ui.THEMES[key].name)}`);
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

// ---------- /resume ----------
function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}
function resumeSession() {
  const s = readSession();
  if (!s || !s.messages?.length) return print(c.dim("   No earlier conversation in this folder."));
  state.messages = s.messages;
  ui.note(`${c.green("✓")} ${c.ink(`Continuing “${sessionTitle(s)}”`)} ${c.dim(`· ${state.messages.length} messages · ${ago(s.savedAt)}`)}`);
}
// The first thing the user asked in a saved conversation, for the welcome box and /resume.
function sessionTitle(s) {
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
    print("");
    state.models.forEach((m, i) => {
      const mark = m.id === state.model ? c.accent("◆") : " ";
      print(` ${mark} ${String(i + 1).padStart(2)}. ${c.bold(c.ink(m.label))} ${c.dim("· " + (m.desc || m.id))}`);
    });
    if (state.localOffline) print(c.yellow("   The PC is offline, so only cloud models are listed."));
    arg = ((await question(c.dim(" Pick a model (number or name, Enter to keep): "))) || "").trim();
    if (!arg) return;
  }
  const m = findModel(arg);
  if (!m) return print(c.yellow(`No model matches "${arg}".`));
  state.model = m.id;
  api.cfg.model = m.id;
  api.save();
  ui.note(`${c.green("✓")} ${c.ink("Model: " + m.label)}` + (m.cloud || /cloud/.test(m.id) ? "" : c.dim(" · small local models can struggle with multi-step tool use")));
}

async function compact() {
  if (state.messages.length < 2) return print(c.dim("Nothing to compact yet."));
  state.busy = true;
  state.interrupted = false;
  state.abort = new AbortController();
  syncMute();
  const saved = state.messages;
  try {
    state.messages = [
      ...saved,
      {
        role: "user",
        content:
          "Summarize our conversation so far so we can continue in a fresh context. Include: what I asked for, decisions made, " +
          "files you changed and how, the current state, and what's left to do. Be specific with file paths and names. No tool calls.",
      },
    ];
    spinner.start("Compacting");
    let summary = "";
    await ensureWarm();
    await api.chat({
      messages: state.messages,
      model: state.model,
      system: systemPrompt(),
      conversationId: state.conversationId,
      signal: state.abort.signal,
      onTokens: (n) => spinner.tokens(n),
      onText: (p) => void (summary += p),
    });
    spinner.stop();
    if (!summary.trim()) throw new Error("The model returned an empty summary");
    state.messages = [
      { role: "user", content: `This conversation continues from an earlier one. Summary of it:\n\n${summary.replace(/<tool[\s\S]*$/, "").trim()}` },
      { role: "assistant", content: "Got it. I'll continue from there." },
    ];
    ctx.readFiles.clear();
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
      print("");
      for (const [n, d] of HELP) print(`  ${c.bold(c.ink(n.padEnd(34)))} ${c.dim(d)}`);
      print("");
      print(c.dim("  @path        attach a file or folder to your message (Tab completes)"));
      print(c.dim("  !command     run a shell command yourself; yAI sees the output"));
      print(c.dim("  esc          stop yAI · ⇧⇥ cycles ask / auto-edit / plan · paste works for multi-line text"));
      return;
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
      ctx.readFiles.clear();
      if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      return print(c.dim("New conversation."));
    case "/compact":
      return compact();
    case "/init":
      return runAgent(INIT_PROMPT);
    case "/image":
    case "/video":
      return makeMedia(cmd.slice(1), arg);
    case "/theme":
      return chooseTheme(arg);
    case "/undo":
      return undoLast();
    case "/resume":
      return resumeSession();
    case "/plan":
      state.mode = "plan";
      return ui.note(`${c.yellow("◆")} ${c.ink("plan mode")} ${c.dim("· read-only: yAI investigates and proposes a plan · ⇧⇥ to leave")}`);
    case "/status": {
      const tokens = Math.round(JSON.stringify(state.messages).length / 3.6);
      print("");
      print(`  Account   ${state.user ? c.green(state.user) : c.red("signed out")} ${c.dim("· " + api.baseUrl())}`);
      print(`  Model     ${modelLabel()}${state.localOffline ? c.yellow(" · PC offline, cloud only") : ""}`);
      print(`  Folder    ${root}`);
      print(`  Mode      ${{ default: "ask · asks before edits and commands", acceptEdits: "auto-edit · applies edits without asking", plan: "plan · read-only" }[state.mode]}`);
      print(`  Context   ~${kTokens(tokens)} tokens in ${state.messages.length} messages`);
      print(`  Usage     ↓ ${kTokens(state.usage.out)} tokens generated this session`);
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
      await runAgent(expandMentions(text));
    }
  } catch (err) {
    spinner.stop();
    print(c.red(err.message));
  }
  while (queue.length && !state.busy) {
    const next = queue.shift();
    ui.userLine(next);
    await runAgent(expandMentions(next));
  }
  showPrompt();
}

// ---------- start ----------
function usage() {
  console.log(`yAI Code ${VERSION}

  yai                    start in the current folder
  yai -c, --continue     continue the last conversation in this folder
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
  let printPrompt = null, modelArg = null, resume = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") return usage();
    if (a === "-v" || a === "--version") return console.log(VERSION);
    if (a === "-c" || a === "--continue") resume = true;
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
    ui.setTheme(api.cfg.theme || "midnight", { paint: false }); // a one-off answer leaves the terminal's colours alone
    if (!process.stdin.isTTY) {
      let piped = "";
      for await (const chunk of process.stdin) piped += chunk;
      if (piped.trim()) printPrompt += `\n\n${piped.trim()}`;
    }
    if (state.allowEdits) state.mode = "acceptEdits";
    await ensureLogin();
    await loadModels();
    if (modelArg) state.model = findModel(modelArg)?.id || state.model;
    await runAgent(expandMentions(printPrompt));
    process.exit(0);
  }

  if (!process.stdin.isTTY) {
    console.error("yai needs an interactive terminal. For scripts use: yai -p \"task\"");
    process.exit(1);
  }

  ui.setTheme(api.cfg.theme || "midnight");
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

  // The welcome box: workspace and git, the project notes, the last conversation, the account.
  const git = gitStatus();
  const rows = [["workspace", root, git ? c.dim(`(git: ${git.branch}, ${git.modified ? `${git.modified} modified` : "clean"})`) : ""]];
  const notes = ["YAI.md", "CLAUDE.md", "AGENTS.md"].find((n) => fs.existsSync(path.join(root, n)));
  if (notes) {
    const n = fs.readFileSync(path.join(root, notes), "utf8").split("\n").length;
    rows.push(["instructions", `${notes} loaded`, c.dim(`· ${n} lines`)]);
  } else rows.push(["instructions", "none yet", c.dim("· /init writes YAI.md")]);
  const saved = readSession();
  if (saved?.messages?.length && !resume) rows.push(["last session", `“${sessionTitle(saved)}”`, c.dim(`· ${ago(saved.savedAt)} · /resume`)]);
  rows.push(["account", state.user || "signed out", state.localOffline ? c.yellow("· PC offline, cloud models only") : ""]);
  ui.welcome({ version: VERSION, model: modelLabel(), shell: process.platform === "win32" ? "PowerShell" : path.basename(process.env.SHELL || "bash"), rows });

  // First time in a folder: ask before working in it.
  if (!project().trusted) {
    print("");
    print(` ${c.yellow("?")} ${c.ink("Trust this folder? yAI will read files and propose commands in")} ${c.bold(c.ink(root))}${c.ink(".")}`);
    for (;;) {
      const a = ((await question(` ${ui.choices([["Y", "Yes"], ["S", "Yes, this session only"], ["N", "No"], ["?", "Help"]], "Y").trimStart()}`)) || "").trim().toLowerCase();
      if (a === "" || a === "y" || a === "yes") {
        project().trusted = true;
        api.save();
        break;
      }
      if (a === "s") break;
      if (a === "n" || a === "no") {
        print(c.dim("   OK. Start yai in a folder you trust."));
        return rl.close();
      }
      print(c.dim("   yAI reads files in this folder and asks before it edits a file or runs a command. Trusting it just skips this question next time."));
    }
  }

  if (resume) resumeSession();
  print("");
  const hint = (cmd, text) => `${c.dim(cmd)} ${c.faint(text)}`;
  print(" " + [hint("/plan", "think first"), hint("/undo", "revert last edit"), hint("/image", "make an image"), hint("/theme", "colours"), hint("@file", "attach")].join("   "));
  showPrompt();
}

main().catch((err) => {
  spinner.stop();
  console.error(c.red(err.message));
  ui.resetTerminal();
  process.exit(1);
});
