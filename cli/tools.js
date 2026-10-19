"use strict";
// The agent's tools. Every path is resolved inside the folder yai was started in;
// edits and commands go through the permission check in index.js first.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { c, print, toolHeader, toolResult, renderDiff, spinner } = require("./ui");

const IGNORED = new Set([".git", "node_modules", ".next", ".vercel", "dist", "build", "coverage", "__pycache__", ".venv", "venv", ".cache", ".turbo"]);
const MAX_OUTPUT = 20000; // characters of tool output sent back to the model
const MAX_FILE_BYTES = 2_000_000;
const WIN = process.platform === "win32";

class ToolError extends Error {}

function makeContext(root) {
  const ignore = new Set(IGNORED);
  const ignoreExt = [];
  try {
    // Plain names and "*.ext" lines from .gitignore; anything fancier is ignored.
    for (const raw of fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/)) {
      const l = raw.trim().replace(/^\/|\/$/g, "");
      if (!l || l.startsWith("#") || l.startsWith("!")) continue;
      if (/^\*\.[\w.]+$/.test(l)) ignoreExt.push(l.slice(1));
      else if (!/[*?[\]/]/.test(l)) ignore.add(l);
    }
  } catch {}
  return { root, readFiles: new Set(), ignore, ignoreExt };
}

const rel = (ctx, abs) => path.relative(ctx.root, abs).split(path.sep).join("/") || ".";
const skip = (ctx, name) => ctx.ignore.has(name) || ctx.ignoreExt.some((e) => name.endsWith(e));

function resolve(ctx, p) {
  if (typeof p !== "string" || !p.trim()) throw new ToolError("A path is required.");
  const abs = path.resolve(ctx.root, p.trim().replace(/^["']|["']$/g, ""));
  const r = path.relative(ctx.root, abs);
  if (r.startsWith("..") || path.isAbsolute(r)) throw new ToolError(`${p} is outside the project folder (${ctx.root}).`);
  return abs;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
function clipOutput(s, max = MAX_OUTPUT) {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.4)), tail = s.slice(-Math.floor(max * 0.6));
  return `${head}\n\n[… ${s.length - max} characters cut …]\n\n${tail}`;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function* walk(ctx, dir, depth = Infinity, level = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (skip(ctx, e.name)) continue;
    const abs = path.join(dir, e.name);
    yield { abs, entry: e, level };
    if (e.isDirectory() && level + 1 < depth) yield* walk(ctx, abs, depth, level + 1);
  }
}

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`(^|/)${re}$`, "i");
}

