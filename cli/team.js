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
      if (line && (line + " " + w).length > n) { out.push(line); line = w; } else line = line ? line + " " + w : w;
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
      ...contractLines(),
      ...others.map((o) => `"${o.name}" is doing: ${clip(o.task, 300)}${o.files.length ? ` (its files: ${o.files.join(", ")})` : ""}. Don't edit its files; if you need a change there, say so in your report.`),
      "", "Don't commit, push or change git history, and don't start servers that keep running.",
      ...(roles.length ? [`After the builders finish, ${roles.join(", ").replace(/, ([^,]*)$/, " and $1")} ${roles.length === 1 ? "checks" : "check"} the work, so focus on your part.`] : []),
      // 2026-10-22 (a chess run): builders wrote their files in a few steps, then spent 40-100 more printing pieces of
      // them with node -e and writing _test.js harnesses until they were stopped. Building is their job; testing isn't.
      "Write your files, check each once with a syntax check (node --check <file>), fix what that finds, and finish. Don't write test harnesses, scratch tests or fake DOMs: " +
        (roles.includes("tester") ? "the tester does that after you. " : "the checkers do that after you. ") +
        "To look at a file use read_file, never node -e, Get-Content or cat. If you can't make something work after two tries, say so in your report instead of trying more.",
      "When you're done, end with a short report: what you changed, file by file, and anything the others or the user still need to do.",
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
      return m ? { from: a.name, text: m[1].trim().split(/\n#{1,3} /)[0].trim() } : null;
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

  const workersLines = (all) => all.filter((a) => !a.role).map((o) => `"${o.name}" did: ${clip(o.task, 300)}${o.changed?.size ? ` (files changed: ${[...o.changed].join(", ")})` : o.files.length ? ` (its files: ${o.files.join(", ")})` : ""}${o.state && o.state !== "done" ? ` (it ${o.state === "stopped" ? "was stopped" : "failed"} before finishing)` : ""}.`);
  const CHECKS = "You may run checks that don't change anything, and should when they help: a syntax check (node --check <file>, python -m py_compile <file>), the project's tests, or its linter. Run one command at a time, without chaining.";
  const RULES = "Don't commit, push or change git history, don't install packages, and don't start servers that keep running. Don't leave scratch or debug files (like _test.js or _smoke.js) behind; delete them before you finish.";
  // The lead's contract: the names every file shares, given word for word to every agent.
  let contract = "", contractFile = "";
  const contractLines = () => (contract ? ["", "The team's CONTRACT: the exact names shared between files. Use these names exactly, never another spelling; if you truly need a name that isn't here, say so in your report under \"For the others\":", contract] : []);
  const verdictRule = (a, b) => `End your report with one last line, exactly "VERDICT: ${a}" or "VERDICT: ${b}".`;

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
    return [head, "", ...(a.role === "architect" ? all.filter((x) => !x.role).map((o) => `"${o.name}" will build: ${clip(o.task, 400)}${o.files.length ? ` (its files: ${o.files.join(", ")})` : ""}`) : workersLines(all)), ...contractLines(), ...(a.role === "architect" && layoutLines(all).length ? ["", "The planned layout:", ...layoutLines(all)] : []), ...handoffLines(all, a.role === "merger" ? "integration" : a.role), ...browserLines(all), ...(a.role === "spec" || a.phase === 2 ? internalLines(all) : []), "", ...body].join("\n");
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
      ...contractLines(), ...handoffLines(all, "fixer"), ...browserLines(all), "",
      "After them, these checkers found problems. Their reports:", "",
      ...found.map((x) => `## ${x.role} (${x.verdict ? "VERDICT: " + x.verdict : silent(x) ? "it gave no verdict, so treat its report with suspicion and re-run its checks yourself" : x.state})\n${(x.text.join("\n").trim() || x.error || "(no report)").slice(-3000)}`), "",
      "Your job: fix those problems, in any file, with the smallest changes that do it properly. Skip nits and anything that is really a question for the user (list those instead). Then re-run the checks or tests that failed to show they pass now.",
      "Don't break what works: after your edits, run the project's existing tests (the tester's, under tests/ or test/), and check that every behaviour the task asks for still works, not only the ones you touched. When you change how something is controlled (input, keys, the mouse, touch), check EVERY control again, because fixing one often breaks another.",
      "If one of your own checks fails, assume the app is wrong first. Change a check only when you can show why it's wrong, and list each one in your report under \"Checks I changed\" with the reason; never loosen a check just to make it pass.",
      "Be exact about checks: in your report, give each command you ran and its last result line (for example \"node --test test/ → 58 passed, 2 failed\"). Never say tests pass unless you ran them and they did. yAI re-runs the tests after you and shows the real result next to your verdict.",
      CHECKS, "", RULES,
      "When you're done, end with a short report: each problem and what you did about it, file by file, the checks you ran with their results, and anything left for the user.",
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
    d.wake();
  }

  // ---------- running the agents ----------
  function startAgent(a, task, all) {
    a.state = "starting"; a.started = Date.now(); a.step = "starting"; a.changed = new Set(); a.created = new Set(); a.text = []; a.cost = 0; a.asks = []; a.flag = "";
    a.log = [{ k: "brief", text: a.task }];
    const log = (entry) => { a.log.push(entry); if (a.log.length > 3000) a.log.splice(1, 500); };
    const child = spawn(process.execPath, [path.join(__dirname, "index.js"), "--stdio"], {
      // agents that write get 100 steps (2026-10-22: the fixer ran out at 50 mid-fix); repeats are stopped long before
      cwd: root, env: { ...process.env, YAI_NO_MCP: "1", YAI_THEME: "dark", YAI_MAX_STEPS: a.readOnly ? "50" : "100", YAI_TEAM_AGENT: "1", YAI_TRIM_TOKENS: "48000", ...(a.readOnly ? { YAI_REPORT_ONLY: "1" } : a.role && { YAI_SAFE_CHECKS: "1" }) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    a.child = child;
    a.send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch {} };
    let err = "";
    child.stderr.on("data", (b) => (err += b).length > 4000 && (err = err.slice(-4000)));
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      if (e.type === "ready") {
        a.send({ type: "mode", mode: a.readOnly ? "plan" : state.mode === "yolo" ? "yolo" : "acceptEdits" });
        if (e.model !== state.model) a.send({ type: "model", id: state.model });
        a.send({ type: "prompt", text: a.role === "fixer" ? fixerBrief(task, all) : a.role ? roleBrief(a, task, all) : brief(task, a, all) });
      } else if (e.type === "busy") { a.state = "working"; a.step = "thinking"; }
      else if (e.type === "status" && e.text) a.step = String(e.text);
      else if (e.type === "step") { a.step = `${e.verb} ${e.arg}`.trim(); log({ k: "step", verb: e.verb, arg: e.arg }); }
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
        a.state = state.interrupted ? "stopped" : a.error ? "failed" : "done";
        a.verdict = verdictOf(a.text.join("\n"));
        a.ended = Date.now();
        child.stdin.end();
      }
      d.wake();
    });
    child.on("exit", (code) => {
      if (a.state === "starting" || a.state === "working") { a.state = state.interrupted ? "stopped" : "failed"; a.error ||= clip(err.trim().split("\n").pop() || `stopped (exit ${code})`, 200); }
      a.ended ||= Date.now();
      d.wake();
    });
  }

  // the last "VERDICT: X" an agent wrote
  const verdictOf = (text) => {
    const all = [...String(text).matchAll(/VERDICT:?\**\s*\**\s*(OK|PROBLEMS|PASS|FAIL|FIXED|PARTLY)\b/gi)];
    return all.length ? all[all.length - 1][1].toUpperCase() : "";
  };
  const verdictPill = (v) => (!v ? "" : (BAD.test(v) ? c.red : c.green)(v));

  const ICON = { done: () => c.green("✓"), failed: () => c.red("✗"), stopped: () => c.yellow("■"), waiting: () => c.faint("○"), skipped: () => c.faint("–") };
  const ENDED = ["done", "failed", "stopped", "skipped"];
  function boardLines(agents, tick) {
    const w = ui.width();
    const nameW = Math.max(...agents.map((a) => a.name.length));
    return agents.map((a, i) => {
      const icon = ICON[a.state] ? ICON[a.state]() : c.accent(SPIN[tick % SPIN.length]);
      const time = secs((a.ended || Date.now()) - a.started);
      const right = `${a.changed.size ? `${a.changed.size} file${a.changed.size > 1 ? "s" : ""} · ` : ""}${time}${a.cost ? ` · $${a.cost.toFixed(3)}` : ""}`;
      const what = a.state === "done" ? ["finished", a.verdict, a.flag].filter(Boolean).join(" · ") : a.state === "waiting" || a.state === "skipped" ? a.step : a.state === "failed" ? a.error || "failed" : a.state === "stopped" ? "stopped" : a.asks.length ? "waiting for you" : a.step;
      const room = Math.max(8, w - nameW - right.length - 12);
      // the number opens the agent (press it, or click the row)
      return ` ${c.faint(String(i + 1).padStart(2))} ${icon} ${c.ink(a.name.padEnd(nameW))}  ${(a.state === "failed" ? c.red : a.asks.length || a.flag ? c.yellow : c.dim)(clip(String(what).replace(/\s+/g, " "), room).padEnd(room))}  ${c.faint(right)}`;
    });
  }

  // One agent's log as lines: what it said, its steps and their results, and its edits as diffs.
  // One row of the view: a multi-line command (node -e "…" over several lines) or note must not break the row, or the
  // rows below are drawn over each other (2026-10-22).
  const row1 = (x) => String(x ?? "").replace(/\s+/g, " ").trim();
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
    let gap = false;
    const blank = () => { if (out[out.length - 1] !== "") out.push(""); };
    for (const e of a.log) {
      if (e.k === "brief") out.push(`   ${c.faint("Its part:")} ${c.dim(clip(row1(e.text), w - 14))}`, "");
      else if (e.k === "gap") gap = true;
      else if (e.k === "text") {
        if (!e.line.trim()) continue;
        if (gap) { blank(); gap = false; }
        for (const l of wrapText(e.line, w - 4)) out.push(`   ${c.ink(l)}`);
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
    return cmds;
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
  const recheckPill = (rs) => {
    const bad = rs.filter((r) => r.code !== 0).length;
    const counts = rs.find((r) => r.counts)?.counts;
    return bad ? c.red(`checks fail${counts ? ` ${counts.failed}/${counts.passed + counts.failed}` : ""}`) : c.green(`checks pass${counts ? ` ${counts.passed}` : ""}`);
  };

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
    const group = (label, test) => { const list = roles.filter((r) => test(r.phase)); return list.length ? [{ kind: "head", label }, ...list.map((r) => ({ label: r.key, desc: r.desc, on: r.on, role: r }))] : []; };
    const rows = [
      ...group("Before the builders", (p) => p < 1),
      { kind: "head", label: "Builders · the lead's split, at the same time" },
      ...agents.map((a) => ({ label: a.name, desc: a.task, on: true })),
      ...group("Right after the builders", (p) => p > 1 && p < 1.6),
      ...group("yAI's own checks · in a browser, almost free", (p) => p === 1.6),
      ...group("AI checks · together, after yAI's own", (p) => p === 2),
      ...group("If anything is found", (p) => p === 3),
      ...group("At the end", (p) => p > 3),
    ];
    const picked = await d.checklist({
      title: "Who's on the team?", note: "edits are made without asking; other commands still ask", rows,
      start: (items) => {
        const b = items.filter((x) => !x.role && x.on).length, n = items.filter((x) => x.on).length;
        return b ? `Start ${n} agent${n === 1 ? "" : "s"}` : "Pick at least one builder";
      },
    });
    if (!picked) return print(c.dim("   Cancelled."));
    const items = rows.filter((r) => r.kind !== "head");
    items.forEach((r, i) => (r.on = picked[i]));
    api.cfg.team = { ...(api.cfg.team || {}), roles: Object.fromEntries(items.filter((r) => r.role).map((r) => [r.role.key, r.on])) };
    api.save();
    agents = agents.filter((a, i) => items[i].on);
    if (!agents.length) return print(c.dim("   No builders picked, so nothing ran."));
    const members = items.filter((r) => r.role && r.on).map((r) => r.role);
    if (agents.length === 1 && !members.length) {
      ui.note(`${c.accent("◆")} ${c.ink("Just one builder, so yAI does it here on its own.")}`);
      return d.runAgent(agents[0].task === task ? task : `${task}\n\n(Your part: ${agents[0].task})`);
    }
    for (const r of members) agents.push({ name: r.key, task: r.desc, files: [], role: r.key, phase: r.phase, readOnly: !!r.readOnly || !!r.internal, internal: !!r.internal, hasVerdict: r.verdict !== false });
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
    const draw = () => {
      // once the team is done the board belongs to the conversation; an agent's process ending later (it calls wake)
      // mustn't draw it again under the reports
      // while an agent's question is open it owns the bottom of the screen; redrawing the board would wipe it
      if (!tty || over || asking) return;
      let lines = viewing ? logLines(viewing, agents, tick++) : [...boardLines(agents, tick++), "", `   ${c.faint(`press 1–${agents.length}${ui.screen ? " or click an agent" : ""} to watch it`)}`];
      if (ui.screen) return ui.screen.setExtra(["", ...lines]); // the full-window app keeps the board at the end
      // the scrolling terminal redraws in place, so an agent's view shows its latest lines
      if (viewing) lines = [...lines.slice(0, 3), ...lines.slice(3).slice(-Math.max(5, (process.stdout.rows || 30) - 8))];
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
    state.keyHook = (s, key) => {
      if (over) return false;
      if (viewing && (key.name === "escape" || key.name === "left")) { open(null); return true; }
      if (/^[1-9]$/.test(s || "") && !d.inputLine() && Number(s) <= agents.length) { open(agents[Number(s) - 1]); return true; }
      return false;
    };
    state.teamKeys = () => viewing
      ? [["esc", "back to the team"], [`1–${agents.length}`, "another agent"], ["PgUp", "scroll back"]]
      : [[`1–${agents.length}`, "watch an agent"], ...(ui.screen ? [["click", "an agent"]] : []), ["esc", "stop them all"]];
    ui.screen?.onClick((row) => {
      if (over) return;
      if (viewing) { if (/back to the team/.test(row)) open(null); return; }
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
          else startAgent(a, task, agents);
        }
      }
    };
    try {
      await new Promise((resolve) => {
        const timer = setInterval(() => { draw(); report(); }, 120);
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
      state.teamView = false;
      ui.screen?.onClick(null);
      viewing = null;
      lastTeam = agents;
      if (ui.screen) { ui.screen.setExtra([]); ui.screen.toBottom(); for (const l of boardLines(agents, 0)) print(l); }
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

    // 4. The reports: the builders' last lines, then each member's report whole, the fixer last.
    const cost = agents.reduce((s, a) => s + a.cost, 0);
    state.cost.session += cost;
    const files = new Set(agents.flatMap((a) => [...a.changed]));
    const builders = agents.filter((a) => !a.role);
    const crew = agents.filter((a) => a.role);
    print("");
    ui.note(`${files.size ? c.green("✓") : c.yellow("!")} ${c.ink(`Team finished in ${secs(Date.now() - started)}`)} ${c.dim(`· ${files.size} file${files.size === 1 ? "" : "s"} changed${cost ? ` · $${cost.toFixed(3)}` : ""}`)}`);
    if (crew.length) print(`     ${crew.map((a) => `${c.dim(a.role)} ${a.state === "skipped" ? c.faint("not needed") : a.state !== "done" ? c.yellow(a.state) : verdictPill(a.verdict) || (a.hasVerdict ? c.yellow("no verdict") : c.faint("done"))}${a.recheck ? " " + recheckPill(a.recheck) : ""}`).join(c.faint("  ·  "))}`);
    const quiet = crew.filter(silent);
    if (quiet.length) print(`     ${c.yellow("!")} ${c.dim(`${quiet.map((a) => a.role).join(" and ")} finished without a verdict, so ${quiet.length === 1 ? "its check" : "their checks"} may be incomplete${crew.some((a) => a.role === "fixer" && a.state === "done") ? " (the fixer looked at it)" : ""}.`)}`);
    for (const a of [...builders, ...crew]) {
      if (a.state === "skipped") continue;
      print("");
      const what = a.readOnly ? "read-only check" : a.changed.size ? [...a.changed].join(", ") : "no files changed";
      print(` ${ICON[a.state] ? ICON[a.state]() : "·"} ${c.ink(a.name)}${a.verdict ? " " + verdictPill(a.verdict) : ""}${a.flag ? " " + c.yellow(a.flag) : ""} ${c.faint(clip(what, Math.max(20, ui.width() - a.name.length - 16)))}`);
      const said = a.text.join("\n").trim() || a.error || "";
      // a builder's report shows its last lines; the others' reports are shown whole (up to 40 lines), wrapped, without the VERDICT line
      const lines = said.split("\n").filter((x) => x.trim() && !/^\W*VERDICT:/i.test(x.trim()));
      if (a.role) for (const l of lines.slice(0, 40)) for (const w of wrapText(l, ui.width() - 6)) print(`     ${c.ink(w)}`);
      else for (const l of lines.slice(-8)) print(`     ${c.dim(clip(l, ui.width() - 6))}`);
      if (a.recheck) {
        print("");
        print(`     ${c.bold(c.ink("Re-run by yAI"))} ${c.faint("· the tests and the page after the fixer, to check its verdict")}`);
        for (const r of a.recheck) {
          print(`     ${r.code === 0 ? c.green("✓") : c.red("✗")} ${c.ink(clip(r.cmd, ui.width() - 40))} ${c.dim(`· ${r.timedOut ? "timed out" : `exit ${r.code}`}${r.counts ? ` · ${r.counts.passed} passed, ${r.counts.failed} failed` : ""}`)}`);
          if (r.code !== 0) for (const l of r.tail.slice(-6)) print(`         ${c.dim(clip(l, ui.width() - 10))}`);
        }
        if (a.verdict === "FIXED" && a.recheck.some((r) => r.code !== 0)) print(`     ${c.red("!")} ${c.ink("The fixer said FIXED, but the checks still fail.")}`);
      }
    }
    print("");
    print(c.dim(`   Their reports are in this conversation now: ask a follow-up, /review to check the change as a whole, or /team log 1–${agents.length} for an agent's whole log.`));
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

  return { team, browserCheck }; // browserCheck: for trying the check on its own
};
