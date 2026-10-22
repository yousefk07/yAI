"use strict";
// /team (2026-10-21): background agents that split the work. A lead model splits the task into 2 to 4 parts that touch
// different files; each part runs as its own yAI Code (`yai --stdio`, a child process in this folder, edits approved
// for it), all at the same time. A live board shows each one's current step, time and cost; commands they want to run
// still come to you for approval, one at a time. At the end their reports go into this conversation, so you (and
// yAI) can carry on from there, or check it all with /review.
//
// The team (2026-10-21): after the builders, the checkers you picked run together (integration, tester, reviewer,
// security checker, docs writer), each ending with a VERDICT line; if any of them finds a problem, the fixer runs last
// with their reports. You pick the members on a checklist after the lead's split; the picks are remembered.
//
// The layout first (2026-10-21): the lead plans every file the work needs (paths, with a folder for a new project) and
// who owns each; yAI makes the folders before anyone starts, and every agent's brief carries the whole map, so they
// all build into the same structure instead of each inventing its own.
//
// Holding the pieces together (2026-10-21, after a Fortnite replica came out as a black screen: the engine called
// FN.render, the renderer defined FN.renderWorld, the page and the HUD used different element ids, and the agents'
// "for the others" notes went nowhere):
//   - the lead writes a contract, every name shared between files (globals, functions, element ids, events), saved
//     as TEAM_CONTRACT.md and given word for word to every agent;
//   - for web work yAI opens the page in a headless browser after the builders (console errors, failed loads, a blank
//     canvas, and a model that can see describes the screenshot), and again after the fixer;
//   - the builders' notes for each other go to the integration agent and the fixer;
//   - files already in the folder that aren't in the plan can be moved aside first, a stopped team can remove what it
//     created, and files made outside the plan are listed at the end;
//   - up to 8 builders when you ask for more ("/team 6 …" or "as many agents as possible").
//
// From a Breakout run (2026-10-22): the fixer broke the mouse while fixing the keyboard and nothing noticed, agents
// explained away their own failing checks, and the contract took the browser's own `Audio`. So: the browser check
// tries the controls (keys and mouse, judged from before/after screenshots), the fixer must re-run the existing tests
// and check every control, a changed check must be listed and justified, the contract avoids browser built-ins, the
// re-run only uses test commands that worked for the team, and /team warns when started in the home folder.
//
// More members (2026-10-22), in the order they run:
//   0.5 architect    before the builders: a detailed TEAM_CONTRACT.md (signatures, data shapes, startup order)
//   1   builders
//   1.2 merger       joins the pieces and fixes mismatches between them
//   1.3 designer     visual polish, CSS only
//   1.5 browser      yAI's own check (always, for web work)
//   1.6 yAI's own    browser checks, nearly free: mobile, performance, accessibility, playtester (cli/teamchecks.js)
//   2   checkers     integration, tester, reviewer, security, docs, api, setup (they see 1.5 and 1.6's results)
//
// Cost (2026-10-22, a $2.50 FPS run): each agent step re-sends its whole conversation, so team agents get a short
// system prompt (YAI_TEAM_AGENT), old tool output is cut once past ~48k tokens (YAI_TRIM_TOKENS), repeated look-only
// steps aren't re-run, and the integration check is folded into the reviewer when both run, or skipped when the page
// opened cleanly and every built-in check passed.
//   3   fixer        only if something was found
//   4   spec         the result against the request, item by item
//
// Watching an agent (2026-10-21): while the team works, press an agent's number (or click its row) to see what it's
// doing: what it says, each step and its result, and its file edits as diffs, live. Esc goes back to the board.
// After the team, /team log <number or name> prints an agent's whole log.
//
// Holding the team to account (2026-10-21, after a run whose tester gave no verdict and whose fixer said "all checks
// pass" while 47 of 60 tests failed): a checker that ends without a verdict counts as a concern (shown in yellow, and
// the fixer gets its report); and once the fixer is done, yAI itself re-runs the test commands the team used and
// shows their real result next to the fixer's verdict.

const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const PM = require("./projmap");

const MAX_AGENTS = 4; // the default; "/team 6 …" or "as many agents as possible" allows up to MAX_ASKED
const MAX_ASKED = 8;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LEAD_SYSTEM =
  "You are the lead of a small coding team. Split the user's task among agents that work AT THE SAME TIME in one folder, " +
  "each with file and shell tools. Reply with only JSON, no prose and no code fence: " +
  '{"folder":"the folder a new project goes in, e.g. snake-game (empty when changing an existing project)",' +
  '"contract":"EVERY name shared between files, with exact spelling and the file that defines it: global objects and their methods/fields, functions one file calls in another, HTML element ids and classes other files look up, events, routes, data shapes. One line each, e.g. window.FN.render(dt) - defined in world.js, called by engine.js every frame",' +
  '"agents":[{"name":"2-3 word name","task":"exactly what this agent does, concrete enough to do alone","files":["every path it creates or changes, relative to the project folder, including the folder above"]}]}. ' +
  "Plan the whole file layout up front: list EVERY file the finished work needs, each under exactly one agent, with full paths " +
  "(a new project's files all go inside its folder, e.g. snake-game/index.html, snake-game/js/game.js). " +
  "Write the contract BEFORE the tasks and use exactly its names in every task text: two agents must never be told different names for " +
  "the same thing (one calling render while the other defines renderWorld, or one page using health-bar while the script looks up healthBar). " +
  "If the folder already has files, decide in the tasks whether they are reused or replaced. " +
  "Never name a shared global after something the browser or Node already has (Audio, Image, Event, Map, Set, Node, Element, Option, Text, " +
  "Range, Request, Response, Notification, History, Location, Screen, Storage, Worker, File, Blob, URL, Proxy, Symbol, name, status, top, parent): " +
  "prefix it instead (GameAudio, AppEvents). " +
  "Rules: split by independent pieces (for example the API, the page, the tests); every file belongs to at most one agent, " +
  "since two agents editing one file would overwrite each other; each task must make sense without waiting for another " +
  "(agree on names, routes and data shapes inside the task text so the pieces fit). If the task is small or can't be split " +
  "without agents stepping on each other, return a single agent. No tool calls.";

// The members who aren't builders. phase 2 runs when the builders finish; phase 3 (the fixer) only if a check found
// something. readOnly roles run in plan mode and can't edit; the others edit, and all may run checks that change nothing.
const WEB = /html|page|site|website|web ?app|game|canvas|\bui\b|frontend|landing|dashboard/i;
const GAME = /\bgame\b|arcade|platformer|shooter|breakout|snake|tetris|pong|\bplayer\b/i;
const ROLES = [
  { key: "architect", phase: 0.5, verdict: false, on: (t, n) => n >= 4, desc: "designs how the pieces fit before anyone builds: a detailed TEAM_CONTRACT.md" },
  { key: "merger", phase: 1.2, verdict: false, on: (t, n) => n >= 3, desc: "joins the builders' pieces and fixes mismatches between them" },
  { key: "designer", phase: 1.3, verdict: false, on: (t) => /design|look|beautiful|polish|pretty|modern|sleek|styl/i.test(t), desc: "polishes how it looks (CSS only): spacing, type, colours, states" },
  { key: "integration", phase: 2, readOnly: true, on: true, desc: "checks the pieces fit together (imports, routes, data shapes)" },
  { key: "tester", phase: 2, on: true, desc: "writes and runs tests for the new work (test files only)" },
  { key: "reviewer", phase: 2, readOnly: true, on: false, desc: "reviews the code for bugs, edge cases and messy code" },
  { key: "security", phase: 2, readOnly: true, on: (task) => /server|api|login|auth|password|token|form|upload|database|sql|payment|cookie|session/i.test(task), desc: "looks for security holes (injection, auth, secrets, unsafe input)" },
  { key: "docs", phase: 2, on: false, verdict: false, desc: "updates the README and docs for what changed" },
  { key: "api", phase: 2, on: (t) => /\bapi\b|server|backend|endpoint|route|database|express|\brest\b/i.test(t), desc: "calls every route with good and bad input and checks the answers" },
  { key: "setup", phase: 2, readOnly: true, on: (t) => /npm|package|deploy|vercel|install|setup|readme|dependenc/i.test(t), desc: "checks it runs from a clean checkout: imports, dependencies, paths, README" },
  { key: "mobile", phase: 1.6, internal: true, on: (t) => WEB.test(t), desc: "yAI opens it at phone, tablet and laptop sizes" },
  { key: "performance", phase: 1.6, internal: true, on: (t) => GAME.test(t), desc: "yAI measures load time, page weight and frame rate" },
  { key: "accessibility", phase: 1.6, internal: true, on: (t) => WEB.test(t) && !GAME.test(t), desc: "yAI runs axe-core: contrast, labels, alt text, keyboard use" },
  { key: "playtester", phase: 1.6, internal: true, on: (t) => GAME.test(t), desc: "yAI plays the game for 30 s: controls, losing, Play again, saves" },
  { key: "fixer", phase: 3, on: true, desc: "fixes what the checkers found, then re-runs their checks" },
  { key: "spec", phase: 4, readOnly: true, on: true, desc: "checks the result against your request, item by item" },
];
const WAIT_STEP = { 0.5: "first", 1: "after the architect", 1.2: "after the builders", 1.3: "after the builders", 1.5: "after the builders", 1.6: "after the builders", 2: "after the builders", 3: "if anything is found", 4: "at the end" };
const BAD = /^(PROBLEMS|FAIL|PARTLY)$/;
// what the integration check looks at (the reviewer takes these on when both run)
const INTEGRATION_ITEMS = [
  "(1) every file that is imported or required exists, and every imported name is actually exported;",
  "(2) routes, command names, event names and data shapes match between the files that produce and consume them;",
  "(3) no file is left half-wired (dangling references, TODO stubs, duplicated definitions, syntax errors);",
  "(4) the agents' changes don't contradict each other (two files defining the same thing differently);",
  "(5) every name in the CONTRACT is defined where it says and used with exactly that spelling everywhere (search for each one);",
  "(6) every note the builders left for each other (below) is resolved; an unresolved one is a problem;",
  "(7) no file overwrites a browser or Node built-in global (window.Audio, window.Image, window.Event, window.name…); that's a problem even if the page seems to work.",
];
const TESTISH = /\b(test|tests|pytest|jest|vitest|mocha|unittest|spec)\b|--test\b/i;