// ---------- read-only tools ----------
const tools = {
  list_files: {
    params: ["path", "depth"],
    describe: "List files and folders as a tree. <path> defaults to the project root, <depth> to 2.",
    readOnly: true,
    run(ctx, a) {
      const dir = resolve(ctx, a.path || ".");
      const depth = Math.min(Math.max(parseInt(a.depth, 10) || 2, 1), 6);
      toolHeader("List", rel(ctx, dir));
      const lines = [];
      for (const { abs, entry, level } of walk(ctx, dir, depth)) {
        if (lines.length >= 400) {
          lines.push("… (more entries; list a subfolder)");
          break;
        }
        lines.push(`${"  ".repeat(level)}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      }
      toolResult(`Listed ${plural(lines.length, "entry")}`.replace("entrys", "entries"));
      return lines.join("\n") || "(empty folder)";
    },
  },

  find_files: {
    params: ["pattern", "path"],
    describe: 'Find files by name with a glob, e.g. <pattern>**/*.test.js</pattern> or <pattern>*config*</pattern>.',
    readOnly: true,
    run(ctx, a) {
      if (!a.pattern) throw new ToolError("<pattern> is required.");
      const dir = resolve(ctx, a.path || ".");
      const re = globToRegex(a.pattern.trim());
      toolHeader("Find", a.pattern.trim());
      const hits = [];
      for (const { abs, entry } of walk(ctx, dir)) {
        if (entry.isFile() && re.test(rel(ctx, abs))) hits.push(rel(ctx, abs));
        if (hits.length >= 200) break;
      }
      toolResult(`Found ${plural(hits.length, "file")}`);
      return hits.join("\n") || "No files matched.";
    },
  },

  search: {
    params: ["pattern", "path", "glob"],
    describe: "Search file contents with a regular expression (case-insensitive). Optional <path> folder and <glob> filter like *.js.",
    readOnly: true,
    run(ctx, a) {
      if (!a.pattern) throw new ToolError("<pattern> is required.");
      let re;
      try {
        re = new RegExp(a.pattern, "i");
      } catch {
        re = new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
      const start = resolve(ctx, a.path || ".");
      const only = a.glob ? globToRegex(a.glob.trim()) : null;
      if (!fs.existsSync(start)) throw new ToolError(`Not found: ${a.path}`);
      toolHeader("Search", `"${a.pattern}"${a.path ? ` in ${a.path}` : ""}${a.glob ? ` (${a.glob})` : ""}`);
      const hits = [];
      const files = new Set();
      const candidates = fs.statSync(start).isFile() ? [{ abs: start, entry: { isFile: () => true } }] : walk(ctx, start);
      for (const { abs, entry } of candidates) {
        if (!entry.isFile() || (only && !only.test(rel(ctx, abs)))) continue;
        let buf;
        try {
          if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
          buf = fs.readFileSync(abs);
        } catch {
          continue;
        }
        if (isBinary(buf)) continue;
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < 150; i++) {
          if (re.test(lines[i])) {
            hits.push(`${rel(ctx, abs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            files.add(abs);
          }
        }
        if (hits.length >= 150) break;
      }
      toolResult(`Found ${plural(hits.length, "match")}`.replace("matchs", "matches") + ` in ${plural(files.size, "file")}`);
      return hits.length ? hits.join("\n") + (hits.length >= 150 ? "\n(stopped at 150 matches; narrow the search)" : "") : "No matches.";
    },
  },

  read_file: {
    params: ["path", "offset", "limit"],
    describe: "Read a file with line numbers. Optional <offset> (first line, default 1) and <limit> (lines, default 400).",
    readOnly: true,
    run(ctx, a) {
      const abs = resolve(ctx, a.path);
      let buf;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        throw new ToolError(`File not found: ${a.path}`);
      }
      if (isBinary(buf)) throw new ToolError(`${a.path} is a binary file.`);
      const lines = buf.toString("utf8").split(/\r?\n/);
      const offset = Math.max(parseInt(a.offset, 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(a.limit, 10) || 400, 1), 2000);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      ctx.readFiles.add(abs);
      toolHeader("Read", rel(ctx, abs) + (offset > 1 || slice.length < lines.length ? `:${offset}-${offset + slice.length - 1}` : ""));
      toolResult(`Read ${plural(slice.length, "line")}`);
      const width = String(offset + slice.length).length;
      let out = slice.map((l, i) => `${String(offset + i).padStart(width)}\t${l}`).join("\n");
      if (offset - 1 + slice.length < lines.length) out += `\n(file has ${lines.length} lines; read more with <offset>${offset + slice.length}</offset>)`;
      return clipOutput(out, 40000);
    },
  },

  // ---------- tools that change things ----------
  edit_file: {
    params: ["path", "old", "new", "replace_all"],
    describe:
      "Replace text in a file. <old> must be copied exactly from the file (indentation included) and appear exactly once, " +
      "unless <replace_all>true</replace_all>. Read the file first.",
    kind: "edit",
    prepare(ctx, a) {
      const abs = resolve(ctx, a.path);
      if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${a.path}. Use write_file to create it.`);
      if (!ctx.readFiles.has(abs)) throw new ToolError(`Read ${a.path} with read_file before editing it.`);
      if (a.old === undefined || a.new === undefined) throw new ToolError("<old> and <new> are required.");
      if (a.old === a.new) throw new ToolError("<old> and <new> are the same.");
      const before = fs.readFileSync(abs, "utf8");
      // Windows files often use CRLF while the model writes LF.
      const crlf = before.includes("\r\n");
      const fix = (s) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);
      const oldText = fix(a.old), newText = fix(a.new);
      const count = oldText ? before.split(oldText).length - 1 : 0;
      if (!count) throw new ToolError(`<old> wasn't found in ${a.path}. Re-read the file and copy the text exactly, including indentation.`);
      const all = String(a.replace_all).trim() === "true";
      if (count > 1 && !all) throw new ToolError(`<old> appears ${count} times in ${a.path}. Include more surrounding lines so it matches once, or set <replace_all>true</replace_all>.`);
      const after = all ? before.split(oldText).join(newText) : before.replace(oldText, () => newText);
      return { abs, before, after, label: "Update", title: `Edit ${rel(ctx, abs)}` };
    },
  },

  write_file: {
    params: ["path", "content", "append"],
    describe:
      "Create a file or replace its whole content. <append>true</append> adds to the end instead (use it to write a long file in parts). " +
      "For changes to an existing file prefer edit_file.",
    kind: "edit",
    prepare(ctx, a) {
      const abs = resolve(ctx, a.path);
      if (a.content === undefined) throw new ToolError("<content> is required.");
      const exists = fs.existsSync(abs);
      if (exists && fs.statSync(abs).isDirectory()) throw new ToolError(`${a.path} is a folder.`);
      const before = exists ? fs.readFileSync(abs, "utf8") : "";
      const append = String(a.append).trim() === "true";
      if (exists && !append && !ctx.readFiles.has(abs)) throw new ToolError(`${a.path} already exists. Read it first, or use edit_file.`);
      let content = a.content;
      if (before.includes("\r\n")) content = content.replace(/\r?\n/g, "\r\n");
      const after = append ? before + (before && !/\n$/.test(before) ? (before.includes("\r\n") ? "\r\n" : "\n") : "") + content : content;
      return { abs, before, after, created: !exists, label: exists ? "Update" : "Write", title: exists ? `Overwrite ${rel(ctx, abs)}` : `Create ${rel(ctx, abs)}` };
    },
  },

  run: {
    params: ["command", "timeout"],
    describe: `Run a shell command in the project folder (${WIN ? "PowerShell" : "bash"}). Optional <timeout> in seconds (default 120, max 600). Don't start servers or watchers that never exit.`,
    kind: "run",
  },
};

