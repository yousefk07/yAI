"use strict";
// The agent's tools. Every path is resolved inside the folder yai was started in;
// edits and commands go through the permission check in index.js first.

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { c, print, toolHeader, toolResult, diffBox, spinner } = require("./ui");
const { fetchPage } = require("../lib/search");

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
  // tasks: background commands (run with <background>); webSearch is set by index.js (it goes through the site).
  return { root, readFiles: new Set(), ignore, ignoreExt, tasks: new Map(), taskSeq: 0, webSearch: null, onTaskDone: null };
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

// "a.js\nb.js" or "a.js, b.js" as separate paths; a single path (even one with a comma in its name) stays whole
function splitPaths(p, root) {
  const s = String(p || "").trim();
  if (!s) return [];
  try { if (fs.existsSync(path.resolve(root, s))) return [s]; } catch {}
  const parts = s.split(/\r?\n|,\s*/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [s];
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
function clipOutput(s, max = MAX_OUTPUT) {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.4)), tail = s.slice(-Math.floor(max * 0.6));
  return `${head}\n\n[… ${s.length - max} characters cut …]\n\n${tail}`;
}
// Search results kept per call: enough to find things, small enough not to fill a small model's window.
const MAX_HITS = 60;
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
      // A missing folder used to come back as "(empty folder)", and the model went looking elsewhere.
      if (!fs.existsSync(dir)) throw new ToolError(`Not found: ${a.path}. Paths are relative to the project folder (${ctx.root}).`);
      if (!fs.statSync(dir).isDirectory()) throw new ToolError(`${a.path} is a file, not a folder. Use read_file to see it.`);
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
        for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
          if (re.test(lines[i])) {
            hits.push(`${rel(ctx, abs)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
            files.add(abs);
          }
        }
        if (hits.length >= MAX_HITS) break;
      }
      toolResult(`Found ${plural(hits.length, "match")}`.replace("matchs", "matches") + ` in ${plural(files.size, "file")}`);
      return hits.length ? hits.join("\n") + (hits.length >= MAX_HITS ? `\n(stopped at ${MAX_HITS} matches; narrow the search with a more specific pattern, a <path> or a <glob>)` : "") : "No matches.";
    },
  },

  read_file: {
    params: ["path", "offset", "limit"],
    describe:
      "Read a file with line numbers. Optional <offset> (first line, default 1) and <limit> (lines, default 600), or a " +
      "line range in the path: src/app.js:120-180. To read several files or ranges at once, put up to 8 in <path>, one " +
      "per line: one step instead of several.",
    readOnly: true,
    run(ctx, a) {
      // a line range in the path (src/app.js:120-180, the way yAI shows a read), when no file has that literal name
      const range = /^(.+?):(\d+)(?:-(\d+))?$/.exec(String(a.path || "").trim());
      if (range && !fs.existsSync(resolve(ctx, a.path)) && !splitPaths(a.path, ctx.root).slice(1).length) {
        const from = Number(range[2]), to = range[3] ? Number(range[3]) : from + 199;
        a = { ...a, path: range[1], offset: String(from), limit: String(Math.max(1, to - from + 1)) };
      }
      // Several files in one step (2026-10-22): each step re-sends the whole conversation, so reading 7 files one by
      // one cost 7 resends. Each file gets a header; a path that doesn't exist is reported and the rest still read.
      const many = splitPaths(a.path, ctx.root);
      if (many.length > 1) {
        const per = Math.max(4000, Math.floor((ctx.budget || 40000) / many.length));
        const parts = many.slice(0, 8).map((p) => {
          try { return `=== ${p} ===\n${tools.read_file.run({ ...ctx, budget: per }, /:\d+(-\d+)?$/.test(p) ? { path: p } : { path: p, limit: 400 })}`; }
          catch (err) { return `=== ${p} ===\nError: ${err.message}`; }
        });
        if (many.length > 8) parts.push(`(only the first 8 paths were read; ask again for the rest)`);
        return parts.join("\n\n");
      }
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
      const limit = Math.min(Math.max(parseInt(a.limit, 10) || 600, 1), 2000);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      ctx.readFiles.add(abs);
      toolHeader("Read", rel(ctx, abs) + (offset > 1 || slice.length < lines.length ? `:${offset}-${offset + slice.length - 1}` : ""));
      toolResult(`Read ${plural(slice.length, "line")}`);
      const width = String(offset + slice.length).length;
      let out = slice.map((l, i) => `${String(offset + i).padStart(width)}\t${l}`).join("\n");
      if (offset - 1 + slice.length < lines.length) out += `\n(file has ${lines.length} lines; read more with <offset>${offset + slice.length}</offset>)`;
      return clipOutput(out, ctx.budget || 40000);
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
      if (a.old === undefined || a.new === undefined) {
        // Say exactly what's missing: small models often close <old> with </new> and skip the fix.
        const missing = [a.old === undefined && "a complete <old>…</old> block", a.new === undefined && "a <new>…</new> block with the fixed lines"].filter(Boolean).join(" and ");
        throw new ToolError(`edit_file is missing ${missing}. Write it as: <path>file</path>, then <old> with the exact lines to replace, closed by </old>, then <new> with the replacement, closed by </new>, then </tool>.`);
      }
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
      "Create a file or replace its whole content. Missing folders in <path> are created for you, so to make a new folder just write " +
      "a file inside it (e.g. calculator/index.html); never write a file only to create a folder. " +
      "<append>true</append> adds to the end instead (use it to write a long file in parts). " +
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
      // a /team builder (YAI_OWN_FILES, 2026-10-22) owns the files it creates; another agent's file it only hooks into
      // with edit_file, so two builders working at once never wipe each other's work
      if (exists && process.env.YAI_OWN_FILES) {
        let own = [];
        try { own = JSON.parse(process.env.YAI_OWN_FILES).map((p) => path.resolve(ctx.root, p)); } catch {}
        if (!own.includes(abs)) throw new ToolError(`${a.path} belongs to another agent on the team. Hook into it with edit_file (a few exact lines), and don't rewrite it.`);
      }
      let content = a.content;
      if (before.includes("\r\n")) content = content.replace(/\r?\n/g, "\r\n");
      const after = append ? before + (before && !/\n$/.test(before) ? (before.includes("\r\n") ? "\r\n" : "\n") : "") + content : content;
      return { abs, before, after, created: !exists, label: exists ? "Update" : "Write", title: exists ? `Overwrite ${rel(ctx, abs)}` : `Create ${rel(ctx, abs)}` };
    },
  },

  run: {
    params: ["command", "timeout", "background"],
    describe:
      `Run a shell command in the project folder (${WIN ? "PowerShell" : "bash"}). Optional <timeout> in seconds (default 120, max 600). ` +
      "For servers, watchers and anything else that keeps running, add <background>true</background>: it keeps running while you " +
      "work, and task_output shows what it has printed.",
    kind: "run",
  },

  // ---------- the web (2026-10-20) ----------
  // A small form of questions (2026-10-21): tabs for each question and Submit, numbered options with a line under each,
  // "Type something" for an answer of the user's own, and "Chat about this". index.js draws it (askForm).
  ask_user: {
    params: ["questions"],
    describe:
      'Ask the user 1 to 4 multiple-choice questions in a small form, when their answer changes what you build and the code can\'t tell you. ' +
      '<questions> is JSON: [{"header":"Role","question":"Role: a fixed list or free text?","options":[{"label":"Fixed list","description":"Physician, Nurse injector, Clinic owner"},{"label":"Free text","description":"The rep types it"}]}]. ' +
      "header is one or two words; 2 to 4 options each, with a short description. The user can also type their own answer. Their answers come back as the result.",
    kind: "ask",
  },
  // The services connected on the yAI website (2026-10-21, connections): weather, maps, Wolfram Alpha, arXiv, Semantic
  // Scholar, YouTube, the user's GitHub, LEARN and webhooks. Ones that change something ask first.
  service: {
    params: ["name", "args"],
    describe: 'Use a connected service listed under "# Connected services": <name> is the tool name (e.g. weather.forecast), <args> a JSON object of its arguments.',
    readOnly: true,
    async run(ctx, a) {
      const name = String(a.name || a.tool || "").trim();
      if (!ctx.service) throw new ToolError("Connected services aren't available here.");
      const info = ctx.serviceTool(name);
      if (!info) throw new ToolError(`${name || "That"} isn't a connected service. Connected: ${ctx.serviceNames().join(", ") || "none (the user can connect them on the yAI website)"}.`);
      let args = a.args || {};
      if (typeof args === "string") {
        try { args = args.trim() ? JSON.parse(args) : {}; } catch { throw new ToolError('<args> must be a JSON object, e.g. {"place":"Waterloo, ON"}.'); }
      }
      // a /team agent works without anyone watching: services that change something (a Discord or Slack post, an n8n
      // webhook, a GitHub issue) are for the user to ask for, not for an agent to do
      if (info.write && process.env.YAI_TEAM_AGENT) throw new ToolError(`${name} changes something outside the project, so team agents can't use it. If it's needed, say so in your report.`);
      if (info.write && !(await ctx.approve(name, args))) return "The user said no; it wasn't done.";
      // the same plain words as the website's live steps: "Checking the weather in Waterloo, ON"
      const { describe } = require("../lib/connectors/describe");
      toolHeader(info.label, describe(name, args));
      spinner.start(describe(name, args));
      let r;
      try {
        r = await ctx.service(name, args, !!info.write);
      } finally {
        spinner.stop();
      }
      toolResult(r.link ? r.text.split("\n")[0] : `Got ${plural(r.text.split("\n").length, "line")}${r.sources?.length ? ` · ${plural(r.sources.length, "source")}` : ""}`);
      return r.text + (r.sources?.length ? `\n\nSources:\n${r.sources.map((s, i) => `[${i + 1}] ${s.title} ${s.url}`).join("\n")}` : "");
    },
  },
  web_search: {
    params: ["query"],
    describe: "Search the web. Returns titles, links and snippets. Use it for documentation, error messages, library versions and anything recent; then web_fetch the best link.",
    readOnly: true,
    async run(ctx, a) {
      const q = String(a.query || "").trim();
      if (!q) throw new ToolError("<query> is required.");
      if (!ctx.webSearch) throw new ToolError("Web search isn't available here.");
      toolHeader("Web search", q);
      spinner.start("searching");
      let results;
      try {
        results = await ctx.webSearch(q);
      } finally {
        spinner.stop();
      }
      toolResult(`Found ${plural(results.length, "result")}`);
      return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || ""}`.trim()).join("\n\n") || "No results.";
    },
  },
  // 2026-10-22: see the app as it is right now (cli/teamchecks.js pageCheck), so an agent checks its work in the real
  // page instead of guessing or writing a Node harness for browser code
  // The team chat (2026-10-22): a /team agent tells the others something that affects them. The board passes it on;
  // the others read it after their current step. Only team agents have it (index.js leaves it out otherwise).
  team_say: {
    params: ["message", "to"],
    describe: "Team chat: tell the other agents on your team something that affects them: a hook you added in a file they own, a shared name you renamed or need, a question about how a piece fits, or an answer to one. Optional <to>: one agent's name (default: everyone). Keep it to one or two sentences; don't post routine progress. Their replies reach you after your next step.",
    readOnly: true,
    async run(ctx, a) {
      const text = String(a.message || "").replace(/\s+/g, " ").trim();
      if (!text) throw new ToolError("<message> is required.");
      ctx.chatCount = (ctx.chatCount || 0) + 1;
      if (ctx.chatCount > 10) throw new ToolError("You've used the team chat 10 times; get on with your part and put anything else in your report.");
      const to = String(a.to || "").replace(/^@/, "").trim();
      toolHeader("Team chat", `${to ? `@${to} ` : ""}${text.slice(0, 80)}`);
      require("./ui").event({ type: "chat", text: text.slice(0, 600), to });
      toolResult(to ? `sent to ${to}` : "sent to the team");
      return to ? `Sent to ${to}. A reply, if any, reaches you after your next step.` : "Sent to the team. Replies, if any, reach you after your next step.";
    },
  },
  check_page: {
    params: ["path", "keys", "look_for"],
    describe: "Open the web page (or game) in a real browser as it is right now, press its start button, and report: errors, a frozen page, the frame rate, the buttons and text on it, and a description of what's on screen. " +
      "<path> is the HTML page (default: the project's index.html). Optional <keys> to hold after it starts, e.g. KeyW:1500,Space,ArrowLeft:500 (a key code, then how long in ms). " +
      "Optional <look_for>: what to check on screen, e.g. \"is the hand visible and does the block show cracks\". It takes 10-25 s: use it after a group of changes or a finished feature, not after each small edit.",
    readOnly: true,
    async run(ctx, a) {
      let page = String(a.path || "").trim();
      if (!page) {
        const found = [];
        const look = (dir, depth) => { let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of list) { if (e.isFile() && /^index\.html?$/i.test(e.name)) found.push(path.join(dir, e.name)); else if (e.isDirectory() && depth < 2 && !/^(node_modules|\.git|yai-media|\.yai-old|\.yai-team)$/.test(e.name)) look(path.join(dir, e.name), depth + 1); } };
        look(ctx.root, 0);
        found.sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
        if (!found.length) throw new ToolError("No index.html found. Give <path>.");
        page = found[0];
      }
      const abs = resolve(ctx, page);
      if (!fs.existsSync(abs)) throw new ToolError(`${page} doesn't exist.`);
      // 1. the page's files as they are now (any agent's edits count): unchanged since the last check, same keys, it
      // isn't opened again
      let newest = 0, count = 0;
      const scan = (dir, depth) => { let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of list) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (depth < 3 && !/^(node_modules|\.git|yai-media|\.yai-old|\.yai-team|tests?)$/.test(e.name)) scan(p, depth + 1); } else if (/\.(html?|m?js|css|json|glsl|wgsl)$/i.test(e.name)) { count++; try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch {} } } };
      scan(path.dirname(abs), 0);
      const stamp = `${abs}|${newest}|${count}|${String(a.keys || "")}`;
      ctx.pageChecks = ctx.pageChecks || { n: 0, last: "" };
      if (ctx.pageChecks.last === stamp) {
        toolHeader("Check page", rel(ctx, abs));
        toolResult("nothing changed · not run");
        return "Nothing in the page's files has changed since your last check_page (with the same keys), so it wasn't opened again: its result is further up. Change something first, or carry on.";
      }
      // 3. a builder (its own files listed) gets the screen described on its first check, and when it asks with <look_for>;
      // other checks still report errors, freezes and frame rate (fast, and they don't use the image model)
      const builder = !!process.env.YAI_OWN_FILES;
      const describe = !builder || ctx.pageChecks.n === 0 || String(a.look_for || "").trim() ? ctx.describeImage : null;
      ctx.pageChecks.n++;
      toolHeader("Check page", rel(ctx, abs) + (a.keys ? ` · ${String(a.keys).slice(0, 40)}` : ""));
      spinner.start("opening it in a browser");
      let r;
      try {
        r = await require("./teamchecks").pageCheck({ entry: abs, keys: a.keys || "", lookFor: String(a.look_for || ""), describe, saveTo: path.join(ctx.root, "yai-media", `check-page-${Date.now()}.jpg`) });
      } catch (err) {
        throw new ToolError(`Couldn't open it: ${err.message}`);
      } finally {
        spinner.stop();
      }
      toolResult(r.frozen ? "frozen" : /Errors in the browser/.test(r.lines.join("\n")) ? "errors" : "checked", { color: r.frozen ? c.red : undefined });
      ctx.pageChecks.last = stamp;
      if (ctx.describeImage && !describe) r.lines.push("(No screen description this time, to save time: give <look_for> on your final check to have the screen described.)");
      return r.lines.join("\n");
    },
  },
  web_fetch: {
    params: ["url"],
    describe: "Read a web page as text: documentation, an article, a GitHub file, or the user's own dev server (http://localhost:3000).",
    readOnly: true,
    async run(ctx, a) {
      const url = String(a.url || "").trim();
      if (!url) throw new ToolError("<url> is required.");
      toolHeader("Fetch", url);
      spinner.start("reading");
      let page;
      try {
        page = await fetchPage(/^https?:\/\//i.test(url) ? url : `https://${url}`, { maxChars: Math.min(ctx.budget || 20000, 24000), allowPrivate: true });
      } catch (err) {
        throw new ToolError(`Couldn't read ${url}: ${err.message}`);
      } finally {
        spinner.stop();
      }
      toolResult(`Read ${page.text.length.toLocaleString()} characters${page.title ? ` · ${page.title.slice(0, 60)}` : ""}`);
      return `${page.title ? page.title + "\n" : ""}${page.url}\n\n${page.text || "(no text on the page)"}`;
    },
  },

  // ---------- background commands ----------
  task_output: {
    params: ["id"],
    describe: "What a background command has printed (the last part), and whether it is still running. Without <id>, lists them all.",
    readOnly: true,
    run(ctx, a) {
      if (!a.id) {
        toolHeader("Tasks", "");
        toolResult(`${plural(ctx.tasks.size, "background task")}`);
        return [...ctx.tasks.values()].map((t) => `${t.id}: ${taskStatus(t)} · ${t.command}`).join("\n") || "No background tasks.";
      }
      const t = ctx.tasks.get(Number(a.id));
      if (!t) throw new ToolError(`No background task ${a.id}. Running ones: ${[...ctx.tasks.keys()].join(", ") || "none"}.`);
      toolHeader("Task output", `${t.id} · ${t.command}`);
      toolResult(taskStatus(t));
      return `Task ${t.id} (${t.command}) is ${taskStatus(t)}.\n${clipTail(t.out, Math.min(ctx.budget || 8000, 8000)) || "(no output yet)"}`;
    },
  },
  task_stop: {
    params: ["id"],
    describe: "Stop a background command you started.",
    readOnly: true,
    run(ctx, a) {
      const t = ctx.tasks.get(Number(a.id));
      if (!t) throw new ToolError(`No background task ${a.id}.`);
      toolHeader("Stop task", `${t.id} · ${t.command}`);
      stopTask(t);
      toolResult("stopped");
      return `Stopped task ${t.id}.`;
    },
  },
};