module.exports = function create(d) {
  const { state, root, api, ui, X } = d;
  const { c, print, spinner } = ui;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const wrapText = (s, n) => {
    const out = [];
    let line = "";
    for (const w of String(s).split(/\s+/)) {
      if (line && (line + " " + w).replace(/\*\*|`/g, "").length > n) { out.push(line); line = w; } else line = line ? line + " " + w : w;
    }
    if (line) out.push(line);
    return out;
  };
  const secs = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`);

  function projectFiles() {
    const r = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const list = r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
    return list.length ? (list.length > 400 ? list.slice(0, 400).join("\n") + `\n… and ${list.length - 400} more` : list.join("\n")) : d.topLevel();
  }

  // The lead's split, as [{ name, task, files }].
  function parsePlan(text, max) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("The lead didn't return a plan.");
    const plan = JSON.parse(m[0]);
    const seen = new Set();
    const agents = (Array.isArray(plan.agents) ? plan.agents : []).slice(0, max).map((a, i) => ({
      name: clip(String(a.name || `agent ${i + 1}`).trim(), 24),
      task: String(a.task || "").trim(),
      // a file claimed twice stays with the first agent
      files: (Array.isArray(a.files) ? a.files : []).map((f) => String(f).replace(/\\/g, "/").replace(/^\.\//, "")).filter((f) => f && !seen.has(f) && seen.add(f)),
    })).filter((a) => a.task);
    if (!agents.length) throw new Error("The lead's plan had no tasks.");
    return agents;
  }

  function brief(task, me, all) {
    const others = all.filter((a) => a !== me && !a.role);
    const roles = all.filter((a) => a.role).map((a) => a.role);
    return [
      `You are one of ${all.filter((a) => !a.role).length} builder agents working at the same time in this project, as a team${roles.length ? " (checkers look at the work after you)" : ""}. The team's overall task: ${task}`,
      "", `Your part: ${me.task}`,
      "", me.files.length ? `Files that are yours to create or change: ${me.files.join(", ")}.` : "Keep your changes to the files your part needs.",
      ...(layoutLines(all).length ? ["", "The project layout, planned before anyone started (the folders already exist; create your files at exactly these paths and don't add other folders or rename anything):", ...layoutLines(all)] : []),
      ...contractLines(), ...notesLines(),
      ...others.map((o) => `"${o.name}" is doing: ${clip(o.task, 300)}${o.files.length ? ` (its files: ${o.files.join(", ")})` : ""}. Don't edit its files; if you need a change there, say so in your report.`),
      "", "Don't commit, push or change git history, and don't start servers that keep running.",
      ...(roles.length ? [`After the builders finish, ${roles.join(", ").replace(/, ([^,]*)$/, " and $1")} ${roles.length === 1 ? "checks" : "check"} the work, so focus on your part.`] : []),
      // 2026-10-22 (a chess run): builders wrote their files in a few steps, then spent 40-100 more printing pieces of
      // them with node -e and writing _test.js harnesses until they were stopped. Building is their job; testing isn't.
      "Write your files, check each once with a syntax check (node --check <file>), fix what that finds, and finish. Don't write test harnesses, scratch tests or fake DOMs: " +
        (roles.includes("tester") ? "the tester does that after you. " : "the checkers do that after you. ") +
        "To look at a file use read_file, never node -e, Get-Content or cat. If you can't make something work after two tries, say so in your report instead of trying more.",
      "When you're done, end with a short report: what you changed, file by file, and anything the others or the user still need to do.",
      REPORT_STYLE,
    ].join("\n");
  }

  // The planned files as a tree, each with its owner: "  snake-game/" then "    index.html  (page)".
  function layoutLines(all) {
    const owner = new Map();
    for (const a of all.filter((x) => !x.role)) for (const f of a.files) owner.set(f, a.name);
    const paths = [...owner.keys()].sort();
    const out = [], shown = new Set();
    for (const p of paths) {
      const parts = p.split("/");
      for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts.slice(0, i + 1).join("/");
        if (!shown.has(dir)) { shown.add(dir); out.push(`${"  ".repeat(i + 1)}${parts[i]}/`); }
      }
      out.push(`${"  ".repeat(parts.length)}${parts[parts.length - 1]}  (${owner.get(p)})`);
    }
    return out;
  }
  // Makes the planned folders (inside the project only) before the builders start.
  function makeFolders(all) {
    const fs = require("fs");
    const made = new Set();
    for (const a of all.filter((x) => !x.role)) for (const f of a.files) {
      const dir = path.dirname(path.resolve(root, f));
      const rel = path.relative(root, dir);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); made.add(rel.split(path.sep).join("/")); }
    }
    return [...made];
  }

  // "For the others: …" in a builder's report: what it needs from the other agents.
  function handoffs(all) {
    return all.filter((a) => !a.role && a.text?.length).map((a) => {
      const t = a.text.join("\n");
      const m = /^[#*\s-]*(?:for the others|notes for the others|for other agents|notes for others|for the rest of the team)\b[^\n]*\n?([\s\S]{0,1800})/im.exec(t);
      // up to the next heading or **Label** (the report shape every agent now uses)
      return m ? { from: a.name, text: m[1].trim().split(/\n#{1,3} |\n\*\*[^*\n]+\*\*/)[0].trim() } : null;
    }).filter((h) => h && h.text && !/^(none|nothing|no changes needed)\.?$/i.test(h.text));
  }
  const handoffLines = (all, role) => {
    const list = handoffs(all);
    if (!list.length || !["integration", "fixer"].includes(role)) return [];
    return ["", "What the builders said they need from each other (each must end up resolved in the code):", ...list.map((h) => `## from ${h.from}\n${h.text}`)];
  };
  const internalLines = (all) => {
    const list = all.filter((a) => a.internal && a.role !== "browser" && a.text?.length);
    return list.length ? ["", "yAI's own checks of the page:", ...list.map((a) => `## ${a.role} (${a.verdict ? "VERDICT: " + a.verdict : a.state})\n${a.text.filter((l) => !/^VERDICT:/.test(l)).join("\n")}`)] : [];
  };
  const browserLines = (all) => {
    const b = all.find((a) => a.role === "browser" && a.text?.length);
    const again = all.find((a) => a.role === "fixer" && a.pageAgain)?.pageAgain;
    if (!b) return [];
    // after the fixer, the newer look replaces the old one (2026-10-22: the spec checker judged a fixed game by the
    // errors from before the fix)
    if (again) return ["", `yAI opened the page again AFTER the fixer (VERDICT: ${again.verdict || "?"}). This is the current state; the check before the fixer (${b.verdict || "?"}) is out of date:`, ...again.lines];
    return ["", `yAI opened the page in a headless browser after the builders (VERDICT: ${b.verdict || "?"}):`, ...b.text];
  };

  // yAI's map of the project (cli/projmap.js), for the roles that must see all of it (merger, integration, reviewer,
  // fixer, spec): what each file defines and the names that don't line up, worked out at no cost, and how to read a
  // project too big to hold at once. Made when the agent starts, so it shows the files as they are then.
  const mapLines = (all) => {
    const files = [...new Set(all.flatMap((a) => [...(a.files || []), ...(a.changed || [])]))].filter((f) => !/TEAM_CONTRACT/i.test(f));
    let m;
    try { m = PM.projectMap(root, files); } catch { return []; }
    if (!m.text) return [];
    return [
      "", `yAI's map of the project (${m.total} lines; each file with what it defines and the line it starts on):`, m.text,
      "", m.mismatches.length
        ? `Possible mismatches yAI found by reading the code itself (check each before acting; most are real):\n${m.mismatches.map((x) => `- ${x}`).join("\n")}`
        : "yAI found no name used in one file and missing from the others, no missing element id and no missing script.",
      "", "How to read this project: don't read large files whole. You can't hold them all at once, and old file contents are removed from your memory as you go. Start from the map above, then read only the lines you need: read_file with a line range (js/world.js:120-180), several ranges in one read_file, or a search for one name. Never search for everything (\".*\").",
    ];
  };
  const workersLines = (all) => all.filter((a) => !a.role).map((o) => `"${o.name}" did: ${clip(o.task, 300)}${o.changed?.size ? ` (files changed: ${[...o.changed].join(", ")})` : o.files.length ? ` (its files: ${o.files.join(", ")})` : ""}${o.state && o.state !== "done" ? ` (it ${o.state === "stopped" ? "was stopped" : "failed"} before finishing)` : ""}.`);
  const CHECKS = "You may run checks that don't change anything, and should when they help: a syntax check (node --check <file>, python -m py_compile <file>), the project's tests, or its linter. Run one command at a time, without chaining.";
  const RULES = "Don't commit, push or change git history, don't install packages, and don't start servers that keep running. Don't leave scratch or debug files (like _test.js or _smoke.js) behind; delete them before you finish.";
  // The lead's contract: the names every file shares, given word for word to every agent.
  let contract = "", contractFile = "";
  const contractLines = () => (contract ? ["", "The team's CONTRACT: the exact names shared between files. Use these names exactly, never another spelling; if you truly need a name that isn't here, say so in your report under \"For the others\":", contract] : []);
  const verdictRule = (a, b) => `End your report with one last line, exactly "VERDICT: ${a}" or "VERDICT: ${b}".`;
  // Every report in one shape (2026-10-22, Yousef: the reports looked messy), so the agent view can draw it neatly.
  const REPORT_STYLE = [
    "Write the report in this shape, short and plain:",
    "## Report",
    "**Changed** (or **Problems**, **Checks**, **For the others**, **Left to do**: whichever apply, each label on its own line)",
    "- one sentence per bullet, with the file in backticks and the line when you have it, like `app.js:42`",
    "No tables, no code blocks, no long paragraphs, and don't repeat the task. Leave out a section with nothing in it.",
  ].join("\n");

  // The briefs of the members who check the builders' work (phase 2).
  function roleBrief(a, task, all) {
    const n = all.filter((x) => !x.role).length;
    const head = a.role === "architect"
      ? `You are the architect on a team of agents working in this project. ${n} builder agent${n === 1 ? "" : "s"} will build it AFTER you, all at the same time, each from the plan below. The team's overall task: ${task}`
      : a.role === "spec"
        ? `You are the spec checker on a team of agents working in this project. Everyone has finished: the builders, the checkers and the fixer. The team's overall task: ${task}`
        : `You are the ${a.role} on a team of agents working in this project. ${n} builder agent${n === 1 ? "" : "s"} did the work and ${n === 1 ? "has" : "have"} finished. The team's overall task: ${task}`;
    const contractAt = contractFile ? path.relative(root, contractFile).split(path.sep).join("/") : "TEAM_CONTRACT.md";
    const body = {
      architect: [
        `Your job: before anyone builds, design exactly how the pieces fit and write it to ${contractAt}. Every builder gets that file word for word and must follow it, so be precise:`,
        "- every name shared between files: globals and modules, functions with their parameters and return values, events, element ids and classes, storage keys, routes;",
        "- the data shapes passed between files (fields and types), and which file owns (creates and changes) each piece of state;",
        "- the startup order (what loads first, who calls init on whom) and the main loop or request flow, step by step;",
        "- for each file in the layout: what it does and what it must not do.",
        "Keep the lead's names (below) unless one is wrong or clashes with a browser built-in (Audio, Image, Event…); then rename it and say so.",
        `Write only ${contractAt}; don't write app code or other files. Read the project's existing files first if there are any.`,
        "", RULES,
        "When you're done, end with a short report: the main decisions and anything the builders must be careful about.",
      ],
      merger: [
        "Your job: the builders worked separately; join their work so it runs as one thing. Read every file they made, the CONTRACT, and the notes they left for each other (below).",
        "Fix the mismatches between files: a name spelled differently, a function one file calls that another never defines, the wrong load or init order, a script or stylesheet not included, two files defining the same thing, a data shape that doesn't match.",
        "Make the smallest edits that join the pieces. Don't restyle, refactor or add features. Then run the syntax checks (node --check) and any tests.",
        CHECKS, "", RULES,
        "When you're done, end with a short report: each mismatch you fixed, file by file, and anything you couldn't resolve.",
      ],
      designer: [
        "Your job: make it look finished and professional, by changing its styles. Work in the CSS (and add a class or a wrapper in the HTML only where styling needs it).",
        "Spacing and alignment, a clear type scale, a consistent colour palette with good contrast, hover, focus and pressed states for every control, smooth short transitions, and a layout that fits a phone, a tablet and a laptop without cutting anything off.",
        "Don't change any JavaScript, any id, or anything named in the CONTRACT, and don't move or rename files. No new libraries; Google Fonts is fine.",
        "", RULES,
        "When you're done, end with a short report: what you changed and why, file by file.",
      ],
      api: [
        "Your job: check every route or endpoint the builders made, the way a client would call it.",
        "If there is a server, start it in the background (run with <background>true</background>), call each route with good input AND bad input (missing fields, wrong types, unknown ids) using curl or a small script you put under tests/api/, and stop the server (task_stop) before you finish.",
        "Check status codes, that response shapes match the CONTRACT, that errors are handled with clear messages, and that nothing crashes the server. Don't change the app's code.",
        "", "Don't commit, push or change git history, and don't install packages.",
        "When you're done, end with a short report: each route, what you sent, what came back, and every problem with its file and line.", verdictRule("OK", "PROBLEMS"),
      ],
      setup: [
        "Your job: make sure this runs from a clean checkout on another computer. This is a READ-ONLY check: don't edit files.",
        "Check that every require/import points at a real file or at a dependency listed in package.json (and the reverse: listed but unused), that file paths match the real file names exactly including upper/lower case (Windows hides case bugs that break on Linux and Vercel), that package.json scripts point at real files, that nothing points at an absolute path on this PC, that .gitignore covers node_modules and secrets, that no keys or passwords are in the code, and that the README's run steps are complete and correct.",
        CHECKS, "", RULES,
        "When you're done, end with a short report: each problem with its file and line, and how to fix it.", verdictRule("OK", "PROBLEMS"),
      ],
      spec: [
        "Your job: check the finished work against the user's request, item by item. This is a READ-ONLY check: don't edit files.",
        "First list every requirement in the request: each feature, file, behaviour, control and constraint (read it closely; 'and a high score saved' is its own item). Then for each one say DONE, PARTLY or MISSING, with the file and line you checked or what yAI's checks below showed.",
        CHECKS, "", RULES,
        "When you're done, end with the list, then a one-line summary.", verdictRule("OK", "PROBLEMS") + " Answer OK only if every item is DONE.",
      ],
      tester: [
        "Your job: test the builders' work. Write or update tests ONLY in test files (tests/, test/, __tests__/, *.test.*, *.spec.*, test_*.py); don't change the app's code.",
        "Use the project's test setup if it has one; if it has none, use the language's built-in runner (node --test, python -m unittest) without installing anything. Run the tests.",
        "If a test fails because of a bug in the app, leave the bug for the fixer: report the file, the line and what's wrong.",
        "Before you report a failure, check whether the test or the app is wrong (run the code path on its own); fix a wrong test instead of reporting it. Any fake page or DOM in a test must use the CONTRACT's exact ids and names.",
        "Assume the app is wrong first. If you do change a test because it was wrong, list it in your report under \"Tests I changed\" with the reason, and never loosen a test just to make it pass.",
        "Cover every behaviour the task asks for, including each control (every key, the mouse, touch) and that it really moves or changes what it should.",
        CHECKS, "", RULES,
        "When you're done, end with a short report: the command you ran, the tests you wrote, what passed, and every failure with its file and line.",
        verdictRule("PASS", "FAIL") + " The VERDICT line is required: without it your check counts as unfinished.",
      ],
      reviewer: [
        "Your job: review the builders' code as a careful senior engineer would: bugs, wrong logic, missed edge cases (empty input, errors, nulls), missing error handling, duplicated or confusing code.",
        ...(all.some((x) => x.role === "integration" && x.merged) ? ["You also do the integration check (one agent instead of two, to save cost): " + INTEGRATION_ITEMS.join(" ")] : []),
        "This is a READ-ONLY review: do not edit any files. Read the files they changed and the code that uses them.", CHECKS, "", RULES,
        "When you're done, end with a short report: each problem with its file, line, what's wrong and how to fix it, worst first. Mark small style points as nits.",
        verdictRule("OK", "PROBLEMS") + " Answer PROBLEMS only for things that should be fixed before this ships, not nits.",
      ],
      security: [
        "Your job: check the builders' work for security holes: injection (SQL, shell, path), cross-site scripting, missing login or permission checks, secrets or keys in the code, unsafe handling of user input or uploads, open CORS, and sensitive data in logs.",
        "This is a READ-ONLY check: do not edit any files. Read the files they changed and the code that uses them.", CHECKS, "", RULES,
        "When you're done, end with a short report: each hole with its file, line, how it could be abused and how to fix it, worst first.", verdictRule("OK", "PROBLEMS"),
      ],
      docs: [
        "Your job: update the docs for what the builders did: the README (how to run and use the new parts), and any docs/ pages or CHANGELOG the project already keeps. Edit ONLY documentation files (*.md and docs/); don't change code.",
        "Write for someone new to the project: short, plain and accurate. Read the code to check what you write is true.", "", RULES,
        "When you're done, end with a short report: which docs you changed and what you added.",
      ],
      integration: [
        "Your job is NOT to build a piece. You check that all the agents' work fits together properly, as an admin would:",
        ...INTEGRATION_ITEMS,
        "This is a READ-ONLY check: do not edit any files. Read the files the agents changed and the files that use them, and name the file and line for every problem you find.",
        CHECKS, "", RULES,
        "When you're done, end with a short report: problems found (file, what's wrong, how bad), and anything the other agents or the user still need to do. If everything is consistent, say so plainly.",
        verdictRule("OK", "PROBLEMS"),
      ],
    }[a.role];
    return [head, "", ...(a.role === "architect" ? all.filter((x) => !x.role).map((o) => `"${o.name}" will build: ${clip(o.task, 400)}${o.files.length ? ` (its files: ${o.files.join(", ")})` : ""}`) : workersLines(all)), ...contractLines(), ...notesLines(), ...(a.role === "architect" && layoutLines(all).length ? ["", "The planned layout:", ...layoutLines(all)] : []), ...handoffLines(all, a.role === "merger" ? "integration" : a.role), ...browserLines(all), ...(a.role === "spec" || a.phase === 2 ? internalLines(all) : []), ...(WIDE_ROLES.has(a.role) ? mapLines(all) : []), "", ...body].join("\n").replace(/(When you're done, end with a short report:[^\n]*)/, `$1\n${REPORT_STYLE}`);
  }

  // A checker that finished without the VERDICT line it owes.
  const silent = (x) => x.role && x.role !== "fixer" && x.hasVerdict && x.state === "done" && !x.verdict;
  // Something the fixer should look at: a bad verdict, a checker that failed, or one that never said.
  const concern = (x) => x.role && x.role !== "fixer" && (BAD.test(x.verdict || "") || x.state === "failed" || silent(x));

  // The fixer (phase 3) gets the reports that found something, and fixes those problems.
  function fixerBrief(task, all) {
    const found = all.filter(concern);
    return [
      `You are the fixer on a team of agents working in this project. The team's overall task: ${task}`, "",
      ...workersLines(all), "",
      ...contractLines(), ...notesLines(), ...handoffLines(all, "fixer"), ...browserLines(all), ...mapLines(all), "",
      "After them, these checkers found problems. Their reports:", "",
      ...found.map((x) => `## ${x.role} (${x.verdict ? "VERDICT: " + x.verdict : silent(x) ? "it gave no verdict, so treat its report with suspicion and re-run its checks yourself" : x.state})\n${(x.text.join("\n").trim() || x.error || "(no report)").slice(-3000)}`), "",
      "Your job: fix those problems, in any file, with the smallest changes that do it properly. Skip nits and anything that is really a question for the user (list those instead). Then re-run the checks or tests that failed to show they pass now.",
      "Don't break what works: after your edits, run the project's existing tests (the tester's, under tests/ or test/), and check that every behaviour the task asks for still works, not only the ones you touched. When you change how something is controlled (input, keys, the mouse, touch), check EVERY control again, because fixing one often breaks another.",
      // 2026-10-22 (the habit tracker): a fixer made the store return copies where the contract promised the live list,
      // and 13 of the tester's tests broke.
      "Keep what the CONTRACT promises (names, what functions return, data shapes): the other files and the tests rely on it. Change a promise only when a checker shows the contract itself is wrong, and then update every file and test that relies on it.",
      "If one of your own checks fails, assume the app is wrong first. Change a check only when you can show why it's wrong, and list each one in your report under \"Checks I changed\" with the reason; never loosen a check just to make it pass.",
      "Be exact about checks: in your report, give each command you ran and its last result line (for example \"node --test test/ → 58 passed, 2 failed\"). Never say tests pass unless you ran them and they did. yAI re-runs the tests after you and shows the real result next to your verdict.",
      CHECKS, "", RULES,
      "When you're done, end with a short report: each problem and what you did about it, file by file, the checks you ran with their results, and anything left for the user.",
      REPORT_STYLE,
      verdictRule("FIXED", "PARTLY"),
    ].join("\n");
  }

  // ---------- the browser check (web work) ----------
  // yAI opens the page itself: no model writes this, so it can't say it passed when it didn't.
  const CONTROLS_SYSTEM =
    "You check whether a browser game's controls work. You get screenshots taken one after another while a script used the controls; " +
    "each image is labelled with what was done just before it. Find the thing the player controls (a paddle, a ship, a character, a cursor) " +
    "and say whether it moved the way that control should have moved it. Ignore things that move on their own (a ball, enemies). " +
    "Reply with only these lines: KEYS: OK or DEAD or UNSURE, then MOUSE: OK or DEAD or UNSURE (or NOT_USED when the mouse wasn't used), then one short sentence on what you saw. " +
    "DEAD means the control was used and the player's thing did not move; say DEAD whenever that's what you saw.";
  const QA_SYSTEM =
    "You look at a screenshot of a web page or browser game a team of coding agents just built, after its start button was pressed. " +
    "Say in 2-4 sentences what is on screen. Then list anything that looks broken: a blank or black screen, an upside-down or mirrored view, " +
    "overlapping or cut-off UI, text that can't be read, or something the task asks for that isn't there. End with one line: LOOKS: OK or LOOKS: BROKEN.";
  function entryPage(all) {
    const files = all.filter((a) => !a.role).flatMap((a) => a.files).filter((f) => /\.html?$/i.test(f));
    return files.find((f) => /(^|\/)index\.html?$/i.test(f)) || files[0] || null;
  }
  async function browserCheck(a, task, all, { signal } = {}) {
    const B = require("./browser");
    const fs = require("fs");
    const entry = entryPage(all);
    const lines = [], errors = [];
    const abs = entry && path.resolve(root, entry);
    if (!abs || !fs.existsSync(abs)) return { verdict: "FAIL", lines: [`The page ${entry || "(none planned)"} doesn't exist.`] };
    const server = await B.serveFolder(path.dirname(abs));
    let b;
    try {
      b = await B.launch({ width: 1280, height: 720 });
      b.on("Runtime.exceptionThrown", (p) => errors.push(`Uncaught: ${(p.exceptionDetails.exception?.description || p.exceptionDetails.text || "").split("\n")[0]}${p.exceptionDetails.url ? ` (${path.basename(p.exceptionDetails.url)}:${p.exceptionDetails.lineNumber + 1})` : ""}`));
      b.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error") errors.push(`console.error: ${p.args.map((x) => x.value ?? x.description ?? "").join(" ").slice(0, 300)}`); });
      b.on("Network.responseReceived", (p) => { if (p.response.status >= 400 && !/favicon.ico/.test(p.response.url)) errors.push(`${p.response.status} loading ${p.response.url.replace(server.url, "")}`); });
      b.on("Network.loadingFailed", (p) => { if (!p.canceled) errors.push(`Failed to load a file: ${p.errorText}`); });
      await b.send("Network.enable");
      await B.open(b, `${server.url}/${encodeURIComponent(path.basename(abs))}`);
      // press the obvious start button (Play, Start, Drop in…) and let it run for a moment
      const pressed = await B.evaluate(b, `(() => { const el = [...document.querySelectorAll("button, a, [role=button], .btn")].find((e) => e.offsetParent && /^(\\W*)(play|start|drop in|begin|new game|let'?s go)/i.test(e.textContent.trim())); if (!el) return ""; el.click(); return el.textContent.trim().slice(0, 30); })()`).catch(() => "");
      await new Promise((r) => setTimeout(r, pressed ? 2500 : 1200));
      // a 2D canvas that is all one colour is a blank screen
      const page = await B.evaluate(b, `(() => {
        const cs = [...document.querySelectorAll("canvas")].filter((c) => c.width > 100 && c.height > 100);
        let blank = null;
        for (const c of cs) { const g = c.getContext && c.getContext("2d"); if (!g) continue; try { const d = g.getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 997) seen.add(d[i] + "," + d[i+1] + "," + d[i+2]); blank = blank === null ? seen.size <= 2 : blank && seen.size <= 2; } catch (e) {} }
        return { title: document.title, canvases: cs.length, blank, text: document.body.innerText.trim().slice(0, 200) };
      })()`).catch(() => ({}));
      const shot = await B.screenshot(b, { quality: 75 });
      // try the controls: hold the movement keys, sweep the mouse across the game, and let a model that can see compare
      const controls = await tryControls(b, B, task, pressed, page, signal).catch(() => null);
      const dir = path.join(root, "yai-media");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `team-check-${Date.now()}.jpg`);
      fs.writeFileSync(file, shot);
      lines.push(`Opened ${entry}${pressed ? `, pressed "${pressed}"` : ""}; screenshot: ${path.relative(root, file).split(path.sep).join("/")}`);
      if (page.blank) errors.push("The game canvas is blank (one flat colour): nothing is being drawn.");
      // a model that can see describes it (an upside-down view, missing HUD… no test catches those)
      let looks = "";
      try {
        const seen = await X.withVision((m) => X.oneShot({ model: m.id, system: QA_SYSTEM, signal, messages: [{ role: "user", content: [{ type: "text", text: `The task: ${task}${pressed ? `

The page's "${pressed}" button was pressed just before this screenshot, so its start screen is expected to be gone: judge the screen that follows it.` : ""}` }, X.imagePart(shot, "image/jpeg")] }] }), signal);
        looks = String(seen.text || "").trim();
      } catch {}
      if (looks) lines.push(`What it looks like: ${looks.replace(/\n+/g, " ")}`);
      if (controls) {
        lines.push(`Controls: ${controls.summary}`);
        if (controls.keys === "DEAD") errors.push(`The keyboard controls don't move anything (${controls.keyNames} held for a moment each).`);
        if (controls.mouse === "DEAD") errors.push("Moving the mouse across the game doesn't move what the player controls.");
      }
      const unique = [...new Set(errors)].slice(0, 12);
      if (unique.length) lines.push("Errors in the browser:", ...unique.map((e) => `- ${e}`));
      else lines.push("No errors in the browser console.");
      const broken = unique.length || /LOOKS:\s*BROKEN/i.test(looks);
      return { verdict: broken ? "FAIL" : "PASS", lines, file };
    } catch (err) {
      return { verdict: "", lines: [`Couldn't open it in a browser: ${err.message}`] };
    } finally {
      try { b?.close(); } catch {}
      server.close();
    }
  }
  // Holds the movement keys and sweeps the mouse, with a screenshot after each, then asks a model that can see whether
  // the player's thing responded. Only for pages that look like games (a canvas, or a start button that was pressed).
  async function tryControls(b, B, task, pressed, page, signal) {
    if (!pressed && !page.canvases) return null;
    const wasd = /\bwasd\b/i.test(task) && !/arrow/i.test(task);
    const keys = wasd ? [["KeyA", "a", 65, "A"], ["KeyD", "d", 68, "D"]] : [["ArrowLeft", "ArrowLeft", 37, "Left arrow"], ["ArrowRight", "ArrowRight", 39, "Right arrow"]];
    const wantsMouse = /mouse|cursor|click|drag|aim/i.test(task);
    const shots = [];
    const snap = async (label) => shots.push({ label, img: await B.screenshot(b, { quality: 60 }) });
    const hold = async ([code, key, vk]) => {
      await b.send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: vk });
      await new Promise((r) => setTimeout(r, 700));
      await b.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: vk });
    };
    await snap("before using any control");
    await hold(keys[0]); await snap(`after holding ${keys[0][3]} for 0.7 s`);
    await hold(keys[1]); await hold(keys[1]); await snap(`after holding ${keys[1][3]} for 1.4 s`);
    if (wantsMouse) {
      const r = await B.evaluate(b, `(() => { const c = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0]; const x = (c || document.body).getBoundingClientRect(); return { x: x.left, y: x.top, w: x.width, h: x.height }; })()`);
      const y = r.y + r.h * 0.75;
      for (const f of [0.5, 0.35, 0.2, 0.12]) { await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + r.w * f, y }); await new Promise((res) => setTimeout(res, 60)); }
      await new Promise((res) => setTimeout(res, 400));
      await snap("after moving the mouse to the far LEFT of the game");
      for (const f of [0.3, 0.5, 0.7, 0.88]) { await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + r.w * f, y }); await new Promise((res) => setTimeout(res, 60)); }
      await new Promise((res) => setTimeout(res, 400));
      await snap("after moving the mouse to the far RIGHT of the game");
    }
    const content = [{ type: "text", text: `The task: ${task}\nKeys used: ${keys.map((k) => k[3]).join(" and ")}. Mouse used: ${wantsMouse ? "yes, so answer MOUSE with OK, DEAD or UNSURE" : "no (MOUSE: NOT_USED)"}.` }];
    for (const s of shots) content.push({ type: "text", text: s.label }, X.imagePart(s.img, "image/jpeg"));
    const seen = await X.withVision((m) => X.oneShot({ model: m.id, system: CONTROLS_SYSTEM, signal, messages: [{ role: "user", content }] }), signal);
    const text = String(seen.text || "");
    const pick = (k) => (new RegExp(`${k}:\\s*(OK|DEAD|UNSURE|NOT_USED)`, "i").exec(text) || [])[1]?.toUpperCase() || "UNSURE";
    const keysV = pick("KEYS"), mouseV = wantsMouse ? pick("MOUSE") : "NOT_USED";
    const note = text.split("\n").filter((l) => l.trim() && !/^(KEYS|MOUSE):/i.test(l.trim())).join(" ").trim();
    return { keys: keysV, mouse: mouseV, keyNames: keys.map((k) => k[3]).join(" and "), summary: `keys ${keysV.toLowerCase()}${wantsMouse ? `, mouse ${mouseV.toLowerCase()}` : ""}${note ? ` (${note.slice(0, 200)})` : ""}` };
  }

  // the board's browser row: run by yAI, not a child process
  async function startBrowser(a, task, all) {
    Object.assign(a, { state: "working", step: "opening the page in a browser", started: Date.now(), log: [{ k: "brief", text: a.task }] });
    d.wake();
    const r = await browserCheck(a, task, all, { signal: state.abort?.signal });
    a.text = [...r.lines, ...(r.verdict ? [`VERDICT: ${r.verdict}`] : [])];
    for (const l of r.lines) a.log.push({ k: "text", line: l });
    a.verdict = r.verdict;
    // no browser on this PC (or it wouldn't open): skipped, not a failure for the fixer to chase
    a.state = state.interrupted ? "stopped" : r.verdict ? "done" : "skipped";
    if (!r.verdict) a.step = r.lines[0];
    a.ended = Date.now();
    finished(a, all);
    d.wake();
  }

  // yAI's own checks (cli/teamchecks.js) on the board, like the browser row
  async function startInternal(a, task, all) {
    const TC = require("./teamchecks");
    const fn = TC[a.role === "playtester" ? "playtest" : a.role];
    const entry = entryPage(all);
    Object.assign(a, { state: "working", step: { mobile: "opening it at phone, tablet and laptop sizes", performance: "measuring speed and frame rate", accessibility: "running the accessibility rules", playtester: "playing it" }[a.role] || "checking", started: Date.now(), log: [{ k: "brief", text: a.task }] });
    d.wake();
    let r;
    if (!fn || !entry || !require("fs").existsSync(path.resolve(root, entry))) r = { verdict: "", lines: ["There's no page to open."] };
    else { try { r = await fn({ root, entry: path.resolve(root, entry), task, X, signal: state.abort?.signal }); } catch (err) { r = { verdict: "", lines: [`Couldn't run it: ${err.message}`] }; } }
    a.text = [...r.lines, ...(r.verdict ? [`VERDICT: ${r.verdict}`] : [])];
    for (const l of r.lines) a.log.push({ k: "text", line: l });
    a.verdict = r.verdict;
    a.state = state.interrupted ? "stopped" : r.verdict ? "done" : "skipped";
    if (!r.verdict) a.step = r.lines[0];
    a.ended = Date.now();
    finished(a, all);
    d.wake();
  }

  // ---------- running the agents ----------
  // The roles that must hold the whole project at once get a bigger budget before old file contents are trimmed
  // (2026-10-22: a merger on a Minecraft clone, ~2,400 lines over 5 files, kept losing the first files while reading
  // the last, re-read them until the repeat guard stopped it, and never edited). 80k leaves room in a 128k window for
  // the system prompt and the reply; builders keep 48k, which is cheaper and enough for their own files.
  const WIDE_ROLES = new Set(["merger", "integration", "reviewer", "fixer", "spec"]);
  function startAgent(a, task, all) {
    a.state = "starting"; a.started = Date.now(); a.step = "starting"; a.changed = new Set(); a.created = new Set(); a.text = []; a.cost = 0; a.asks = []; a.flag = "";
    a.log = [{ k: "brief", text: a.task }];
    const log = (entry) => { a.log.push(entry); if (a.log.length > 3000) a.log.splice(1, 500); };
    const child = spawn(process.execPath, [path.join(__dirname, "index.js"), "--stdio"], {
      // agents that write get 100 steps (2026-10-22: the fixer ran out at 50 mid-fix); repeats are stopped long before
      cwd: root, env: { ...process.env, YAI_NO_MCP: "1", YAI_THEME: "dark", YAI_MAX_STEPS: a.readOnly ? "50" : "100", YAI_TEAM_AGENT: "1", YAI_COLUMNS: "1000", YAI_TRIM_TOKENS: WIDE_ROLES.has(a.role) ? "80000" : "48000", ...(a.readOnly ? { YAI_REPORT_ONLY: "1" } : a.role && { YAI_SAFE_CHECKS: "1" }) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    a.child = child;
    a.send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch {} };
    let err = "";
    child.stderr.on("data", (b) => (err += b).length > 4000 && (err = err.slice(-4000)));
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let e;
      if (a.child !== child) return; // restarted or skipped from the board: this was the old process
      try { e = JSON.parse(line); } catch { return; }
      if (e.type === "ready") {
        a.send({ type: "mode", mode: a.readOnly ? "plan" : state.mode === "yolo" ? "yolo" : "acceptEdits" });
        const want = a.model || state.model; // the model picked for this agent
        if (e.model !== want) a.send({ type: "model", id: want });
        a.send({ type: "prompt", text: a.role === "fixer" ? fixerBrief(task, all) : a.role ? roleBrief(a, task, all) : brief(task, a, all) });
      } else if (e.type === "busy") { a.state = "working"; a.step = "thinking"; a.lastMove = Date.now(); }
      else if (e.type === "status" && e.text) a.step = String(e.text);
      // its plan, cost and tokens after each reply (the board's progress bar, cost and steps)
      else if (e.type === "progress") { a.plan = e.plan || a.plan; a.cost = e.cost || a.cost; a.tokens = e.tokens || a.tokens; a.fallbacks = e.fallbacks || 0; a.lastMove = Date.now(); }
      else if (e.type === "step") { a.step = `${e.verb} ${e.arg}`.trim(); a.lastMove = Date.now(); a.stuckSaid = false; log({ k: "step", verb: e.verb, arg: e.arg }); }
      else if (e.type === "step-result") log({ k: "result", text: e.summary || e.text || "", tone: e.tone });
      else if (e.type === "diff" && e.path) { a.changed.add(e.path); if (e.created) a.created.add(e.path); log({ k: "diff", ...e }); }
      else if (e.type === "text-start") { a.text = []; log({ k: "gap" }); }
      else if (e.type === "text") { a.text.push(e.line); log({ k: "text", line: e.line }); }
      else if (e.type === "note" && e.text) {
        log({ k: "note", text: e.text });
        if (/kept repeating steps|kept checking without changing/.test(e.text)) a.flag = "stuck · stopped";
        else if (/^paused after \d+ steps/.test(e.text)) a.flag = "hit the step limit";
      }
      else if (e.type === "out" && String(e.text).trim()) for (const l of String(e.text).replace(/\n$/, "").split("\n")) log({ k: "out", line: l });
      else if (e.type === "ask") { a.asks.push(e); log({ k: "ask", text: e.title, detail: e.detail }); d.wake(); }
      else if (e.type === "error") { a.error = e.message; log({ k: "error", text: e.message }); if (a.state !== "working") a.state = "failed"; }
      else if (e.type === "done" && a.state === "working") {
        a.cost = e.cost?.session || 0;
        a.fallbacks = e.fallbacks || 0;
        a.state = state.interrupted ? "stopped" : a.error ? "failed" : "done";
        a.verdict = verdictOf(a.text.join("\n"));
        a.ended = Date.now();
        child.stdin.end();
        finished(a, all);
      }
      d.wake();
    });
    child.on("exit", (code) => {
      if (a.child !== child) return; // restarted or skipped from the board: this was the old process
      if (a.state === "starting" || a.state === "working") { a.state = state.interrupted ? "stopped" : "failed"; a.error ||= clip(err.trim().split("\n").pop() || `stopped (exit ${code})`, 200); if (a.state === "failed") say(a.name, "failed", "bad", a.error); }
      a.ended ||= Date.now();
      d.wake();
    });
  }

  // A finished agent, in the live feed: what it found (handed to the fixer), what it did, and a builder's hand-off
  function finished(a, all) {
    if (a.state !== "done") return;
    a.summary = summaryOf(a);
    if (a.role && a.role !== "fixer" && BAD.test(a.verdict || "")) {
      const p = a.internal ? (a.text || []).filter((l) => l.trim() && !/^\W*VERDICT/i.test(l)).map(tidy) : problemsOf(a);
      const fixer = all.some((x) => x.role === "fixer");
      say(a.name, `${fixer ? "→ fixer: " : "found "}${p.length || "some"} problem${p.length === 1 ? "" : "s"}`, "bad", p[0] || "");
    } else if (a.role === "fixer") say(a.name, a.summary, a.verdict === "FIXED" ? "ok" : "warn");
    else if (a.verdict) say(a.name, `passed${a.internal && a.summary ? ` · ${a.summary.replace(/^Pass · /, "")}` : ""}`, "ok");
    else say(a.name, `finished · ${a.summary}`);
    if (!a.role) { const h = handoffs([a])[0]; if (h) say(a.name, "→ the others", "acc", h.text.split("\n").find((l) => l.trim()) || ""); }
  }

  // the last "VERDICT: X" an agent wrote
  const verdictOf = (text) => {
    const all = [...String(text).matchAll(/VERDICT:?\**\s*\**\s*(OK|PROBLEMS|PASS|FAIL|FIXED|PARTLY)\b/gi)];
    return all.length ? all[all.length - 1][1].toUpperCase() : "";
  };
  const verdictPill = (v) => (!v ? "" : (BAD.test(v) ? c.red : c.green)(v));

  const ICON = { done: () => c.green("✓"), failed: () => c.red("✗"), stopped: () => c.yellow("■"), waiting: () => c.faint("○"), skipped: () => c.faint("–") };
  const ENDED = ["done", "failed", "stopped", "skipped"];

  // One agent's log as lines: what it said, its steps and their results, and its edits as diffs.
  // One row of the view: a multi-line command (node -e "…" over several lines) or note must not break the row, or the
  // rows below are drawn over each other (2026-10-22).
  const row1 = (x) => String(x ?? "").replace(/\s+/g, " ").trim();
  // One line of what an agent says, drawn (2026-10-22, Yousef: "make it look nicer"): headings and **Labels** in bold with room
  // above them, • bullets whose wrapped lines stay under their text, files in code colour, the VERDICT as a pill.
  // Returns { lines, head } (head: set it off with a blank line).
  const inl = (s) => ui.inline(s).replace(/\*\*|`/g, "");
  function reportLines(line, width) {
    let m;
    const s = String(line).replace(/\s+$/, "");
    if ((m = /^\s*#{1,6}\s+(.*)/.exec(s))) return { head: true, lines: [c.bold(c.accent(m[1].replace(/\*\*|`/g, "")))] };
    if ((m = /^\s*\*\*([^*]+?)\*\*:?\s*(.*)$/.exec(s)) && m[1].length < 40) {
      const rest = m[2] ? wrapText(m[2], width - m[1].length - 2) : [];
      return { head: true, lines: [c.bold(c.ink(m[1].replace(/:$/, ""))) + (rest.length ? c.ink(": " + inl(rest[0])) : ""), ...rest.slice(1).map((r) => c.ink(inl(r)))] };
    }
    if ((m = /^\s*\**\s*VERDICT:?\**\s*\**\s*([A-Z]+)/i.exec(s))) return { head: true, lines: [`${c.faint("verdict")} ${verdictPill(m[1].toUpperCase())}`] };
    if ((m = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)/.exec(s))) {
      const ind = " ".repeat(Math.min(m[1].length, 6)), mark = m[2] ? c.faint(`${m[2]}.`) : c.accent("•"), pad = " ".repeat(m[2] ? m[2].length + 2 : 2);
      const body = wrapText(m[3], width - ind.length - pad.length);
      return { lines: body.map((b, i) => `${ind}${i ? pad : mark + " "}${c.ink(inl(b))}`) };
    }
    return { lines: wrapText(s, width).map((b) => c.ink(inl(b))) };
  }
  function logLines(a, all, tick = 0) {
    const w = ui.width();
    const icon = ICON[a.state] ? ICON[a.state]() : c.accent(SPIN[tick % SPIN.length]);
    const n = all.indexOf(a) + 1;
    const time = a.started ? secs((a.ended || Date.now()) - a.started) : "";
    const out = [
      ` ${icon} ${c.bold(c.ink(a.name))} ${c.faint(`#${n}`)}  ${c.dim([a.state === "working" ? row1(a.step) : a.state, a.verdict, a.changed?.size ? `${a.changed.size} file${a.changed.size === 1 ? "" : "s"}` : "", time, a.cost ? `$${a.cost.toFixed(3)}` : ""].filter(Boolean).join(" · "))}`,
      ` ${c.accent("‹")} ${c.faint("back to the team (esc)")}`,
      c.line(" " + "─".repeat(Math.max(10, w - 2))),
    ];
    if (!a.log) return [...out, `   ${c.dim(a.state === "skipped" ? `It didn't run: ${a.step}.` : `It hasn't started yet: it starts ${a.step}.`)}`];
    const TONE = { error: c.red, warn: c.yellow };
    // what the agent says is set off by one blank line; steps in a row stay together, and empty lines are dropped
    let gap = false, fence = false, table = [];
    const blank = () => { if (out[out.length - 1] !== "") out.push(""); };
    // a table's rows are collected, then drawn as one aligned table (or as text, if they weren't a table after all)
    const flushTable = () => {
      if (!table.length) return;
      if (gap) { blank(); gap = false; }
      for (const l of ui.withTables(table, w - 4, (x) => reportLines(x, w - 4).lines)) out.push(`   ${l}`);
      table = [];
    };
    for (const e of a.log) {
      if (e.k === "text" && !fence && ui.isTableRow(e.line)) { table.push(e.line); continue; }
      if (!(e.k === "text" && !e.line.trim())) flushTable();
      if (e.k === "brief") out.push(`   ${c.faint("Its part:")} ${c.dim(clip(row1(e.text), w - 14))}`, "");
      else if (e.k === "gap") gap = true;
      else if (e.k === "text") {
        if (!e.line.trim()) continue;
        if (/^\s*```/.test(e.line)) { fence = !fence; continue; }
        if (gap) { blank(); gap = false; }
        if (fence) { for (const l of wrapText(e.line, w - 4)) out.push(`   ${c.code(l)}`); continue; }
        const r = reportLines(e.line, w - 4);
        if (r.head && out.length > 4) blank();
        for (const l of r.lines) out.push(`   ${l}`);
      }
      else if (e.k === "step") {
        if (gap && out[out.length - 1]?.startsWith("   ") && !/└/.test(out[out.length - 1])) blank();
        gap = false;
        out.push(` ${c.accent("•")} ${c.bold(c.ink(e.verb))} ${c.dim(clip(row1(e.arg), w - e.verb.length - 6))}`);
      }
      else if (e.k === "result") { const t = String(e.text).split("\n").find((x) => x.trim()) || ""; if (t) out.push(`   ${c.faint("└")} ${(TONE[e.tone] || c.dim)(clip(t, w - 6))}`); }
      else if (e.k === "diff") {
        out.push(` ${c.accent("•")} ${c.bold(c.ink(e.created ? "Create" : "Edit"))} ${c.ink(e.path)} ${c.green(`+${e.added}`)} ${c.red(`−${e.removed}`)}`);
        const lines = e.lines || [];
        for (const [kind, num, text] of lines.slice(0, 40)) {
          const body = `${String(num || "").padStart(4)} ${kind === "…" ? "…" : kind} ${clip(String(text).replace(/\t/g, "  "), w - 12)}`;
          out.push(`     ${kind === "+" ? c.green(body) : kind === "-" ? c.red(body) : c.faint(body)}`);
        }
        if (lines.length > 40) out.push(`     ${c.faint(`… ${lines.length - 40} more lines`)}`);
      }
      else if (e.k === "note") out.push(`   ${c.dim(clip(row1(e.text), w - 4))}`);
      else if (e.k === "out") out.push(`   ${clip(String(e.line).replace(/[\r\t]/g, " "), w + 40)}`);
      else if (e.k === "ask") out.push(` ${c.yellow("?")} ${c.ink(row1(e.text))} ${c.dim(clip(row1(e.detail), w - row1(e.text).length - 6))}`);
      else if (e.k === "error") out.push(` ${c.red("✗")} ${c.red(clip(row1(e.text), w - 4))}`);
    }
    flushTable();
    if (a.state === "working" || a.state === "starting") out.push("", ` ${c.accent(SPIN[tick % SPIN.length])} ${c.dim(a.asks.length ? "waiting for you" : clip(row1(a.step), w - 6))}`);
    return out;
  }

  // The test commands the team ran (plain, read-only ones), newest last; or the project's own npm test script.
  function testCommands(all) {
    const seen = new Set(), worked = new Set();
    for (const a of all) {
      const log = a.log || [];
      log.forEach((e, i) => {
        const cmd = e.k === "step" && e.verb === "Run" ? String(e.arg || "").trim() : "";
        if (!cmd || !TESTISH.test(cmd) || /[;&|`><]|\$\(/.test(cmd) || d.riskOf(cmd).tag !== "read-only") return;
        seen.delete(cmd);
        seen.add(cmd);
        const res = log.slice(i + 1).find((x) => x.k === "result" || x.k === "step");
        // a command that couldn't even start (a folder given as a file, a missing module) isn't a test result
        if (res?.k === "result" && !/Cannot find module|ENOENT|is not recognized|not found/i.test(res.text || "")) worked.add(cmd);
      });
    }
    const pool = [...seen].filter((c) => worked.has(c));
    const cmds = (pool.length ? pool : [...seen]).slice(-3);
    if (!cmds.length) {
      try {
        const pkg = JSON.parse(require("fs").readFileSync(path.join(root, "package.json"), "utf8"));
        if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) cmds.push("npm test");
      } catch {}
    }
    // the team's own test suite always runs (2026-10-22: the habit tracker's re-run said "checks pass" while 13 of
    // tests/run.js's tests failed, because the agents had only run single test files): its runner if it has one,
    // else every test file the team wrote
    const made = [...new Set(all.flatMap((a) => [...(a.created || []), ...(a.changed || [])]))].filter((f) => require("fs").existsSync(path.join(root, f)));
    const q = (f) => (/\s/.test(f) ? `"${f}"` : f);
    const runner = made.find((f) => /(^|\/)tests?\/run\.m?js$/.test(f));
    const tests = made.filter((f) => /(^|\/)tests?\/[^/]+\.test\.m?js$/.test(f));
    const own = runner ? `node ${q(runner)}` : tests.length ? `node --test ${tests.map(q).join(" ")}` : "";
    if (own && !cmds.includes(own)) cmds.unshift(own);
    return cmds.slice(0, 3);
  }
  // Runs each command in the project and keeps its exit code, pass/fail counts and last lines.
  function runChecks(cmds, signal) {
    const one = (cmd) => new Promise((resolve) => {
      let out = "", timedOut = false;
      const child = spawn(cmd, { cwd: root, shell: true, windowsHide: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
      const add = (b) => { out += b; if (out.length > 200000) out = out.slice(-100000); };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const kill = () => { try { process.platform === "win32" ? spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]) : child.kill(); } catch {} };
      const timer = setTimeout(() => { timedOut = true; kill(); }, 180000);
      signal?.addEventListener("abort", kill);
      const done = (code) => {
        clearTimeout(timer);
        const clean = out.replace(/\x1b\[[0-9;]*m/g, "");
        resolve({ cmd, code: timedOut ? -1 : code ?? -1, timedOut, counts: d.testCounts(clean), tail: clean.split(/\r?\n/).filter((l) => l.trim()).slice(-12) });
      };
      child.on("error", () => done(-1));
      child.on("close", done);
    });
    return cmds.reduce((p, cmd) => p.then(async (rs) => (signal?.aborted ? rs : [...rs, await one(cmd)])), Promise.resolve([]));
  }

  // ---------- what the /team screens show (cli/teamview.js draws them; 2026-10-22, the "yAI Code Team" design) ----------
  const V = require("./teamview")({ ui });
  const screenW = () => (ui.screen ? (ui.screen.fullWidth?.() || ui.screen.width()) : Math.max(60, (process.stdout.columns || 100) - 2));
  const screenH = () => Math.max(16, (process.stdout.rows || 30) - (ui.screen ? 10 : 6));
  const STAGES = [
    { name: "PLAN", has: (p) => p < 1 }, { name: "BUILD", has: (p) => p === 1 }, { name: "JOIN", has: (p) => p > 1 && p < 1.5 },
    { name: "CHECK", has: (p) => p >= 1.5 && p < 3 }, { name: "FIX", has: (p) => p >= 3 },
  ];
  const stageOf = (a) => STAGES.find((s) => s.has(a.phase || 1))?.name || "BUILD";
  // the live feed (newest first): hand-offs, problems found, agents finishing or stuck, your notes
  let feed = [], teamStarted = 0, teamNotes = [];
  const say = (who, what, tone = "", quote = "") => { feed.unshift({ at: Date.now(), who, what, tone, quote: tidy(quote) }); if (feed.length > 80) feed.pop(); };
  const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const STUCK_MS = 120000; // no step for two minutes
  const stuck = (a) => a.state === "working" && !a.paused && Date.now() - (a.lastMove || a.started) > STUCK_MS;
  const money = (x) => (!x ? "" : x < 0.001 ? "<$0.001" : `$${x.toFixed(3)}`);
  const tokensOf = (n) => (!n ? "0" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const modelShort = (id) => (state.models.find((m) => m.id === id)?.label || id || "").replace(/^yAI\s+/, "");
  // "Read js/x.js" → "Reading js/x.js"
  const ING = { Read: "Reading", Edit: "Editing", Create: "Writing", Run: "Running", Search: "Searching for", List: "Looking in", Find: "Finding", Image: "Looking at", thinking: "Thinking", writing: "Writing", starting: "Starting" };
  const plainStep = (s) => {
    const t = row1(s), m = /^(\w+)\s*(.*)$/.exec(t);
    if (!m) return t;
    return ING[m[1]] ? `${ING[m[1]]}${m[2] ? " " + m[2] : "…"}` : t.charAt(0).toUpperCase() + t.slice(1);
  };
  const tidy = (s) => row1(String(s).replace(/\*\*|`/g, "").replace(/^[-*•]\s+/, ""));
  // the problems in a checker's report: the bullets under **Problems** (or every bullet if it has no such label)
  function problemsOf(a) {
    const lines = (a.text || []).filter((l) => !/^\W*VERDICT/i.test(l));
    const at = lines.findIndex((l) => /^\s*(\*\*|#+\s*)?(problems|issues|bugs|holes|failures)\b/i.test(l));
    const from = at >= 0 ? lines.slice(at + 1) : lines;
    const out = [];
    for (const l of from) {
      if (at >= 0 && /^\s*(\*\*[^*]+\*\*|#+\s)/.test(l)) break;
      if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) out.push(tidy(l.replace(/^\s*\d+[.)]\s+/, "")));
    }
    return out;
  }
  const linesIn = (files) => files.reduce((s, f) => { try { return s + require("fs").readFileSync(path.join(root, f), "utf8").split("\n").length; } catch { return s; } }, 0);
  const shortFiles = (files) => { const n = files.map((f) => path.basename(f)); return `${n.slice(0, 3).join(", ")}${n.length > 3 ? ` +${n.length - 3}` : ""}`; };
  // what a finished agent did, in one line
  function summaryOf(a) {
    const said = (a.text || []).filter((l) => l.trim() && !/^\W*VERDICT/i.test(l)).map(tidy);
    if (a.internal) return `${a.verdict ? (BAD.test(a.verdict) ? "Fail" : "Pass") + " · " : ""}${said[0] || a.step || ""}`;
    if (a.role === "fixer") return `${a.verdict === "FIXED" ? "Fixed" : a.verdict === "PARTLY" ? "Partly fixed" : "Finished"}${a.changed.size ? ` · ${shortFiles([...a.changed])}` : ""}`;
    if (a.hasVerdict && a.role && a.verdict) {
      if (!BAD.test(a.verdict)) return "No problems found";
      const p = problemsOf(a);
      return p.length ? `${p.length} problem${p.length === 1 ? "" : "s"} · ${p[0]}` : "Found problems";
    }
    if (a.changed.size) { const f = [...a.changed]; return `${shortFiles(f)} · ${linesIn(f)} lines`; }
    return a.hasVerdict && a.role ? "Finished without a verdict" : "Finished · no files changed";
  }
  const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
  // what an agent is doing, in plain words
  function actOf(a, all) {
    if (a.state === "waiting") {
      if (a.role === "fixer") { const n = all.filter((x) => x.role && x.role !== "fixer" && ENDED.includes(x.state) && BAD.test(x.verdict || "")).length; return `Starts when the checks finish${n ? ` · ${n} found problems so far` : ""}`; }
      return `Starts ${a.step}`;
    }
    if (a.state === "skipped") return a.merged ? "Done by the reviewer" : cap(a.step || "not needed");
    if (a.state === "failed") return cap(a.error || "failed");
    if (a.state === "stopped") return "Stopped";
    if (a.state === "done") return (a.summary ||= summaryOf(a)) + (a.flag ? ` · ${a.flag}` : "");
    if (a.paused) return "Paused · p to resume";
    if (stuck(a)) return `No progress for ${Math.floor((Date.now() - (a.lastMove || a.started)) / 60000)}m · r retry · s skip · enter to look`;
    const now = a.plan?.steps?.[a.plan.done];
    return now ? cap(now) : plainStep(a.step);
  }
  const stOf = (a) => a.state === "waiting" ? "wait" : a.state === "skipped" ? "skip" : a.state === "stopped" ? "stopped" : a.state === "failed" ? "fail"
    : a.state === "done" ? (a.verdict ? (BAD.test(a.verdict) && a.role !== "fixer" ? "fail" : a.internal || a.role === "fixer" || a.hasVerdict ? "pass" : "done") : "done") : stuck(a) ? "stuck" : "work";
  const pctOf = (a) => {
    if (ENDED.includes(a.state)) return 100;
    if (a.state === "waiting") return 0;
    if (a.plan?.steps?.length) return Math.min(95, Math.round(((a.plan.done + 0.4) / a.plan.steps.length) * 100));
    return Math.min(90, 5 + 5 * (a.log || []).filter((e) => e.k === "step").length);
  };
  // did it actually run? (one stopped or skipped before it started shows no time or cost)
  const ran = (a) => !(["stopped", "skipped"].includes(a.state) && (a.ended || 0) - (a.started || 0) < 1000);
  // the board (run screen)
  function runView(agents, task, tick, sel, estimate) {
    const doneN = agents.filter((a) => ENDED.includes(a.state)).length, working = agents.filter((a) => a.state === "working" || a.state === "starting").length;
    const cost = agents.reduce((s, a) => s + (a.cost || 0), 0);
    const stages = [];
    for (const S of STAGES) {
      const rows = agents.filter((a) => S.has(a.phase || 1));
      if (!rows.length) continue;
      const w = rows.filter((a) => a.state === "working" || a.state === "starting").length;
      const bad = rows.filter((a) => a.state === "done" && BAD.test(a.verdict || "") && a.role !== "fixer").length;
      const all = rows.every((a) => ENDED.includes(a.state));
      const span = all ? Math.max(...rows.map((a) => a.ended || 0)) - Math.min(...rows.map((a) => a.started || Date.now())) : 0;
      const note = all ? (rows.every((a) => a.state === "skipped") ? "not needed" : rows.every((a) => a.state === "stopped" || a.state === "skipped") ? "stopped" : `done in ${secs(span)}${S.name === "BUILD" && rows.length > 1 ? ` · ${rows.length} at the same time` : ""}`)
        : [w && `${w} working`, bad && `${bad} found problems`, !w && rows.every((a) => a.state === "waiting") && (S.name === "FIX" ? "only if needed" : "waiting")].filter(Boolean).join(" · ");
      stages.push({ name: S.name, note, current: w > 0, all, total: rows.length, done: rows.filter((a) => ENDED.includes(a.state)).length, working: w,
        rows: rows.map((a) => ({ n: agents.indexOf(a) + 1, st: stOf(a), name: a.name, act: actOf(a, agents), pct: pctOf(a),
          time: a.state === "waiting" || !ran(a) ? "" : secs((a.ended || Date.now()) - a.started),
          cost: !ran(a) ? "" : a.internal ? "free" : a.cost ? money(a.cost) : ENDED.includes(a.state) && a.state !== "skipped" ? "free" : "" })) });
    }
    const strip = [...stages.map((g) => ({ label: `${cap(g.name.toLowerCase())}${g.current ? ` · ${g.working} working` : ""}`, total: g.total, done: g.done, working: g.working, current: g.current, past: g.all })),
      { label: "Done", total: 0, done: 0, past: doneN === agents.length }];
    return {
      title: `${c.bold(c.ink(clip(task, 60)))}${c.faint(` · ${agents.length} agents`)}`,
      stats: [`${c.bold(c.ink(`${doneN} / ${agents.length}`))} ${c.faint("done")}`, working ? `${c.bold(c.ink(String(working)))} ${c.faint("working")}` : "",
        c.bold(c.ink(secs(Date.now() - teamStarted))), `${c.bold(c.ink(money(cost) || "$0.000"))}${estimate ? c.faint(` of ~${money(estimate)}`) : ""}`],
      strip, stages, sel, tick, width: screenW(), height: screenH(),
      feed: feed.map((f) => ({ t: clock(f.at - teamStarted), who: f.who, whoTone: f.tone, what: f.what, quote: f.quote })),
    };
  }
  // one agent's screen
  function agentView(a, agents, tick) {
    const later = agents.filter((x) => (x.phase || 1) > (a.phase || 1) && x.state === "waiting").map((x) => x.name);
    const touch = a.internal ? [["the page", "opens it"]]
      : !a.role ? [...a.files.slice(0, 4).map((f) => [path.basename(f), "write"]), ...(a.files.length > 4 ? [[`+${a.files.length - 4} more`, "write"]] : []), ["commands", "ask first"]]
      : a.readOnly ? [["every file", "read only"], ["commands", "read-only checks"]]
      : a.role === "tester" ? [["tests", "write"], ["the app", "read only"], ["commands", "safe checks"]]
      : a.role === "designer" ? [["CSS, HTML", "write"], ["commands", "safe checks"]]
      : [["any file", "write"], ["commands", "safe checks"]];
    return {
      tabs: agents.filter((x) => x.state !== "waiting" || x === a).map((x) => ({ name: x.name, st: stOf(x), on: x === a })),
      side: {
        n: agents.indexOf(a) + 1, name: a.name, where: `${cap(stageOf(a).toLowerCase())} stage · ${a.internal ? "built-in" : modelShort(a.model) || "—"}`, desc: a.task,
        stats: [[a.state === "waiting" ? "—" : secs((a.ended || Date.now()) - a.started), a.paused ? "paused" : a.state === "working" ? "running" : a.state], [tokensOf(a.tokens), "tokens"], [a.internal ? "free" : money(a.cost) || "$0.000", ENDED.includes(a.state) ? "in all" : "so far"]],
        steps: (a.plan?.steps || []).map((l, i) => ({ l, st: i < a.plan.done || ENDED.includes(a.state) ? "done" : i === a.plan.done && a.state === "working" ? "work" : "next" })),
        touch, waiting: later,
      },
      body: logLines(a, agents, tick).slice(3), width: screenW(), height: screenH(), tick,
    };
  }
  // what the user said while the team worked, for the agents that start later
  const notesLines = () => (teamNotes.length ? ["", "Notes from the user while the team worked (follow them):", ...teamNotes.map((n) => `- ${n}`)] : []);

  let lastTeam = null; // the last team's agents, for /team log
  function showLog(arg) {
    if (!lastTeam) return print(c.yellow("   No team has run yet in this session."));
    const q = arg.trim().toLowerCase();
    const a = /^\d+$/.test(q) ? lastTeam[Number(q) - 1] : lastTeam.find((x) => x.name.toLowerCase() === q) || lastTeam.find((x) => x.name.toLowerCase().includes(q));
    if (!a) return print(c.yellow(`   Which agent? ${lastTeam.map((x, i) => `${i + 1} ${x.name}`).join(" · ")}`));
    print("");
    for (const l of logLines(a, lastTeam).filter((l, i) => i !== 1)) print(l);
  }

  async function team(arg) {
    if (/^log\b/i.test(arg.trim())) return showLog(arg.trim().slice(3));
    let max = MAX_AGENTS;
    const m = /^([2-8])\s+([\s\S]+)$/.exec(arg.trim());
    if (m) { max = Number(m[1]); arg = m[2]; }
    else if (/\b(as many agents|lots of agents|max(imum)? (number of )?agents|many agents|more agents)\b/i.test(arg)) max = MAX_ASKED;
    const task = arg.trim();
    if (!task) return print(c.yellow("   Usage: /team <task>   (or /team 6 <task> for up to 6 builders, at most 8). A lead splits it, the agents work at the same time."));
    if (state.mode === "plan" || state.tutor) return print(c.yellow("   /team changes files; leave plan or tutor mode first (⇧⇥ or /tutor)."));
    // started in the home folder: the team's files (and yai-media) would land there among everything else
    if (path.resolve(root) === path.resolve(require("os").homedir()) && process.stdout.isTTY) {
      const i = await d.select({ title: "yAI Code is running in your home folder, so the team's files would go there.", detail: "Better: quit, make a folder for the project, and start yai inside it:\n  mkdir my-game && cd my-game && yai", options: ["Cancel", "Build here anyway"] });
      if (i !== 1) return print(c.dim("   Cancelled. Start yai in a project folder and run /team there."));
    }

    // 1. The lead splits the work.
    const lead = X.partnerModel()?.id || state.model;
    let agents;
    try {
      const text = await X.busy("splitting the work", (signal) => X.oneShot({
        model: lead, system: LEAD_SYSTEM, signal,
        messages: [{ role: "user", content: `Project files:\n${projectFiles()}\n\nTask: ${task}\n\nUse at most ${max} agents${max > MAX_AGENTS ? " (the user asked for many: use as many as the work splits into cleanly)" : ""}.` }],
      }));
      agents = parsePlan(text, max);
      try { contract = String(JSON.parse(String(text).match(/\{[\s\S]*\}/)[0]).contract || "").trim().slice(0, 6000); } catch { contract = ""; }
      const folder = (/"folder"\s*:\s*"([^"]*)"/.exec(String(text)) || [])[1]?.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "") || "";
      if (folder && !folder.includes("..")) for (const a of agents) a.files = a.files.map((f) => (f.startsWith(folder + "/") ? f : `${folder}/${f}`));
    } catch (err) {
      return print(c.red(`   ${state.interrupted ? "Stopped." : err.message}`));
    }
    // 2. You pick the team: the lead's builders, the checkers after them, and the fixer. The picks are remembered.
    const saved = api.cfg.team?.roles || {};
    const roles = ROLES.map((r) => ({ ...r, on: r.key in saved ? !!saved[r.key] : typeof r.on === "function" ? r.on(task, agents.length) : r.on }));
    print("");
    ui.note(`${c.accent("◆")} ${c.ink(agents.length === 1 ? "The lead kept it as one part" : `The lead split it into ${agents.length} parts`)} ${c.dim(`· with ${d.modelLabel()}; pick who joins them`)}`);
    for (const a of agents) if (a.files.length) print(`     ${c.accent("•")} ${c.ink(a.name)} ${c.faint(clip(a.files.join(", "), Math.max(20, ui.width() - a.name.length - 10)))}`);
    print("");
    // Each agent's model (2026-10-22): the hosted models, picked per row with ← →; the picks are remembered per role
    // (and one for the builders). yAI's own checks use no model.
    const models = state.models.filter((m) => m.cloud).map((m) => ({ id: m.id, short: m.label.replace(/^yAI\s+/, "") }));
    // Suggested models per role (2026-10-22): the free model where the job is narrow, Ultra Flash where an agent must
    // read the whole project and reason across files (Lite drifted there: a merger re-read files until it was stopped,
    // a tester gave no verdict), Ultra for the architect's one big design job. Each list is tried in order. They
    // replaced the picks saved before they existed once (suggestedV); after that your picks are remembered as before.
    const CHEAP = ["glm-4.7-flash", "deepseek-v4.1-flash"], MID = ["deepseek-v4.1-flash", "deepseek-v4-pro"], TOP = ["deepseek-v4-pro", "deepseek-v4.1-flash"];
    const SUGGESTED = { architect: TOP, builders: CHEAP, designer: CHEAP, docs: CHEAP, api: CHEAP, setup: CHEAP, merger: MID, integration: MID, tester: MID, reviewer: MID, security: MID, fixer: MID, spec: MID };
    const savedModels = api.cfg.team?.suggestedV === 1 ? api.cfg.team?.models || {} : {};
    const modelFor = (key) => [savedModels[key], ...(SUGGESTED[key] || []), state.model, models[0]?.id].find((id) => models.some((m) => m.id === id));
    const group = (label, test) => { const list = roles.filter((r) => test(r.phase)); return list.length ? [{ kind: "head", label }, ...list.map((r) => ({ label: r.key, desc: r.desc, on: r.on, role: r, model: r.internal ? undefined : modelFor(r.key) }))] : []; };
    const rows = [
      ...group("Before the builders", (p) => p < 1),
      { kind: "head", label: "Builders · the lead's split, at the same time" },
      ...agents.map((a) => ({ label: a.name, desc: a.task, on: true, model: modelFor("builders") })),
      ...group("Right after the builders", (p) => p > 1 && p < 1.6),
      ...group("yAI's own checks · in a browser, almost free", (p) => p === 1.6),
      ...group("AI checks · together, after yAI's own", (p) => p === 2),
      ...group("If anything is found", (p) => p === 3),
      ...group("At the end", (p) => p > 3),
    ];
    // The pick screen (teamview.pickLines, 2026-10-22): the rows as stages, each with its model and an estimate, presets
    // on q / r / e, and c to talk the plan over instead. The rows are built stage by stage, so the screen's order is
    // the checklist's.
    const items = rows.filter((r) => r.kind !== "head");
    // a role's typical run: [requests, prompt in thousands of tokens, output in thousands, minutes], from real runs
    // (2026-10-22: the desktop OS team made ~15 requests an agent, 93% of each prompt cached, ~4k tokens out)
    const PROFILE = { architect: [6, 12, 5, 1.5], builder: [14, 16, 4, 1], merger: [16, 35, 2, 2], designer: [10, 18, 2, 1], integration: [12, 35, 1.5, 1.5], tester: [20, 25, 4, 2], reviewer: [12, 35, 1.5, 1.5], security: [12, 35, 1.5, 1.5], docs: [8, 18, 2, 1], api: [12, 25, 2, 1.5], setup: [10, 25, 1.5, 1], fixer: [18, 40, 3, 2], spec: [10, 35, 1.5, 1] };
    const estOf = (r) => {
      if (r.role?.internal) return { usd: 0, min: 0.5 };
      const [req, ctx, out, min] = PROFILE[r.role?.key || "builder"] || PROFILE.builder;
      const p = state.models.find((m) => m.id === r.model)?.price || { in: 0, cached: 0, out: 0 };
      return { usd: (req * ctx * 1000 * (0.07 * (p.in || 0) + 0.93 * (p.cached ?? p.in ?? 0)) + out * 1000 * (p.out || 0)) / 1e6, min };
    };
    const estText = (r) => { if (r.role?.internal) return "free"; const e = estOf(r); return `${e.min < 1 ? "<1" : Math.round(e.min)}m · ${e.usd ? money(e.usd) : "free"}`; };
    const totals = () => {
      const on = items.filter((r) => r.on);
      return { usd: on.reduce((s, r) => s + estOf(r).usd, 0), min: STAGES.reduce((s, S) => s + Math.max(0, ...on.filter((r) => S.has(r.role ? r.role.phase : 1)).map((r) => estOf(r).min)), 0) };
    };
    // presets: Quick (builders, tester, fixer, merger when there are 3+ builders, yAI's own checks), Recommended (each
    // role's default), Everything
    const defOn = (r) => { const R = ROLES.find((x) => x.key === r.role.key); return !!(typeof R.on === "function" ? R.on(task, agents.length) : R.on); };
    const PRESETS = [
      { key: "q", label: "Quick", on: (r) => ["tester", "fixer"].includes(r.role.key) || (r.role.key === "merger" && agents.length >= 3) || (!!r.role.internal && defOn(r)) },
      { key: "r", label: "Recommended", on: defOn },
      { key: "e", label: "Everything", on: () => true },
    ];
    const count = (p) => items.filter((r) => (r.role ? p.on(r) : r.on)).length;
    const NOTES = { PLAN: "first", BUILD: `${agents.length} at the same time`, JOIN: "after the builders", CHECK: "yAI's own, then AI", FIX: "only if needed" };
    const picked = await d.checklist({
      rows, models, start: () => "",
      render: (sel) => {
        const t = totals(), n = items.filter((r) => r.on).length, b = items.filter((r) => !r.role && r.on).length;
        const groups = STAGES.map((S) => ({ name: S.name, note: NOTES[S.name], rows: items.filter((r) => S.has(r.role ? r.role.phase : 1)) })).filter((g) => g.rows.length);
        return V.pickLines({
          title: "Pick your team", width: screenW(), sel,
          sub: `The lead split "${clip(task, 60)}" into ${agents.length} builder job${agents.length === 1 ? "" : "s"}. Choose who else joins and which model each one uses.`,
          presets: PRESETS.map((p) => ({ label: p.label, count: count(p), on: items.every((r) => !r.role || !!r.on === p.on(r)) })),
          start: { n: b ? n : 0, time: `~${Math.max(1, Math.round(t.min))} min`, cost: t.usd ? `~${money(t.usd)}` : "free", parallel: b },
          groups: groups.map((g) => ({ ...g, rows: g.rows.map((r) => ({ n: items.indexOf(r) + 1, label: r.label, on: r.on, model: modelShort(r.model), desc: r.desc, est: estText(r), builtIn: !!r.role?.internal })) })),
        });
      },
      onKey: (s, key, { draw, finish }) => {
        const p = !key.ctrl && PRESETS.find((x) => x.key === s);
        if (p) { for (const r of items) if (r.role) r.on = p.on(r); draw(); return true; }
        if (s === "c" && !key.ctrl) { finish({ chat: true }); return true; }
        return false;
      },
      keys: [["↑↓", "move"], ["space", "toggle"], ["← →", "model"], ["q r e", "presets"], ["enter", "start"], ["c", "chat"], ["esc", "cancel"]],
    });
    if (!picked) return print(c.dim("   Cancelled."));
    if (picked.chat) {
      state.pendingContext.push(`I ran /team for: "${task}". The lead split it into: ${agents.map((a) => `${a.name} (${a.task}${a.files.length ? `; files: ${a.files.join(", ")}` : ""})`).join("; ")}. I want to talk the plan over before starting; when it's right I'll run /team again.`);
      return print(c.dim("   Not started. Say what you'd change about the plan, then run /team again."));
    }
    const estimate = totals().usd;
    items.forEach((r, i) => (r.on = picked[i]));
    const builderRows = items.filter((r) => !r.role);
    agents.forEach((a, i) => (a.model = builderRows[i].model));
    api.cfg.team = { ...(api.cfg.team || {}), suggestedV: 1, roles: Object.fromEntries(items.filter((r) => r.role).map((r) => [r.role.key, r.on])),
      models: { ...savedModels, ...Object.fromEntries(items.filter((r) => r.role && r.model).map((r) => [r.role.key, r.model])), ...(builderRows[0]?.model && { builders: builderRows[0].model }) } };
    api.save();
    agents = agents.filter((a, i) => builderRows[i].on);
    if (!agents.length) return print(c.dim("   No builders picked, so nothing ran."));
    const memberRows = items.filter((r) => r.role && r.on);
    const members = memberRows.map((r) => r.role);
    if (agents.length === 1 && !members.length) {
      ui.note(`${c.accent("◆")} ${c.ink("Just one builder, so yAI does it here on its own.")}`);
      return d.runAgent(agents[0].task === task ? task : `${task}\n\n(Your part: ${agents[0].task})`);
    }
    for (const [i, r] of members.entries()) agents.push({ name: r.key, task: r.desc, files: [], role: r.key, phase: r.phase, readOnly: !!r.readOnly || !!r.internal, internal: !!r.internal, hasVerdict: r.verdict !== false, model: memberRows[i].model });
    // The layout: the folders exist before anyone writes, and everyone gets the same map (in their brief).
    // Files already in the project's folder that the plan doesn't mention (a stopped team's leftovers…): move them aside?
    const fs = require("fs");
    const planned = new Set(agents.filter((a) => !a.role).flatMap((a) => a.files));
    const folders = [...new Set([...planned].map((f) => f.split("/")[0]).filter((f) => [...planned].some((p) => p.startsWith(f + "/"))))];
    const extra = [];
    for (const f of folders) {
      const walk = (dir) => { for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) { const rel = `${dir}/${e.name}`; if (e.isDirectory()) { if (!/^(node_modules|\.git|yai-media)$/.test(e.name)) walk(rel); } else if (!planned.has(rel)) extra.push(rel); } };
      try { if (fs.existsSync(path.join(root, f))) walk(f); } catch {}
    }
    if (extra.length) {
      print("");
      print(`   ${c.yellow("!")} ${c.ink(`${folders.join(", ")} already has ${extra.length} file${extra.length === 1 ? "" : "s"} the plan doesn't use`)} ${c.faint(clip(extra.join(", "), ui.width() - 30))}`);
      const i = await d.select({ title: "What should happen to them?", options: ["Move them aside first (to .yai-old/)", "Keep them (the agents see them)", "Cancel"] });
      if (i === 2 || i < 0) return print(c.dim("   Cancelled."));
      if (i === 0) {
        const away = path.join(root, ".yai-old", new Date().toISOString().replace(/[:.]/g, "-"));
        for (const f of extra) { const to = path.join(away, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(path.join(root, f), to); }
        print(c.dim(`   Moved to ${path.relative(root, away).split(path.sep).join("/")}/`));
      }
    }
    // the contract on disk, so the agents (and you) can read it any time (the architect, if on, rewrites it in detail)
    contractFile = path.join(root, folders.length === 1 ? folders[0] : "", "TEAM_CONTRACT.md");
    if (contract) {
      const file = contractFile;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# Team contract\n\nThe names every file shares, planned by the lead before the agents started. Use them exactly.\n\n${contract}\n`);
        print(`   ${c.accent("◆")} ${c.ink("The contract")} ${c.dim(`· ${contract.split("\n").length} shared names, in ${path.relative(root, file).split(path.sep).join("/")}; every agent gets it`)}`);
      } catch {}
    }
    // web work: yAI opens the page in a browser between the builders and the checkers
    if (entryPage(agents)) agents.splice(agents.findIndex((a) => a.role) === -1 ? agents.length : agents.findIndex((a) => a.role), 0, { name: "browser", task: "yAI opens the page in a browser: console errors, failed loads, a blank screen, and what it looks like", files: [], role: "browser", phase: 1.5, readOnly: true, hasVerdict: true, internal: true });
    // the board lists them in the order they run (2026-10-22: the architect, which runs first, was listed 9th)
    agents.sort((x, y) => (x.phase || 1) - (y.phase || 1));
    const layout = layoutLines(agents);
    if (layout.length) {
      let made = [];
      try { made = makeFolders(agents); } catch (err) { print(c.yellow(`   Couldn't make the folders: ${err.message}`)); }
      print("");
      print(`   ${c.accent("◆")} ${c.ink("The layout")} ${c.dim(made.length ? `· made ${made.length} folder${made.length === 1 ? "" : "s"}; every agent gets this map before it starts` : "· every agent gets this map before it starts")}`);
      for (const l of layout.slice(0, 40)) print(`   ${l.endsWith("/") ? c.ink(l) : l.replace(/^(\s*)(\S+)(\s+\(.*\))$/, (m, sp, f, o) => sp + c.ink(f) + c.faint(o))}`);
      if (layout.length > 40) print(c.dim(`     … ${layout.length - 40} more`));
    }

    // 3. They run; the board redraws while they work. Esc stops them all.
    state.busy = true;
    state.interrupted = false;
    state.abort = new AbortController();
    d.syncMute();
    const tty = process.stdout.isTTY && !state.stdio;
    let drawn = 0, tick = 0, wake = () => {}, over = false, asking = false;
    let viewing = null; // the agent you're watching, or null for the board
    d.wake = () => wake();
    let sel = 0; // the agent picked on the board with ↑↓
    feed = []; teamNotes = []; teamStarted = Date.now();
    const draw = () => {
      // once the team is done the board belongs to the conversation; an agent's process ending later (it calls wake)
      // mustn't draw it again under the reports
      // while an agent's question is open it owns the bottom of the screen; redrawing the board would wipe it
      if (!tty || over || asking) return;
      const t = tick++;
      // the screens (cli/teamview.js): the team at work, or the agent you opened
      let lines = viewing ? V.agentLines(agentView(viewing, agents, t)) : V.runLines(runView(agents, task, t, sel, estimate));
      if (ui.screen) return ui.screen.setExtra(["", ...lines]); // the full-window app keeps the board at the end
      // the scrolling terminal redraws in place, so it never draws more lines than the window has
      lines = lines.slice(0, Math.max(10, (process.stdout.rows || 30) - 3));
      if (drawn) process.stdout.write(`\x1b[${drawn}A`);
      for (const l of lines) process.stdout.write("\r\x1b[K" + l + "\n");
      if (drawn > lines.length) process.stdout.write("\x1b[J");
      drawn = lines.length;
    };
    const lastSeen = new Map();
    const report = () => { // without a terminal (the VS Code panel): a line when an agent's step changes
      if (tty) return;
      for (const a of agents) {
        const s = `${a.state}|${a.step}`;
        if (lastSeen.get(a) !== s) { lastSeen.set(a, s); print(c.dim(`   ${a.name}: ${a.state === "working" ? a.step : a.state}`)); }
      }
    };
    state.abort.signal.addEventListener("abort", () => {
      setTimeout(() => d.wake(), 0); // the members still waiting are stopped too
      for (const a of agents) { a.send?.({ type: "stop" }); setTimeout(() => a.child && a.child.exitCode === null && a.child.kill(), 3000); }
    });
    const open = (a) => {
      viewing = a;
      if (a) state.teamView = true;
      else setImmediate(() => (state.teamView = !!viewing)); // the esc that closed it mustn't also stop the team
      if (ui.screen && !a) ui.screen.toBottom();
      draw();
      ui.screen?.render();
    };
    // An agent that is stuck (or failed, or stopped) can be restarted from scratch, and a stuck or waiting one skipped.
    // The old process is let go first, so nothing it still sends reaches the board.
    const letGo = (a) => { const old = a.child; a.child = null; if (old) { try { old.stdin.end(); } catch {} old.kill(); } };
    const retry = (a) => {
      if (!a || a.state === "waiting" || a.state === "skipped") return;
      letGo(a);
      Object.assign(a, { ended: 0, error: "", verdict: "", summary: "", plan: null, paused: false, flag: "" });
      say(a.name, "restarted by you", "you");
      if (a.role === "browser") startBrowser(a, task, agents);
      else if (a.internal) startInternal(a, task, agents);
      else startAgent(a, task, agents);
      draw();
    };
    const skip = (a) => {
      if (!a || !(a.state === "waiting" || stuck(a) || a.paused)) return;
      letGo(a);
      Object.assign(a, { state: "skipped", step: "skipped by you", ended: Date.now() });
      say(a.name, "skipped by you", "you");
      wake();
    };
    const togglePause = (a) => {
      if (!a?.send || a.state !== "working") return;
      a.paused = !a.paused;
      a.send({ type: a.paused ? "pause" : "resume" });
      say(a.name, a.paused ? "paused by you (it stops after this step)" : "resumed", "you");
      draw();
    };
    // keys: ↑↓ and enter on the board; tab, p and r in an agent's view; r and s act on a stuck agent, so they don't take
    // the first letter of a note you're typing
    state.keyHook = (s, key) => {
      if (over) return false;
      const typing = !!d.inputLine();
      if (viewing) {
        if (key.name === "escape") { open(null); return true; }
        if (key.name === "tab") { const list = agents.filter((x) => x.state !== "waiting"); open(list[(list.indexOf(viewing) + 1) % list.length] || viewing); return true; }
        if (!typing && s === "p" && viewing.state === "working") { togglePause(viewing); return true; }
        if (!typing && s === "r" && ["failed", "stopped"].concat(stuck(viewing) ? ["working"] : []).includes(viewing.state)) { retry(viewing); return true; }
        return false;
      }
      if (typing) return false;
      if (key.name === "up") { sel = (sel + agents.length - 1) % agents.length; draw(); return true; }
      if (key.name === "down") { sel = (sel + 1) % agents.length; draw(); return true; }
      if (key.name === "return" || key.name === "enter") { open(agents[sel]); return true; }
      const a = agents[sel];
      if (s === "r" && a && (stuck(a) || a.state === "failed" || a.state === "stopped")) { retry(a); return true; }
      if (s === "s" && a && (stuck(a) || a.paused)) { skip(a); return true; }
      if (/^[1-9]$/.test(s || "") && Number(s) <= agents.length) { open(agents[Number(s) - 1]); return true; }
      return false;
    };
    state.teamKeys = () => viewing
      ? [["esc", "back to team"], ["tab", "next agent"], ...(viewing.state === "working" ? [["p", viewing.paused ? "resume it" : "pause it"]] : []), ...(["failed", "stopped"].includes(viewing.state) || stuck(viewing) ? [["r", "restart it"]] : [])]
      : [["↑↓", "pick agent"], ["enter", "watch it"], ...(agents[sel] && (stuck(agents[sel]) || ["failed", "stopped"].includes(agents[sel].state)) ? [["r", "retry"]] : []), ...(agents[sel] && (stuck(agents[sel]) || agents[sel].paused) ? [["s", "skip"]] : []), ["esc", "stop all"]];
    // what you type goes to the whole team (now, and in the briefs of agents that start later), or to the agent you're watching
    state.teamInput = (text) => {
      if (over) return;
      if (viewing) {
        if (viewing.send && viewing.state === "working") { viewing.send({ type: "note", text }); say("you", `→ ${viewing.name}: ${text}`, "you"); }
        else say("you", `(${viewing.name} isn't working, so it didn't get: ${text})`, "you");
      } else {
        teamNotes.push(text);
        for (const a of agents) if (a.send && a.state === "working") a.send({ type: "note", text });
        say("you", `note: ${text}`, "you");
      }
      draw();
    };
    state.teamInput.placeholder = () => (viewing ? `Message ${viewing.name} directly…` : "Add a note for the whole team…");
    state.teamInput.hint = () => (viewing ? `only ${viewing.name} sees this` : "read after each step");
    ui.screen?.onClick((row) => {
      if (over) return;
      if (viewing) { if (/esc ← team/.test(row)) open(null); return; }
      const a = agents.find((x) => new RegExp(`^\\s*\\d+\\s\\S\\s${x.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s`).test(row));
      if (a) open(a);
    });
    const started = Date.now();
    // The builders start now; the checkers wait for them, so they check finished work, not files half-written; the
    // fixer waits for the checkers and only runs if one of them found something.
    const ended = (a) => ENDED.includes(a.state) && !a.asks.length;
    const phase = (n) => agents.filter((a) => (a.phase || 1) === n);
    const hasArchitect = agents.some((a) => a.role === "architect");
    agents.forEach((a) => Object.assign(a, { state: "waiting", step: WAIT_STEP[a.phase || 1] || "later", started: Date.now(), changed: new Set(), created: new Set(), text: [], cost: 0, asks: [] }));
    if (!hasArchitect) for (const a of agents) if (!a.role) a.step = "starting";
    const PHASES = [...new Set(agents.map((a) => a.phase || 1))].sort((x, y) => x - y);
    // Integration costs a whole agent (2026-10-22: ~$0.20 a run). The reviewer takes it on when both run; and when the
    // page opened cleanly and every built-in check passed, the pieces visibly fit, so it isn't needed.
    const integrationNotNeeded = (a) => {
      if (agents.some((x) => x.role === "reviewer" && x.state === "waiting")) return (a.merged = true, a.step = "done by the reviewer");
      const page = agents.filter((x) => x.internal);
      if (page.some((x) => x.role === "browser") && page.every((x) => x.state === "done" && x.verdict && !BAD.test(x.verdict))) return (a.step = "the page checks all passed");
      return false;
    };
    const next = () => {
      for (const n of PHASES) {
        // the builders start from the architect's contract
        if (n === 1 && hasArchitect && contractFile && phase(1).some((a) => a.state === "waiting") && agents.filter((a) => (a.phase || 1) < 1).every(ended)) {
          try {
            const all = require("fs").readFileSync(contractFile, "utf8");
            // a long contract is cut at a line, and says where the rest starts, so an agent reads only the missing part
            let cut = all.length > 16000 ? all.slice(0, all.lastIndexOf("\n", 16000)) : all;
            if (cut.length < all.length) cut += `\n\n(The contract continues in ${path.relative(root, contractFile).split(path.sep).join("/")} from line ${cut.split("\n").length + 1}; read only that part.)`;
            contract = cut.replace(/^# Team contract[^\n]*\n+/, "").trim() || contract;
          } catch {}
        }
        const waiting = phase(n).filter((a) => a.state === "waiting");
        if (!waiting.length || !agents.filter((a) => (a.phase || 1) < n).every(ended)) continue;
        // after a fixer, yAI opens the page again before the spec checker starts, so it judges the fixed version
        const fx = agents.find((a) => a.role === "fixer" && a.state === "done");
        if (n > 3 && fx && agents.some((a) => a.role === "browser") && !state.interrupted && !fx.pageAgain) {
          if (!fx.pageAgainStarted) {
            fx.pageAgainStarted = true;
            for (const a of waiting) a.step = "after yAI opens the page again";
            browserCheck(fx, task, agents, { signal: state.abort?.signal })
              .then((r) => (fx.pageAgain = r), () => (fx.pageAgain = { verdict: "", lines: ["Couldn't open it again."] }))
              .finally(() => wake());
          }
          continue;
        }
        for (const a of waiting) {
          a.started = Date.now();
          if (state.interrupted) Object.assign(a, { state: "stopped", ended: Date.now() });
          else if (a.role === "integration" && integrationNotNeeded(a)) Object.assign(a, { state: "skipped", ended: Date.now() });
          else if (n === 3 && !agents.filter((x) => x.role && (x.phase || 1) < 3).some(concern))
            Object.assign(a, { state: "skipped", step: agents.some((x) => x.role && (x.phase || 1) < 3) ? "nothing to fix" : "no checkers ran", ended: Date.now() });
          else if (a.role === "browser") startBrowser(a, task, agents);
          else if (a.internal) startInternal(a, task, agents);
          else {
            if (a.role === "fixer") { const n = agents.filter(concern).length; say("fixer", `started · ${n} report${n === 1 ? "" : "s"} to fix`, "acc"); }
            startAgent(a, task, agents);
          }
        }
      }
    };
    try {
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          // an agent with no step for two minutes is stuck: once in the feed (the board offers r retry · s skip)
          for (const a of agents) if (stuck(a) && !a.stuckSaid) { a.stuckSaid = true; say(a.name, "has not done anything for 2m", "warn"); }
          draw(); report();
        }, 120);
        wake = async () => {
          if (over) return;
          next();
          if (agents.every(ended)) { clearInterval(timer); draw(); over = true; return resolve(); }
          if (asking) return;
          const a = agents.find((x) => x.asks.length);
          if (!a) return;
          // An agent wants to run something: the board steps aside for the question.
          const q = a.asks[0];
          draw();
          drawn = 0;
          asking = true;
          const i = state.abort.signal.aborted ? -1 : await d.select({ title: `${a.name}: ${q.title}`, detail: q.detail, options: q.options.slice(0, 2).concat("No") });
          a.asks.shift();
          a.send({ type: "answer", id: q.id, choice: i === 2 ? 2 : i });
          asking = false;
          wake();
        };
        draw();
        wake(); // the first stage starts (the architect, or the builders)
      });
    } finally {
      // the full-window app: the board's last state goes into the conversation, where it stays
      state.keyHook = null;
      state.teamKeys = null;
      state.teamInput = null;
      state.teamView = false;
      ui.screen?.onClick(null);
      viewing = null;
      lastTeam = agents;
      if (ui.screen) { ui.screen.setExtra([]); ui.screen.toBottom(); for (const l of V.runLines(runView(agents, task, 0, -1, estimate))) print(l); }
      state.busy = false;
      state.abort = null;
      d.syncMute();
    }

    // 3b. yAI re-runs the team's test commands after the fixer, so its verdict sits next to the real result.
    const fixer = agents.find((a) => a.role === "fixer" && a.state === "done");
    if (fixer && !state.interrupted) {
      const cmds = testCommands(agents);
      if (cmds.length) {
        try { fixer.recheck = await X.busy("re-running the tests", (signal) => runChecks(cmds, signal)); } catch {}
      }
      if (agents.some((a) => a.role === "browser")) {
        try {
          const r = fixer.pageAgain?.verdict ? fixer.pageAgain : await X.busy("opening the page again", (signal) => browserCheck(fixer, task, agents, { signal }));
          if (r.verdict) (fixer.recheck ||= []).push({ cmd: "the page in a browser", code: r.verdict === "PASS" ? 0 : 1, counts: null, tail: r.lines });
        } catch {}
      }
    }

    // 3c. A stopped team: remove the files it created? And files made outside the plan (scratch files) at the end.
    const created = [...new Set(agents.flatMap((a) => [...(a.created || [])]))].filter((f) => require("fs").existsSync(path.join(root, f)));
    if (state.interrupted && created.length && process.stdout.isTTY) {
      const i = await d.select({ title: `The team was stopped. Remove the ${created.length} file${created.length === 1 ? "" : "s"} it created?`, detail: clip(created.join(", "), 400), options: ["Keep them", "Remove them"] });
      if (i === 1) { for (const f of created) { try { require("fs").rmSync(path.join(root, f)); } catch {} } print(c.dim(`   Removed ${created.length} file${created.length === 1 ? "" : "s"}.`)); }
    } else if (!state.interrupted) {
      const plannedNow = new Set(agents.flatMap((a) => a.files));
      const stray = created.filter((f) => !plannedNow.has(f) && !/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.|(^|\/)test_|README|CHANGELOG|docs\/|TEAM_CONTRACT/i.test(f));
      if (stray.length && process.stdout.isTTY) {
        const i = await d.select({ title: `${stray.length} file${stray.length === 1 ? " was" : "s were"} made outside the plan. Delete ${stray.length === 1 ? "it" : "them"}?`, detail: clip(stray.join(", "), 400), options: ["Keep", "Delete"] });
        if (i === 1) for (const f of stray) { try { require("fs").rmSync(path.join(root, f)); } catch {} }
      }
    }

    // 4. The summary (2026-10-22, Yousef: no more every agent's report dumped at the end): one aligned block with the
    // checks, the fix and what needs a look. The reports go into the conversation, and /team log shows any one whole.
    const cost = agents.reduce((s, a) => s + a.cost, 0);
    state.cost.session += cost;
    const files = new Set(agents.flatMap((a) => [...a.changed]));
    const builders = agents.filter((a) => !a.role);
    const crew = agents.filter((a) => a.role);
    const quiet = crew.filter(silent);
    // a labelled row whose parts wrap under each other, never splitting a part or starting a line with a separator
    const row = (label, parts) => {
      if (!parts.length) return;
      const indent = 14, room = Math.max(30, ui.width() - indent - 2), sep = c.faint("  ·  ");
      const lines = [[]];
      for (const p of parts) {
        const cur = lines[lines.length - 1];
        if (cur.length && ui.vis(cur.join(sep)) + 5 + ui.vis(p) > room) lines.push([p]);
        else cur.push(p);
      }
      lines.forEach((l, i) => print(`   ${i ? " ".repeat(indent - 3) : c.faint(label.padEnd(indent - 3))}${l.join(sep)}`));
    };
    const outcome = (a) => a.state === "skipped" ? c.faint("not needed") : a.state !== "done" ? c.yellow(a.state) : verdictPill(a.verdict) || (a.hasVerdict ? c.yellow("no verdict") : c.faint("done"));
    const fixerA = crew.find((a) => a.role === "fixer");
    const free = agents.filter((a) => !a.internal && a.state !== "skipped" && !a.cost).length;
    print("");
    ui.note(`${files.size ? c.green("✓") : c.yellow("!")} ${c.ink(`Team finished in ${secs(Date.now() - started)}`)} ${c.dim(`· ${files.size} file${files.size === 1 ? "" : "s"} changed · $${cost.toFixed(3)}${free ? ` · ${free} agent${free === 1 ? "" : "s"} cost nothing` : ""}`)}`);
    print("");
    row("Built", builders.map((a) => `${ICON[a.state] ? ICON[a.state]() : "·"} ${c.ink(a.name)}${a.flag ? " " + c.yellow(a.flag) : ""}`));
    row("Checked", crew.filter((a) => a.role !== "fixer").map((a) => `${c.dim(a.role)} ${outcome(a)}`));
    if (fixerA) row("Fixed", [
      fixerA.state === "skipped" ? c.faint("nothing to fix") : `${c.dim("fixer")} ${outcome(fixerA)}${fixerA.changed.size ? c.faint(` · ${[...fixerA.changed].join(", ")}`) : ""}`,
      ...(fixerA.recheck || []).map((r) => `${r.code === 0 ? c.green("✓") : c.red("✗")} ${c.dim(clip(r.cmd, 40))}${r.counts ? c.dim(` ${r.counts.passed} passed, ${r.counts.failed} failed`) : ""}`),
    ]);
    // what needs a look, one line each
    const attention = [
      ...agents.filter((a) => a.state === "failed").map((a) => `${a.name} failed${a.error ? `: ${row1(a.error)}` : ""}`),
      ...agents.filter((a) => a.flag).map((a) => `${a.name}: ${a.flag}`),
      ...quiet.map((a) => `${a.role} gave no verdict, so its check may be incomplete`),
      ...(fixerA?.verdict === "FIXED" && fixerA.recheck?.some((r) => r.code !== 0) ? ["the fixer said FIXED, but the checks still fail"] : []),
      ...(fixerA?.recheck || []).filter((r) => r.code !== 0).map((r) => `${clip(r.cmd, 40)} still fails: ${row1(r.tail.slice(-1)[0] || "")}`),
    ];
    for (const t of attention) print(`   ${c.yellow("!")} ${c.ink(clip(t, ui.width() - 6))}`);
    print("");
    print(c.dim(`   /team log 1–${agents.length} shows an agent's whole report · ask a follow-up and yAI has all of them · /review checks the change`));
    const skipped = crew.filter((a) => a.state === "skipped");
    state.pendingContext.push(
      `I ran /team: ${builders.length} builder agent${builders.length === 1 ? "" : "s"} worked on this at the same time${crew.length ? `, then ${crew.map((a) => a.role).join(", ")}` : ""}: "${task}". Their reports:\n\n` +
      agents.filter((a) => a.state !== "skipped").map((a) => `## ${a.name}${a.role ? ` (${a.readOnly ? "read-only " : ""}${a.role})` : ""} (${a.state}${a.verdict ? `, VERDICT: ${a.verdict}` : ""})\nPart: ${a.task}\nFiles changed: ${a.changed.size ? [...a.changed].join(", ") : "none"}\n${(a.text.join("\n").trim() || a.error || "(no report)").slice(-3000)}`).join("\n\n") +
      (skipped.length ? `\n\n(${skipped.map((a) => a.role).join(", ")} didn't run: nothing to fix.)` : "") +
      (quiet.length ? `\n\n(${quiet.map((a) => a.role).join(", ")} finished without a VERDICT line.)` : "") +
      (fixer?.recheck ? `\n\n## Tests re-run by yAI after the fixer\n${fixer.recheck.map((r) => `$ ${r.cmd}\nexit ${r.timedOut ? "(timed out)" : r.code}\n${r.tail.join("\n")}`).join("\n\n")}` : "") +
      "\n\nThe files may have changed since you last read them; re-read before editing.",
    );
  }

  return { team, browserCheck, _views: { runView, agentView, V } }; // browserCheck: for trying the check on its own; _views: for testing the screens
};