// Shows an edit's diff and writes it to disk.
function applyEdit(ctx, plan) {
  fs.mkdirSync(path.dirname(plan.abs), { recursive: true });
  fs.writeFileSync(plan.abs, plan.after);
  ctx.readFiles.add(plan.abs);
}

function showEdit(ctx, plan, { applied }) {
  toolHeader(plan.label, rel(ctx, plan.abs));
  const { lines, added, removed } = renderDiff(plan.before, plan.after);
  const verb = applied ? (plan.created ? "Wrote" : "Updated") : "Will update";
  const summary = plan.created
    ? `${verb === "Will update" ? "Will create" : "Wrote"} ${plural(added, "line")} to ${c.bold(rel(ctx, plan.abs))}`
    : `${verb} ${c.bold(rel(ctx, plan.abs))} with ${plural(added, "addition")} and ${plural(removed, "removal")}`;
  print(`  ⎿  ${summary}`);
  for (const l of lines) print("     " + l);
  return { added, removed };
}

// Runs a command, killing the whole process tree on Esc or timeout.
function runCommand(ctx, command, timeoutSec, signal) {
  return new Promise((resolveRun) => {
    const child = WIN
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`], { cwd: ctx.root, windowsHide: true })
      : spawn("bash", ["-lc", command], { cwd: ctx.root, detached: true });
    let out = "";
    let killedFor = "";
    const add = (d) => {
      out += d.toString("utf8");
      if (out.length > 400000) out = out.slice(-200000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const kill = (why) => {
      killedFor = why;
      try {
        if (WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => kill(`timed out after ${timeoutSec}s`), timeoutSec * 1000);
    const onAbort = () => kill("interrupted by the user");
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => add(`\n${err.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolveRun({ out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd(), code, killedFor });
    });
  });
}

async function execRun(ctx, a, signal) {
  const command = (a.command || "").trim();
  if (!command) throw new ToolError("<command> is required.");
  const timeout = Math.min(Math.max(parseInt(a.timeout, 10) || 120, 1), 600);
  spinner.start("Running");
  const { out, code, killedFor } = await runCommand(ctx, command, timeout, signal);
  spinner.stop();
  const lines = out ? out.split("\n") : [];
  const shown = lines.slice(0, 12);
  const more = lines.length - shown.length;
  const display = (shown.length ? shown.join("\n") : "(no output)") + (more > 0 ? `\n… +${more} lines` : "");
  toolResult(display + (killedFor ? `\n${killedFor}` : code ? `\nexit code ${code}` : ""), { color: code || killedFor ? c.red : c.dim });
  return clipOutput(out || "(no output)") + (killedFor ? `\n[command ${killedFor}]` : `\n[exit code ${code}]`);
}

module.exports = { tools, ToolError, makeContext, resolve, rel, applyEdit, showEdit, execRun, runCommand, walk, clipOutput };