// ---------- background commands ----------
const clipTail = (s, n) => (s.length > n ? `… (${s.length - n} earlier characters)\n` + s.slice(-n) : s);
function taskStatus(t) {
  const secs = Math.round(((t.endedAt || Date.now()) - t.started) / 1000);
  const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  return t.done ? `${t.stopped ? "stopped" : `exited with code ${t.code}`} after ${time}` : `running for ${time}`;
}
function stopTask(t, { sync = false } = {}) {
  if (t.done) return;
  t.stopped = true;
  try {
    if (WIN) (sync ? spawnSync : spawn)("taskkill", ["/pid", String(t.child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-t.child.pid, "SIGKILL");
  } catch {}
}
function stopAllTasks(ctx) {
  for (const t of ctx.tasks.values()) stopTask(t, { sync: true });
}
// Starts a command that keeps running (a dev server, a watcher). Waits a few seconds so a quick failure or the
// server's "listening on" line comes back with the result.
async function startBackground(ctx, command) {
  const id = ++ctx.taskSeq;
  const child = WIN
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${psChain(command)}`], { cwd: ctx.root, windowsHide: true })
    : spawn("bash", ["-lc", command], { cwd: ctx.root, detached: true });
  const t = { id, command, child, out: "", started: Date.now(), done: false, code: null };
  const add = (d) => {
    t.out += d.toString("utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (t.out.length > 300000) t.out = t.out.slice(-150000);
  };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  child.on("error", (err) => add(`\n${err.message}`));
  child.on("close", (code) => {
    t.done = true;
    t.code = code;
    t.endedAt = Date.now();
    if (ctx.onTaskDone) ctx.onTaskDone(t);
  });
  ctx.tasks.set(id, t);
  spinner.start("starting in the background");
  for (let waited = 0; waited < 4000 && !t.done; waited += 250) await new Promise((r) => setTimeout(r, 250));
  spinner.stop();
  toolResult(t.done ? `exited with code ${t.code}` : `running in the background as task ${id}`, { color: t.done && t.code ? c.red : undefined, summary: t.done ? `exit ${t.code}` : `task ${id}` });
  const so = clipTail(t.out.trim(), 3000);
  return t.done
    ? `The command exited straight away with code ${t.code}.\n${so || "(no output)"}`
    : `Started as background task ${id}; it keeps running while you work.${so ? ` Output so far:\n${so}` : " No output yet."}\nCheck it with task_output (<id>${id}</id>), stop it with task_stop.`;
}

// Shows an edit's diff and writes it to disk.
function applyEdit(ctx, plan) {
  fs.mkdirSync(path.dirname(plan.abs), { recursive: true });
  fs.writeFileSync(plan.abs, plan.after);
  ctx.readFiles.add(plan.abs);
}

// The proposed change in a box: the file and +/− counts, then the changed lines. A new file shows its
// first lines only; an edit shows every changed line, since that's what's being approved.
function showEdit(ctx, plan) {
  return diffBox(rel(ctx, plan.abs), plan.before, plan.after, { created: plan.created, maxLines: plan.created ? 8 : 40 });
}

// Windows PowerShell 5.1 has no && or ||, and models write them anyway ("cd app && npm test"), so they are turned
// into its own form: a && b -> a; if ($?) { b }, a || b -> a; if (-not $?) { b }. Quoted text is left alone.
function psChain(command) {
  const parts = [];
  let cur = "", quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      parts.push(cur.trim(), ch + ch);
      cur = "";
      i++;
    } else cur += ch;
  }
  parts.push(cur.trim());
  if (parts.length === 1) return command;
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i > 0; i -= 2) out = `${parts[i - 1]}; if (${parts[i] === "&&" ? "$?" : "-not $?"}) { ${out} }`;
  return out;
}

// Runs a command, killing the whole process tree on Esc or timeout.
function runCommand(ctx, command, timeoutSec, signal) {
  return new Promise((resolveRun) => {
    const child = WIN
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${psChain(command)}`], { cwd: ctx.root, windowsHide: true })
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

// Test results in a command's output (node --test, TAP, Jest, pytest): the failing tests' names and
// the pass/fail counts, so a test run reads "● name" per failure instead of pages of output.
function testResults(out) {
  const failing = new Set();
  for (const line of out.split("\n")) {
    const m =
      line.match(/^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/) || // node --test
      line.match(/^\s*not ok \d+ - (.+?)\s*$/) || // TAP
      line.match(/^\s*●\s+(?!Console\b)(.+?)\s*$/) || // Jest
      line.match(/^FAILED\s+(\S+)/); // pytest
    if (m && !/^failing tests:?$/i.test(m[1]) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(m[1])) failing.add(m[1]);
  }
  const count = (word) => {
    const m = out.match(new RegExp(`^(?:ℹ|#) ${word} (\\d+)\\s*$`, "m")) || out.match(new RegExp(`\\b(\\d+) ${word}(?:ed)?\\b`));
    return m ? Number(m[1]) : undefined;
  };
  return { names: [...failing], pass: count("pass"), fail: count("fail") };
}

// The line of a failed command's output that says what went wrong. PowerShell puts the message
// before "At line:1 char:5" (runtime errors) or after the "+ ~~~" marker lines (parse errors);
// anything else usually ends with it.
// PowerShell also wraps a long message over several lines, so the pieces are joined back into one.
function errorLine(lines) {
  const clean = lines.map((l) => l.trim()).filter((l) => l && !/OutputEncoding=\[Text\.Encoding\]/.test(l));
  const noise = (l) => /^\+/.test(l) || /^(CategoryInfo|FullyQualifiedErrorId)\b/.test(l) || /^At line:\d+ char:\d+/.test(l);
  const at = clean.findIndex((l) => /^At line:\d+ char:\d+/.test(l));
  if (at > 0) {
    // "cmd : The term ... is not recognized ... or operable" / "program. Check the spelling ..." / "and try again."
    const before = clean.slice(Math.max(0, at - 4), at);
    const start = before.map((l) => / : /.test(l)).lastIndexOf(true);
    return before.slice(Math.max(0, start)).join(" ");
  }
  if (at === 0) {
    const start = clean.findIndex((l, i) => i > 0 && !noise(l));
    if (start < 0) return "";
    const msg = [];
    for (let i = start; i < clean.length && !noise(clean[i]); i++) msg.push(clean[i]);
    return msg.join(" ");
  }
  return clean[clean.length - 1] || "";
}

async function execRun(ctx, a, signal) {
  const command = (a.command || "").trim();
  if (!command) throw new ToolError("<command> is required.");
  let timeout = Math.min(Math.max(parseInt(a.timeout, 10) || 120, 1), 600);
  // a /team agent's node -e script gets 30 s (2026-10-22: a merger's script loading a whole browser game into Node's
  // vm never finished, and it waited 120 s twice); tests and builds keep the normal limit
  const script = !!process.env.YAI_TEAM_AGENT && /^\s*node\s+(-e|--eval|-p)\b/.test(command);
  if (script) timeout = Math.min(timeout, 30);
  spinner.start("running");
  const { out, code, killedFor } = await runCommand(ctx, command, timeout, signal);
  spinner.stop();
  // A glance, not the whole output (the model still gets all of it): the first few lines when it
  // worked, the last few when it failed, because that's where errors are.
  const lines = out ? out.split("\n") : [];
  const failed = !!(code || killedFor);
  const result = clipOutput(out || "(no output)", ctx.budget) + (killedFor ? `\n[command ${killedFor}]` : `\n[exit code ${code}]`) +
    (killedFor && script ? "\nA script that loads browser code (a page, a game loop, the DOM) in Node never finishes. Don't run it again: check each file with node --check, and the code by reading it." : "");
  // A test run: the counts on the row ("2 failed, 6 passed") and a red dot per failing test.
  const tests = out && !killedFor ? testResults(out) : { names: [] };
  if (tests.names.length || tests.pass !== undefined) {
    const nFail = tests.fail ?? tests.names.length;
    const counts = [nFail ? `${nFail} failed` : "", tests.pass !== undefined ? `${tests.pass} passed` : ""].filter(Boolean).join(", ");
    const rows = tests.names.slice(0, 6).map((n) => `${c.red("●")} ${c.ink(n)}`);
    if (tests.names.length > 6) rows.push(`… ${tests.names.length - 6} more failing`);
    toolResult(failed ? rows.join("\n") : "", { color: failed ? c.red : undefined, quiet: true, summary: counts || `exit ${code}` });
    return result;
  }
  // A failure is one row with a red ● and the one line that says what went wrong; a success shows
  // the first few lines.
  const shown = lines.slice(0, 4);
  const more = lines.length - shown.length;
  const display = failed ? errorLine(lines) : !shown.length ? "" : shown.join("\n") + (more > 0 ? `\n… ${more} more lines` : "");
  // The row says how it went ("exit 1", "12 lines"); the glance at the output goes under it.
  const summary = failed ? killedFor || `exit ${code}` : lines.length ? plural(lines.length, "line") : "no output";
  toolResult(display, { color: failed ? c.red : undefined, quiet: true, summary });
  return result;
}

module.exports = { splitPaths, tools, ToolError, makeContext, resolve, rel, applyEdit, showEdit, execRun, runCommand, walk, clipOutput, testResults, errorLine, psChain, startBackground, stopTask, stopAllTasks, taskStatus };
