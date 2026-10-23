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
  // 2026-10-22: split by feature, not by file. A team split by file (renderer.js, mobs.js…) left features that span
  // files (a mob that flashes red when hit and dies: mobs, renderer, audio, player) with no owner, and a single
  // yAI Code session, owning whole features, beat it.
  "Rules: split by FEATURE, the way a player or user would describe the work (for example: the world and terrain; mining, placing and block cracks; " +
  "mobs and combat; inventory and crafting; sound; the menus and HUD), so each agent owns a whole feature end to end. " +
  "\"files\" lists the files an agent CREATES; every file is created by exactly one agent. An agent may also make small exact edits in files " +
  "another agent created when its feature needs them (it never rewrites them), so put the core files (the page, the main loop, the shared " +
  "state) with the agent whose feature is the base the others plug into, and name in the contract where each feature hooks in. " +
  "Each task must make sense without waiting for another (agree on names, routes and data shapes inside the task text so the pieces fit). " +
  "If the task is small, return a single agent. No tool calls.";

// The members who aren't builders. phase 2 runs when the builders finish; phase 3 (the fixer) only if a check found
// something. readOnly roles run in plan mode and can't edit; the others edit, and all may run checks that change nothing.
const WEB = /html|page|site|website|web ?app|game|canvas|\bui\b|frontend|landing|dashboard/i;
// the task without the browser's own APIs ("simple sound with the Web Audio API" isn't a web server to test or secure)
const serverish = (t) => String(t).replace(/\b(web ?audio|canvas|web ?gl|webgpu|fetch|dom|browser|storage|local ?storage|gamepad|speech|web ?speech|pointer ?lock|fullscreen|vibration|clipboard|geolocation|notification|file|web)\s+api\b/gi, "");
const GAME = /\bgame\b|arcade|platformer|shooter|breakout|snake|tetris|pong|\bplayer\b/i;
const ROLES = [
  // 2026-10-22: a single yAI Code session that searched the web for what Minecraft needs beat a team that only had the prompt
  { key: "researcher", phase: 0.2, verdict: false, on: (t, n) => n >= 4, desc: "researches the topic (how it works, how it's built) and what a great version needs; writes TEAM_SPEC.md for everyone" },
  { key: "architect", phase: 0.5, verdict: false, on: (t, n) => n >= 4, desc: "designs how the pieces fit before anyone builds: a detailed TEAM_CONTRACT.md and a skeleton of every file" },
  { key: "merger", phase: 1.2, verdict: false, on: (t, n) => n >= 3, desc: "joins the builders' pieces and fixes mismatches between them" },
  { key: "designer", phase: 1.3, verdict: false, on: (t) => /design|\blooks? (good|great|nice|professional|clean)|beautiful|polish|pretty|modern|sleek|\bstylish|\bstyling/i.test(t), desc: "polishes how it looks (CSS only): spacing, type, colours, states" },
  // one careful QA agent by default (2026-10-22): integration, tester and reviewer each read the whole project and found
  // the same problems; they stay available on their own (e for everything, or tick them)
  { key: "qa", phase: 2, on: true, desc: "one careful check of everything: the pieces fit, bugs, and tests for the main behaviours" },
  { key: "integration", phase: 2, readOnly: true, on: false, desc: "checks the pieces fit together (imports, routes, data shapes)" },
  { key: "tester", phase: 2, on: false, desc: "writes and runs tests for the new work (test files only)" },
  { key: "reviewer", phase: 2, readOnly: true, on: false, desc: "reviews the code for bugs, edge cases and messy code" },
  { key: "security", phase: 2, readOnly: true, on: (task) => /server|api|login|auth|password|token|form|upload|database|sql|payment|cookie|session/i.test(serverish(task)), desc: "looks for security holes (injection, auth, secrets, unsafe input)" },
  { key: "docs", phase: 2, on: false, verdict: false, desc: "updates the README and docs for what changed" },
  { key: "api", phase: 2, on: (t) => /\bapi\b|server|backend|endpoint|route|database|express|\brest\b/i.test(serverish(t)), desc: "calls every route with good and bad input and checks the answers" },
  { key: "setup", phase: 2, readOnly: true, on: (t) => /npm|package|deploy|vercel|install|setup|readme|dependenc/i.test(t), desc: "checks it runs from a clean checkout: imports, dependencies, paths, README" },
  { key: "mobile", phase: 1.6, internal: true, on: (t) => WEB.test(t), desc: "yAI opens it at phone, tablet and laptop sizes" },
  { key: "performance", phase: 1.6, internal: true, on: (t) => GAME.test(t), desc: "yAI measures load time, page weight and frame rate" },
  { key: "accessibility", phase: 1.6, internal: true, on: (t) => WEB.test(t) && !GAME.test(t), desc: "yAI runs axe-core: contrast, labels, alt text, keyboard use" },
  { key: "playtester", phase: 1.6, internal: true, on: (t) => GAME.test(t), desc: "yAI plays the game for 30 s: controls, losing, Play again, saves" },
  { key: "fixer", phase: 3, on: true, desc: "fixes what the checkers found, then re-runs their checks" },
  { key: "spec", phase: 4, readOnly: true, on: true, desc: "checks the result against your request, item by item" },
];
// Rounds (2026-10-22): round r's phases are 10*(r-1) + the usual phase, so lp() is the phase within a round and rnd() an
// agent's round (1 when it has none).
const lp = (p) => Math.round(((p || 1) % 10) * 10) / 10; // rounded: 11.6 % 10 is 1.5999…
const rnd = (a) => a.round || 1;
const WAIT_STEP = { 0.2: "first", 0.5: "first", 0.8: "after the architect", 1: "after the architect", 1.2: "after the builders", 1.3: "after the builders", 1.5: "after the builders", 1.6: "after the builders", 2: "after the builders", 3: "if anything is found", 3.2: "after the fixer", 3.4: "after the re-check", 3.6: "after fixer 2", 4: "at the end" };
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
  // A question for you. The VS Code panel (and yai remote) answer through askHook: select() without a terminal answers
  // its first option at once (2026-10-23: in the panel every builder's "Run this command?" was allowed unasked, and
  // files the plan didn't use were moved aside without a word).
  const choose = (o) => (state.askHook ? state.askHook({ title: o.title, detail: o.detail || "", options: o.options }) : d.select(o));
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
  // The lead's JSON, read leniently: a code fence, trailing commas, unquoted names and single quotes are repaired
  function planJson(text) {
    const m = String(text).replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("the lead didn't return a plan");
    try { return JSON.parse(m[0]); } catch (err) {
      const fixed = m[0]
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
        .replace(/'([^'\\\n]*)'/g, (all, s) => JSON.stringify(s));
      try { return JSON.parse(fixed); } catch { throw new Error(`the plan isn't valid JSON: ${err.message}`); }
    }
  }
  function parsePlan(text, max) {
    const plan = planJson(text);
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

  // /crew's main builder: it owns the whole project and builds it itself, the way a single yAI session does (which beat
  // a team of builders working apart, 2026-10-22), handing separate jobs to helpers when it likes
  function crewBrief(task, me, all) {
    return [
      `You are the main builder of this project: you own all of it, the design, the code and the result. The task: ${task}`,
      ...(rnd(me) > 1 ? ["", `This is round ${rnd(me)}: the app already exists. Improve it as described below; read what you need first, keep what works, and check it as you go.`, "", `What to improve:\n${me.task}`] : []),
      "", "Build it yourself, step by step, as a strong engineer would: get a first version running early, look at it with check_page, then improve it feature by feature, checking as you go. Keep the core yourself: the main loop, the rendering, and how the pieces connect.",
      `You can hand separate, well-defined jobs to helpers with the commission tool, when you like (with <model>lite</model> for a simple, mechanical job, which is cheaper; flash, the default, for one that needs thought): level or map data in a format you define, sound effects, sprite or texture drawing functions, a self-contained module behind an interface you specify, tests, or research. Give each one everything it needs in <task> (what to make, the exact names and interface, the data format) and list the files it owns. Helpers work at the same time as you (at most ${crewMax} at once); their reports reach you after your steps. Helpers make the build faster and better, so use them: early on, decide which parts can be done apart from you, and for a project like this plan on about 2 to 5 helpers, commissioned in your first few steps so they work while you build the core (more only if the work really splits). Don't commission what takes you a few steps, or the core, and don't sit idle while they work.`,
      "Before you finish: call crew_wait, fit in your helpers' work, check the whole thing with check_page, and end with a short report.",
      ...notesLines(), ...specLines(), ...chatLines(), "", CHECKS, "", RULES, "", REPORT_STYLE,
    ].join("\n");
  }
  // a helper: one job, exactly as the main builder described it, in the files it was given
  function helperBrief(task, me) {
    return [
      `You are a helper. The main builder of this project commissioned you for one job; the overall task is: ${clip(task, 1500)}`,
      "", `Your job, as the main builder described it:\n${me.task}`,
      "", me.files.length ? `Files you own (create and change only these; read anything else you need): ${me.files.join(", ")}.` : "Change only what your job needs; read anything else you need.",
      "", "Do exactly this job, with the names, interface and formats it gives. Check your work (a syntax check; check_page only if your job shows on screen). If something in the job is unclear, make the most sensible choice and say so in your report.",
      "", CHECKS, "", RULES,
      "When you're done, end with a short report: what you made, the names other code should call, and anything left undone.",
    ].join("\n");
  }
  function brief(task, me, all) {
    const others = all.filter((a) => a !== me && !a.role);
    const roles = all.filter((a) => a.role).map((a) => a.role);
    return [
      `You are one of ${all.filter((a) => !a.role).length} builder agents working at the same time in this project, as a team${roles.length ? " (checkers look at the work after you)" : ""}. The team's overall task: ${task}`,
      ...(rnd(me) > 1 ? ["", `This is round ${rnd(me)}: the app already exists and runs. Your job is to improve it as described below; read the files you need first, keep what works, and check it with check_page when you're done.`] : []),
      "", `Your feature: ${me.task}`,
      // feature ownership (2026-10-22): the files it creates are its own; it hooks into others' files with small exact edits
      "", me.files.length ? `Files you create (they're yours): ${me.files.join(", ")}. Your feature may also need small hooks in files other agents create (a call in the main loop, a tag in the page): make those with edit_file, a few lines each, and leave the rest of their code alone. Never write_file over a file you didn't create.` : "Keep your changes to the files your feature needs; in files other agents create, only small edit_file hooks.",
      ...(layoutLines(all).length ? ["", "The project layout, planned before anyone started (the folders already exist; create your files at exactly these paths and don't add other folders or rename anything):", ...layoutLines(all)] : []),
      ...contractFor(me), ...notesLines(), ...specLines(), ...chatLines(), "", CHAT,
      ...(all.some((x) => x.role === "skeleton" && BAD.test(x.verdict || "")) ? ["", "yAI opened the architect's skeleton and it doesn't run yet:", ...all.find((x) => x.role === "skeleton").text, "Whoever owns the file with the problem fixes it first."] : []),
      // the architect's skeletons (2026-10-22): every file starts with the shared names, so the pieces fit from the start
      ...(roles.includes("architect") ? ["", "The architect already started your files as skeletons: the shared names with empty bodies. Read them first, keep every name, signature, id and script tag exactly as they are, and fill them in. Don't rename or remove anything a skeleton has; add your own private helpers freely."] : []),
      ...others.map((o) => `"${o.name}" owns: ${clip(o.task, 300)}${o.files.length ? ` (it creates ${o.files.join(", ")})` : ""}. Don't build its feature; if you need something from it that the contract doesn't give, say so in your report under "For the others".`),
      "", "Don't commit, push or change git history, and don't start servers that keep running.",
      ...(roles.length ? [`After the builders finish, ${roles.join(", ").replace(/, ([^,]*)$/, " and $1")} ${roles.length === 1 ? "checks" : "check"} the work, so focus on your part.`] : []),
      // 2026-10-22 (a chess run): builders wrote their files in a few steps, then spent 40-100 more printing pieces of
      // them with node -e and writing _test.js harnesses until they were stopped. Building is their job; testing isn't.
      // builders see the assembled app (2026-10-22): told not to test, they never saw their work run, while a single agent
      // that checked as it went did better. check_page is yAI's own browser check, so it costs nothing and can't loop
      "Build your feature, syntax-check your files (node --check <file>), then see it work in the real app with check_page: it opens the page as everyone has built it so far, starts it, and reports errors, a frozen page and what's on screen. Other features may still be unfinished; fix what check_page shows in YOUR feature, then check again. " +
        "Don't write test harnesses, node -e scripts or fake DOMs (" + (roles.includes("tester") ? "the tester writes tests" : "the checkers test it") + " after you). " +
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
    const b = all.filter((a) => a.role === "browser" && a.text?.length).pop(); // the latest round's
    const again = all.filter((a) => a.role === "fixer" && a.pageAgain).pop()?.pageAgain;
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
  const CHECKS = "You may run checks that don't change anything, and should when they help: a syntax check (node --check <file>, python -m py_compile <file>), the project's tests, or its linter. Run one command at a time, without chaining. For a web page or game, check_page opens it in a real browser, starts it, holds keys you name, and tells you about errors, freezes and what's on screen: use it instead of guessing (and instead of loading browser code in Node). It takes 10-25 s, so use it after a group of changes or a finished feature, not after every small edit; a builder's page is half-built until the others finish, so check your own part once it works and once at the end (with <look_for>). Don't write node -e scripts or fake-DOM harnesses to run browser code: each answers one narrow question and invites another (2026-10-22: a fixer ran 20+ of them and never edited a file).";
  const RULES = "Don't commit, push or change git history, don't install packages, and don't start servers that keep running. Don't leave scratch or debug files (like _test.js or _smoke.js) behind; delete them before you finish.";
  // The lead's contract: the names every file shares, given word for word to every agent.
  let contract = "", contractFile = "";
  const contractLines = () => (contract ? ["", "The team's CONTRACT: the exact names shared between files. Use these names exactly, never another spelling; if you truly need a name that isn't here, say so in your report under \"For the others\":", contract] : []);
  // A builder's part of a long contract: the sections that name its files or feature, plus the ones every file needs
  // (shared names, load order, the main loop). Short contracts, and the roles that see the whole project, get it all.
  const CONTRACT_WHOLE = 6000;
  const contractFor = (me) => {
    if (!contract || contract.length <= CONTRACT_WHOLE || !contractFile) return contractLines();
    let text;
    try { text = require("fs").readFileSync(contractFile, "utf8"); } catch { return contractLines(); }
    const lines = text.split(/\r?\n/);
    // sections at the top two heading levels, with their line numbers in the file
    const parts = [];
    lines.forEach((l, i) => { if (/^#{1,3}\s/.test(l) || !parts.length) parts.push({ head: l.replace(/^#+\s*/, "").trim() || "(start)", from: i + 1, to: i + 1, body: [] }); const p = parts[parts.length - 1]; p.body.push(l); p.to = i + 1; });
    const words = [...(me.files || []).map((p) => path.basename(p).replace(/\.\w+$/, "")), ...String(me.name || "").split(/\s+/)].map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
    const always = /shared|global|namespace|load order|startup|start-up|boot|main loop|game loop|state|event|overview|conventions|naming/i;
    const mine = (p, i) => i === 0 || always.test(p.head) || words.some((w) => p.body.join("\n").toLowerCase().includes(w));
    const keep = parts.filter(mine), rest = parts.filter((p, i) => !mine(p, i));
    if (!rest.length) return contractLines();
    const at = path.relative(root, contractFile).split(path.sep).join("/");
    return ["", "The team's CONTRACT: the exact names shared between files. Use these names exactly, never another spelling; if you truly need a name that isn't here, say so in your report under \"For the others\". These are the parts that concern your feature:",
      keep.map((p) => p.body.join("\n")).join("\n").trim(),
      "", `The other parts are in ${at}; read one only if your feature touches it: ${rest.map((p) => `${p.head} (lines ${p.from}-${p.to})`).join("; ")}.`];
  };
  // TEAM_SPEC.md: the researcher's checklist, next to the contract; everyone after it is pointed at it
  const specFile = () => path.join(contractFile ? path.dirname(contractFile) : root, "TEAM_SPEC.md");
  const specAt = () => path.relative(root, specFile()).split(path.sep).join("/");
  const specLines = () => (require("fs").existsSync(specFile()) ? ["", `${specAt()} has the team's research, from the web: the topic's key facts and numbers, how it's usually built and what goes wrong, and the checklist the result is judged by. Read the parts that touch your work before you start.`] : []);
  const CHAT = "Team chat: team_say tells the other agents something that affects them (a hook you added in a file they own, a shared name you renamed or need, a question about how a piece fits, or the answer to one); give a name in <to> to reach one agent. Their messages reach you after your steps. Use it a few times at most, never for routine progress.";
  // what was said on the chat before this agent started (the last 12 messages)
  const chatLines = () => (chatLog.length ? ["", "The team chat so far (newest last):", ...chatLog.slice(-12).map((m) => `- ${m.from}${m.to ? ` to ${m.to}` : ""}: ${m.text}`)] : []);
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
    const head = a.role === "researcher"
      ? `You are the researcher on a team of agents working in this project. Before anyone plans or builds, you find out what a great version of the task needs. The team's overall task: ${task}`
      : a.role === "architect"
      ? `You are the architect on a team of agents working in this project. ${n} builder agent${n === 1 ? "" : "s"} will build it AFTER you, all at the same time, each from the plan below. The team's overall task: ${task}`
      : a.role === "spec"
        ? `You are the spec checker on a team of agents working in this project. Everyone has finished: the builders, the checkers and the fixer. The team's overall task: ${task}`
        : `You are the ${a.role} on a team of agents working in this project. ${n} builder agent${n === 1 ? "" : "s"} did the work and ${n === 1 ? "has" : "have"} finished. The team's overall task: ${task}`;
    const contractAt = contractFile ? path.relative(root, contractFile).split(path.sep).join("/") : "TEAM_CONTRACT.md";
    const body = {
      researcher: [
        // 2026-10-22 (Yousef): research the topic itself, not only what a great copy of it needs
        "Your job: research the topic itself, then what a great version needs. Search the web (web_search, then web_fetch 3 to 6 of the best sources) for:",
        "- the topic in general: what it is, how it works, its rules, mechanics and the real numbers behind them (speeds, sizes, timings, formulas), so the team builds the real thing rather than a guess;",
        "- how it is usually built: the techniques and algorithms people use for it (for a game, how its world, rendering, physics or AI is normally done), and the mistakes that commonly go wrong;",
        "- what a great version needs: what users or players expect, and what makes amateur versions feel wrong or unfinished.",
        `Then write ${specAt()} in three short parts: "## The topic" (the key facts and numbers, a few lines each), "## How it's built" (the approach to take and the pitfalls to avoid), and "## Checklist": a numbered list of 15 to 40 requirements, most important first, each one line with how to check it ("Breaking a block shows crack stages: hold the left button on a block and watch"). Mark the ones the user asked for with (asked). Keep what the user asked for exactly; add only what a great version clearly needs, not wishes.`,
        `Write only ${specAt()}; don't write code.`,
        "", RULES,
        "When you're done, end with a short report: the sources you used, the most useful facts about the topic, and the 5 requirements that matter most.",
      ],
      architect: [
        `Your job: before anyone builds, design exactly how the pieces fit and write it to ${contractAt}. If the team has a checklist (below), the design must make room for every item on it. Every builder gets that file word for word and must follow it, so be precise:`,
        "- every name shared between files: globals and modules, functions with their parameters and return values, events, element ids and classes, storage keys, routes;",
        "- the data shapes passed between files (fields and types), and which file owns (creates and changes) each piece of state;",
        "- the startup order (what loads first, who calls init on whom) and the main loop or request flow, step by step;",
        "- for each file in the layout: what it does and what it must not do.",
        "Keep the lead's names (below) unless one is wrong or clashes with a browser built-in (Audio, Image, Event…); then rename it and say so.",
        `Read the project's existing files first if there are any.`,
        // 2026-10-22: builders working apart left mismatched names that a slow merger then chased; skeletons prevent them
        "Then start every file in the layout as a skeleton, so the builders fill in pieces that already fit: the shared names from the contract with empty bodies (each function returns a sensible default and has a one-line comment saying what it must do), the module's export or global exactly as the contract says, and for an HTML page every element id the contract names and the <script> and <link> tags in the right load order. No real logic, and keep each skeleton short: the builders write the code.",
        "", RULES,
        "When you're done, end with a short report: the main decisions and anything the builders must be careful about.",
      ],
      merger: [
        "Your job: the builders worked separately; join their work so it runs as one thing.",
        // 2026-10-22: "read every file" sent mergers through the whole project for minutes, re-reading what was trimmed
        "Work from yAI's map and its list of possible mismatches (below): for each one, read only the lines around it (a line range, or a search for the name), decide which side is right (the CONTRACT wins), and fix it with edit_file. Don't read files whole, and don't read the whole project to look for other problems: the checkers after you do that.",
        "Also check the HTML's load order against the contract (which script must load first), and the notes the builders left for each other (below).",
        "Make the smallest edits that join the pieces. Don't restyle, refactor or add features. Then run node --check on the files you changed.",
        // 2026-10-22: a merger wrote a node -e script loading the whole browser game into Node's vm; it never finished
        "Don't write node -e scripts or harnesses that load the project in Node: browser code never finishes there. node --check on each file, and reading the code, are the checks.",
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
        "First list every requirement: every item on the team's checklist if it has one (below), and everything in the request: each feature, file, behaviour, control and constraint (read it closely; 'and a high score saved' is its own item). Then for each one say DONE, PARTLY or MISSING, with the file and line you checked or what yAI's checks below showed.",
        CHECKS, "", RULES,
        "When you're done, end with the list, then a one-line summary, then a line exactly like SCORE: 24/27 (requirements DONE / requirements in your list; PARTLY doesn't count as done).", verdictRule("OK", "PROBLEMS") + " Answer OK only if every item is DONE.",
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
      qa: [
        "Your job: the team's one quality check, done the way a careful senior engineer would, in three parts. Don't change the app's code: the fixer does that from your report.",
        "1. The pieces fit: " + INTEGRATION_ITEMS.join(" "),
        // 2026-10-22: QA reading only the lines the map pointed at missed bugs a plain chat found at once by reading the
        // game and thinking it through as a player
        "2. Bugs, found the way a player or user would hit them: read the core files whole (the main loop, input, the game or app logic, and whatever the request centres on, up to about 2,000 lines; this overrides the reading advice further down), then walk through a session in your head, from the first screen to game over and playing again: what breaks, freezes, does nothing, feels wrong, or doesn't match the request? Also wrong logic and missed edge cases (empty input, errors, nulls). Use the page check results (below) and check_page to confirm what you suspect.",
        "3. Tests: write a few focused tests ONLY in test files (tests/, test/, *.test.*) for the main behaviours the task asks for, using the project's runner or the language's built-in one (node --test) without installing anything, and run them. Logic that can't run outside a browser is checked with check_page instead.",
        "Before you report a problem, check it is real (read the line, or run the code path). Assume the app is wrong first; if you change a test because it was wrong, list it under \"Tests I changed\".",
        CHECKS, "", RULES,
        "When you're done, end with a short report: every real problem worst first, each with its file, line, what's wrong and how to fix it, then the test command and its result. Mark small style points as nits.",
        verdictRule("OK", "PROBLEMS") + " Answer PROBLEMS only for things that should be fixed before this ships.",
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
    // a later round's checkers start from what this round changed (the rest was checked before)
    const roundFiles = rnd(a) > 1 ? [...new Set(all.filter((x) => !x.role && rnd(x) === rnd(a)).flatMap((x) => [...(x.changed || [])]))] : [];
    const focus = rnd(a) > 1 ? ["", roundFiles.length ? `This is round ${rnd(a)}: the earlier rounds were checked already. This round changed: ${roundFiles.join(", ")}. Check those files and the code that uses them closely; for the rest, only make sure nothing broke.` : `This is round ${rnd(a)}: the earlier rounds were checked already; check what this round's agents changed (their reports below) and that nothing else broke.`] : [];
    return [head, ...focus, "", ...(a.role === "architect" ? all.filter((x) => !x.role).map((o) => `"${o.name}" will build: ${clip(o.task, 400)}${o.files.length ? ` (its files: ${o.files.join(", ")})` : ""}`) : workersLines(all)), ...contractLines(), ...notesLines(), ...(a.role !== "researcher" ? specLines() : []), ...chatLines(), "", CHAT, ...(a.role === "architect" && layoutLines(all).length ? ["", "The planned layout:", ...layoutLines(all)] : []), ...handoffLines(all, a.role === "merger" ? "integration" : a.role), ...browserLines(all), ...(a.role === "spec" || lp(a.phase) === 2 ? internalLines(all) : []), ...(WIDE_ROLES.has(a.role) ? mapLines(all) : []), "", ...body].join("\n").replace(/(When you're done, end with a short report:[^\n]*)/, `$1\n${REPORT_STYLE}`);
  }

  // A checker that finished without the VERDICT line it owes.
  const silent = (x) => x.role && x.role !== "fixer" && x.hasVerdict && x.state === "done" && !x.verdict;
  // Something the fixer should look at: a bad verdict, a checker that failed, or one that never said.
  const concern = (x) => x.role && x.role !== "fixer" && (BAD.test(x.verdict || "") || x.state === "failed" || silent(x));

  // The reports that found something, merged into one to-do list before the fixer starts (2026-10-22: the fixer read
  // three reports describing the same bug three ways). One cheap request; without it the fixer works from the reports.
  const TODO_SYSTEM = "You turn a software team's check reports into one to-do list for the engineer who fixes them. Merge duplicates (the same problem reported by several checks is one item), keep only real problems, and order them worst first (broken or crashing, then wrong behaviour, then the rest). One numbered line each: file:line if known, what's wrong, how to fix it. Then, if any, a short \"For the user\" list of questions and nits. Plain text only, no preamble.";
  async function fixerTodo(a, all, task) {
    const found = all.filter((x) => concern(x) && rnd(x) === rnd(a));
    const reports = found.map((x) => `## ${x.role}${x.verdict ? ` (VERDICT: ${x.verdict})` : ""}\n${(x.text.join("\n").trim() || x.error || "(no report)").slice(-4000)}`).join("\n\n");
    if (found.length < 2 && reports.length < 2500) return; // one short report is its own list
    const model = ["deepseek-v4.1-flash"].find((id) => state.models.some((m) => m.id === id)) || state.model;
    try {
      const out = await Promise.race([X.oneShot({ model, system: TODO_SYSTEM, think: "high", signal: state.abort?.signal, messages: [{ role: "user", content: `The task: ${clip(String(task || ""), 600)}\n\n${reports}` }] }), new Promise((r) => setTimeout(() => r(""), 180000))]);
      if (String(out || "").trim().length > 40) { a.todo = String(out).trim(); say("fixer", "has one to-do list from the reports", "acc", clip(row1(a.todo), 200)); }
    } catch {}
  }

  // The fixer (phase 3) gets the reports that found something, and fixes those problems.
  function fixerBrief(task, all, me = {}) {
    // a second round (after yAI's re-check still failed) works only from what the re-check found
    const found = me.fixRound === 2 ? all.filter((x) => x.role === "recheck" && rnd(x) === rnd(me) && x.state === "done" && BAD.test(x.verdict || "")) : all.filter((x) => concern(x) && rnd(x) === rnd(me));
    return [
      `You are the fixer on a team of agents working in this project. The team's overall task: ${task}`, "",
      ...(me.fixRound === 2 ? ["A first fixer already worked on this. yAI then re-checked the result itself (the tests, the page, and playing it), and it still fails. Fix exactly what the re-check below found; that is the whole job.", ""] : []),
      ...workersLines(all), "",
      ...contractLines(), ...notesLines(), ...specLines(), ...chatLines(), "", CHAT, ...handoffLines(all, "fixer"), ...browserLines(all), ...mapLines(all), "",
      ...(me.todo ? ["Your to-do list, merged from every check's report (duplicates combined, worst first). Work through it in order; the full reports follow for detail.", me.todo, ""] : []),
      "After them, these checkers found problems. Their reports:", "",
      // with a to-do list, each report is shorter: the list already has what matters
      ...found.map((x) => `## ${x.role} (${x.verdict ? "VERDICT: " + x.verdict : silent(x) ? "it gave no verdict, so treat its report with suspicion and re-run its checks yourself" : x.state})\n${(x.text.join("\n").trim() || x.error || "(no report)").slice(me.todo ? -1500 : -3000)}`), "",
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
  // The page to open: one the builders planned or made (a /crew builder plans none up front, 2026-10-22: every page
  // check said "no page to open"), else the newest index.html in the project.
  function entryPage(all) {
    const fs = require("fs");
    const files = [...new Set(all.filter((a) => !a.role).flatMap((a) => [...(a.files || []), ...(a.created || []), ...(a.changed || [])]))].filter((f) => /\.html?$/i.test(f) && !/TEAM_REPORT/i.test(f));
    const planned = files.find((f) => /(^|\/)index\.html?$/i.test(f)) || files[0];
    if (planned) return planned;
    const found = [];
    const look = (dir, depth) => { let list = []; try { list = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; } for (const e of list) { const p = dir ? `${dir}/${e.name}` : e.name; if (e.isFile() && /^index\.html?$/i.test(e.name)) found.push(p); else if (e.isDirectory() && depth < 2 && !/^(node_modules|\.git|yai-media|\.yai-old|\.yai-team|tests?)$/.test(e.name)) look(p, depth + 1); } };
    look("", 0);
    found.sort((x, y) => { try { return fs.statSync(path.join(root, y)).mtimeMs - fs.statSync(path.join(root, x)).mtimeMs; } catch { return 0; } });
    // only a page made or changed during this run (started in a home folder, another project's page is nearby)
    return found.find((p) => { try { return !!teamStarted && fs.statSync(path.join(root, p)).mtimeMs >= teamStarted - 60000; } catch { return false; } }) || null;
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
    // a browser or local server that fails to start is a skipped check, not a crash (2026-10-22 review)
    const r = await browserCheck(a, task, all, { signal: state.abort?.signal }).catch((err) => ({ verdict: "", lines: [`Couldn't open the page: ${err.message}`] }));
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

  // The finish gate (2026-10-22): after the fixer, yAI itself re-runs the tests, opens the page and plays the game. A
  // team isn't done while those fail: a second fixer round gets only the failing evidence, then one more re-check.
  // (The habit tracker was "finished" with 13 tests failing; a Minecraft clone was "finished" freezing on New World.)
  async function startRecheck(a, task, all) {
    Object.assign(a, { state: "working", step: "re-running the tests and the page", started: Date.now(), log: [{ k: "brief", text: a.task }] });
    d.wake();
    const fixers = all.filter((x) => x.role === "fixer" && rnd(x) === rnd(a));
    const fx = fixers.filter((x) => (x.phase || 1) < a.phase).pop();
    const base = a.phase - lp(a.phase);
    const results = [];
    try {
      const cmds = testCommands(all);
      if (cmds.length) for (const r of await runChecks(cmds, state.abort?.signal)) results.push({ name: r.cmd, ok: r.code === 0, lines: r.tail.slice(-6), counts: r.counts, r });
      if (all.some((x) => x.role === "browser") && entryPage(all)) {
        a.step = "opening the page again";
        const r = await browserCheck(fx || a, task, all, { signal: state.abort?.signal });
        if (fx) fx.pageAgain = r;
        if (r.verdict) results.push({ name: "the page in a browser", ok: r.verdict === "PASS", lines: r.lines });
      }
      // yAI's own checks that failed before the fix (phone sizes, accessibility, speed) are run again too
      const TCx = require("./teamchecks");
      for (const x of all.filter((y) => ["mobile", "accessibility", "performance"].includes(y.role) && BAD.test(y.verdict || ""))) {
        if (!entryPage(all) || !TCx[x.role]) continue;
        a.step = `running the ${x.role} check again`;
        const r = await TCx[x.role]({ root, entry: path.resolve(root, entryPage(all)), task, X, signal: state.abort?.signal }).catch((err) => ({ verdict: /frozen|didn't answer/.test(err.message) ? "FAIL" : "", lines: [`Couldn't run it: ${err.message}`] }));
        if (r.verdict) results.push({ name: `the ${x.role} check`, ok: !BAD.test(r.verdict), lines: r.lines });
      }
      if (all.some((x) => x.role === "playtester") && entryPage(all)) {
        a.step = "playing it again";
        const TC = require("./teamchecks");
        const r = await TC.playtest({ root, entry: path.resolve(root, entryPage(all)), task, X, signal: state.abort?.signal }).catch((err) => ({ verdict: /frozen|didn't answer/.test(err.message) ? "FAIL" : "", lines: [`Couldn't play it: ${err.message}`] }));
        if (r.verdict) results.push({ name: "playing it", ok: r.verdict === "PASS", lines: r.lines });
      }
    } catch (err) { results.push({ name: "the re-check", ok: false, lines: [err.message] }); }
    const failed = results.filter((r) => !r.ok);
    if (fx) fx.recheck = results.map((r) => r.r || { cmd: r.name, code: r.ok ? 0 : 1, counts: null, tail: r.lines });
    a.text = [
      results.length ? `Re-checked after ${fx ? fx.name : "the fixer"}: ${results.length - failed.length} of ${results.length} pass.` : "There was nothing yAI could re-run.",
      ...results.map((r) => `- ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.counts ? ` (${r.counts.passed} passed, ${r.counts.failed} failed)` : ""}${r.ok ? "" : `: ${row1(r.lines.slice(-3).join(" "))}`}`),
    ];
    for (const l of a.text) a.log.push({ k: "text", line: l });
    a.verdict = !results.length ? "" : failed.length ? "FAIL" : "PASS";
    a.state = state.interrupted ? "stopped" : results.length ? "done" : "skipped";
    if (!results.length) a.step = "nothing to re-run";
    a.ended = Date.now();
    // still failing after the first fixer: a second round, then one more re-check
    if (failed.length && !state.interrupted && fixers.length < 2) {
      const first = fixers[0];
      all.push({ name: rnd(a) > 1 ? `fixer 2 · r${rnd(a)}` : "fixer 2", task: "fixes what yAI's re-check still found failing", files: [], role: "fixer", fixRound: 2, round: rnd(a), phase: base + 3.4, readOnly: false, hasVerdict: true, model: first && first.model, state: "waiting", step: "after the re-check", started: Date.now(), changed: new Set(), created: new Set(), text: [], cost: 0, asks: [] });
      all.push({ name: rnd(a) > 1 ? `re-check 2 · r${rnd(a)}` : "re-check 2", task: "yAI re-runs the tests and the page, and plays it, after the second fix", files: [], role: "recheck", round: rnd(a), phase: base + 3.6, readOnly: true, internal: true, hasVerdict: true, state: "waiting", step: "after fixer 2", started: Date.now(), changed: new Set(), created: new Set(), text: [], cost: 0, asks: [] });
      all.sort((x, y) => (x.phase || 1) - (y.phase || 1));
      say(a.name, `${failed.length} check${failed.length === 1 ? "" : "s"} still fail → fixer 2`, "bad", failed[0].lines.slice(-1)[0] || failed[0].name);
    } else { letGoKept(all, rnd(a)); finished(a, all); }
    d.wake();
  }

  // /crew: the main builder's helpers still at work
  const crewOpen = (lead, all) => all.filter((x) => x.helperOf === lead.name && rnd(x) === rnd(lead) && ["waiting", "starting", "working"].includes(x.state));
  function commissionHelper(lead, e, task, all) {
    const name = row1(e.name).slice(0, 30), open = crewOpen(lead, all), total = all.filter((x) => x.helperOf === lead.name).length;
    const earlier = all.find((x) => x.helperOf === lead.name && rnd(x) === rnd(lead) && x.kept && String(x.crewName || "").toLowerCase() === name.toLowerCase());
    if (earlier && reawaken(earlier, all, String(e.task || "").trim())) return;
    if (state.interrupted || open.length >= crewMax || total >= 16) {
      const why = state.interrupted ? "the team was stopped" : open.length >= crewMax ? `${crewMax} helpers are already working: do it yourself, or wait for one with crew_wait` : "16 helpers is the most for one build";
      lead.send({ type: "crew", name, report: `(not started: ${why})` });
      return;
    }
    const files = (Array.isArray(e.files) ? e.files : []).map((p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "")).filter((p) => p && !p.includes(".."));
    const h = { name: clip(`helper · ${name}`, 28), crewName: name, task: String(e.task || "").trim(), files, helperOf: lead.name, round: lead.round, phase: lead.phase, model: (e.model === "lite" && state.models.find((m) => m.id === "glm-4.7-flash")?.id) || crewHelperModel || lead.model, readOnly: false, hasVerdict: false, state: "waiting", step: "starting", started: Date.now(), changed: new Set(), created: new Set(), text: [], cost: 0, asks: [] };
    // on the board, under the main builder and its other helpers
    const after = Math.max(...all.map((x, i) => (x === lead || x.helperOf === lead.name ? i : -1)));
    all.splice(after + 1, 0, h);
    say(lead.name, `commissioned ${h.name} · ${modelShort(h.model) || "?"}`, "acc", clip(row1(h.task), 220));
    startAgent(h, task, all);
    d.wake();
  }
  // A finished helper woken for a follow-up: the same process and conversation, so it remembers its job and its files
  function reawaken(h, all, text) {
    const child = h.kept?.child;
    if (!child || child.exitCode !== null || child.killed) return false;
    h.kept = null;
    Object.assign(h, { state: "working", step: "a follow-up from the main builder", lastMove: Date.now(), ended: 0, text: [], error: "", flag: "", watchedAt: h.log.length });
    h.log.push({ k: "you", text: `(follow-up from the main builder) ${text}` });
    h.send({ type: "prompt", text: `The main builder has a follow-up for you:\n${text}\n\nYour earlier work is above. Do this, check it, and end with a short report as before.` });
    say(h.name, "woken for a follow-up", "acc", clip(row1(text), 200));
    d.wake();
    return true;
  }
  function reportToLead(h, all) {
    const lead = all.find((x) => x.crewLead && x.name === h.helperOf && rnd(x) === rnd(h));
    if (!lead?.send) return;
    const report = [`(${h.state}${h.error ? `: ${row1(h.error)}` : ""}; files changed: ${h.changed.size ? [...h.changed].join(", ") : "none"})`, (h.text.join("\n").trim() || "(no report)").slice(-3000)].join("\n");
    lead.send({ type: "crew", name: h.crewName, report });
    // the main builder was only waiting for them: it carries on, to fit their work in
    if (lead.awaitingCrew && !crewOpen(lead, all).length) {
      Object.assign(lead, { awaitingCrew: false, step: "fitting in its helpers' work", lastMove: Date.now() });
      lead.send({ type: "prompt", text: "All your helpers have finished; their reports are above. Fit their work in, check the whole thing with check_page, and end with your short report." });
    }
  }

  // The watcher's takeover: an agent that didn't listen is stopped, and its job goes to a fresh agent on the strongest
  // model, which keeps its name (helpers and the board still find it) and starts from a hand-over: what's done, what the
  // loop was, what to do instead. The stopped one is renamed "… (taken over)".
  // Ultra Flash (Yousef: the takeover shouldn't be Ultra)
  const TAKEOVER_MODEL = () => ["deepseek-v4.1-flash", "deepseek-v4-pro"].find((id) => state.models.some((m) => m.id === id)) || state.model;
  function takeover(a, all, task, why) {
    if (a.takenOver || a.state !== "working") return;
    if (a.isTakeover) {
      // one takeover per job: the second time, it's stopped and left for you (a third agent would likely loop too)
      a.takenOver = true; a.watchStopped = true; a.flag = `needs you: stuck again after a takeover (${clip(row1(why), 140)})`;
      a.log.push({ k: "you", text: `(the watcher stopped it; it needs you) ${why}` });
      say("watcher", `${a.name} is stuck again after a takeover · stopped · it needs you`, "bad", why);
      a.send?.({ type: "stop" });
      return d.wake();
    }
    a.takenOver = true; a.watchStopped = true; a.flag = "taken over by the watcher";
    const steps = a.log.filter((x) => ["step", "result", "diff", "note", "you"].includes(x.k)).slice(-25).map((x) => x.k === "step" ? `- ${x.verb} ${clip(String(x.arg || ""), 120)}` : x.k === "result" ? `    → ${clip(row1(x.text), 100)}` : x.k === "diff" ? `- changed ${x.path}` : `- (${clip(row1(x.text || ""), 140)})`);
    const next = {
      name: a.name, task: a.task, files: a.files, role: a.role, crewLead: a.crewLead, helperOf: a.helperOf, crewName: a.crewName, round: a.round, phase: a.phase,
      readOnly: a.readOnly, hasVerdict: a.hasVerdict, fixRound: a.fixRound, model: TAKEOVER_MODEL(), isTakeover: true, state: "starting", step: "taking over", started: Date.now(), // "starting", not "waiting": a waiting row is started by the stage too, so a takeover ran as two agents, one of them left behind (2026-10-23)
      changed: new Set(a.changed), created: new Set(a.created), text: [], cost: 0, asks: [],
      handover: [
        "You are taking over this job from an agent that got stuck, so yAI's watcher stopped it. Its work so far is in the files (it changed: " + (a.changed.size ? [...a.changed].join(", ") : "nothing yet") + ").",
        `Why it was stopped: ${why}`,
        "Its last steps were:", ...steps,
        "Don't repeat its loop. Read the current state of the files you need, decide what's actually wrong, say what you expect each change to do before you make it, and finish the job.",
      ].join("\n"),
    };
    a.name = clip(`${a.name} (taken over)`, 32);
    a.takeoverNext = next;
    all.splice(all.indexOf(a) + 1, 0, next);
    say("watcher", `took over from ${next.name} · a fresh agent on ${modelShort(next.model)}`, "warn", why);
    a.log.push({ k: "you", text: `(the watcher took over) ${why}` });
    a.send?.({ type: "stop" });
    // if it doesn't end on its own soon, the replacement starts anyway
    setTimeout(() => { if (a.takeoverNext) { const n = a.takeoverNext; a.takeoverNext = null; const old = a.child; a.child = null; try { old?.stdin.end(); old?.kill(); } catch {} Object.assign(a, { state: "stopped", ended: Date.now() }); startTakeover(n, all, task); } }, 20000);
    d.wake();
  }
  function startTakeover(n, all, task) {
    if (state.interrupted) { Object.assign(n, { state: "stopped", ended: Date.now() }); return d.wake(); }
    startAgent(n, task, all);
  }

  // A first fixer kept open for fixer 2 is closed when it isn't needed (the re-check passed, or the team ends).
  function letGoKept(all, round) {
    for (const x of all) if (x.kept && (round == null || rnd(x) === round)) { try { x.kept.child.stdin.end(); } catch {} x.kept = null; }
  }
  // Fixer 2 carries on in fixer 1's conversation: everything it read and changed is still there (and cached), so it gets
  // only what yAI's re-check still found failing. Its row keeps its own time, cost and steps.
  function continueFixer(prev, a, all) {
    const { child, send } = prev.kept;
    prev.kept = null;
    const sub = (u) => (u ? { new: -u.new, cached: -u.cached, out: -u.out, real: -(u.real || 0), steps: -(u.steps || 0) } : null);
    Object.assign(a, {
      state: "working", started: Date.now(), step: "carrying on from fixer 1", lastMove: Date.now(), changed: new Set(), created: new Set(), text: [], asks: [], flag: "", error: "",
      // the process's cost and tokens so far were fixer 1's
      cost: 0, costPrev: -((prev.cost || 0) - (prev.costPrev || 0)), usage: null, usagePrev: sub(prev.usage),
      eff: { read: 0, edit: 0, run: 0, check: 0, search: 0, other: 0, refused: 0 }, watchedAt: 0, watchNotes: 0, watchStopped: false, planSeen: 0,
      log: [{ k: "brief", text: `${a.task} (carrying on in fixer 1's conversation)` }], child, send,
    });
    child.retarget(a);
    const failing = all.filter((x) => x.role === "recheck" && rnd(x) === rnd(a) && x.state === "done" && BAD.test(x.verdict || "")).flatMap((x) => x.text);
    send({ type: "prompt", text: [
      "yAI re-checked your fixes itself (the tests, the page, and playing it), and these still fail:", ...failing, "",
      "Carry on from where you left off. You already know the project and what you changed: don't re-read files unless you need lines you haven't seen or they changed since. Fix exactly what still fails, re-run those checks to show they pass, and end with your report and the VERDICT line (FIXED or PARTLY) as before.",
    ].join("\n") });
    say(a.name, "carries on from fixer 1 · same conversation, nothing re-read", "acc");
    d.wake();
  }

  // The judge (2026-10-22): yAI plays the app in a real browser and a model that can see compares it with the request,
  // like a demanding player, so the next round knows what to improve ("the animals are plain boxes"). It runs at the end
  // of each round when there are rounds; the spec checker and the next round's lead read what it found.
  const JUDGE_SYSTEM = "You judge a screenshot of an app or game against what the user asked for, like a demanding player or user. " +
    "List what is missing, broken or unfinished compared with a polished version of what they asked for, most important first: at most 8 short lines, " +
    "each specific enough for a developer to act on (what, where, what it should be). Don't praise and don't list what is fine. " +
    "Then end with one line: VERDICT: GOOD if it already looks and plays like a finished version of the request, otherwise VERDICT: NEEDS WORK.";
  async function startJudge(a, task, all) {
    const fs = require("fs");
    Object.assign(a, { state: "working", step: "playing it and comparing it with the request", started: Date.now(), log: [{ k: "brief", text: a.task }] });
    d.wake();
    const entry = entryPage(all);
    const shot = path.join(root, "yai-media", `team-judge-r${rnd(a)}-${Date.now()}.jpg`);
    let r = { lines: ["There's no page to look at."], frozen: false };
    if (entry) {
      const describe = (img) => X.withVision((m) => X.oneShot({ model: m.id, signal: state.abort?.signal, system: JUDGE_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: `What the user asked for: ${task}` }, X.imagePart(img, "image/jpeg")] }] }), state.abort?.signal).then((x) => String(x?.text || "").trim());
      r = await require("./teamchecks").pageCheck({ entry: path.resolve(root, entry), keys: GAME.test(task) ? "KeyW:1200,Space,KeyD:500" : "", describe, saveTo: shot }).catch((err) => ({ lines: [`Couldn't open it: ${err.message}`], frozen: false }));
    }
    const said = r.lines.join("\n");
    const at = said.indexOf("On screen");
    // its findings: the lines of the description, without the verdict
    a.findings = at < 0 ? [] : said.slice(at).split("\n").slice(1).map((l) => tidy(l)).filter((l) => l && !/^VERDICT/i.test(l)).slice(0, 8);
    a.verdict = r.frozen ? "FAIL" : /VERDICT:\s*GOOD/i.test(said) ? "PASS" : /VERDICT:\s*NEEDS\s*WORK/i.test(said) ? "FAIL" : "";
    a.text = [
      r.frozen ? "The page froze." : a.findings.length ? `Round ${rnd(a)}, played and looked at:` : r.lines[0],
      ...a.findings.map((x) => `- ${x}`),
      ...r.lines.filter((l) => /^Errors in the browser|^Frame rate/.test(l)).map((l) => l.split("\n")[0]),
      ...(fs.existsSync(shot) ? [`(screenshot ${path.relative(root, shot).split(path.sep).join("/")})`] : []),
    ];
    for (const l of a.text) a.log.push({ k: "text", line: l });
    a.state = state.interrupted ? "stopped" : "done";
    a.ended = Date.now();
    finished(a, all);
    d.wake();
  }

  async function startSkeleton(a, task, all) {
    Object.assign(a, { state: "working", step: "opening the skeleton", started: Date.now(), log: [{ k: "brief", text: a.task }] });
    d.wake();
    const entry = entryPage(all);
    const r = entry && require("fs").existsSync(path.resolve(root, entry))
      ? await require("./teamchecks").pageCheck({ entry: path.resolve(root, entry), start: false, wait: 1500 }).catch((err) => ({ lines: [`Couldn't open it: ${err.message}`], frozen: false }))
      : { lines: ["The architect didn't write the page."], frozen: false };
    const errors = /Errors in the browser \(/.test(r.lines.join("\n"));
    a.verdict = r.frozen || errors ? "FAIL" : entry ? "PASS" : "";
    a.text = r.frozen || errors ? r.lines.filter((l) => /FROZEN|Errors in the browser|^- /.test(l)) : ["The skeleton loads and runs with no errors."];
    for (const l of a.text) a.log.push({ k: "text", line: l });
    a.state = state.interrupted ? "stopped" : a.verdict ? "done" : "skipped";
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
    else { try { r = await fn({ root, entry: path.resolve(root, entry), task, X, signal: state.abort?.signal }); } catch (err) { r = { verdict: /frozen|didn't answer/.test(err.message) ? "FAIL" : "", lines: [`Couldn't run it: ${err.message}`] }; } }
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
  const WIDE_ROLES = new Set(["merger", "integration", "reviewer", "fixer", "spec", "qa"]);
  function relayChat(a, all, text, to) {
    const m = { at: Date.now(), from: a.name, to: to || "", text };
    chatLog.push(m);
    const want = String(to || "").toLowerCase();
    const named = want ? all.filter((x) => x !== a && (x.name.toLowerCase() === want || x.role === want || x.name.toLowerCase().startsWith(want) || String(x.crewName || "").toLowerCase() === want)) : [];
    // the main builder writing to a helper that has finished: it wakes up to do what was asked
    const sleeping = a.crewLead ? named.filter((x) => x.helperOf === a.name && x.kept) : [];
    for (const x of sleeping) if (reawaken(x, all, text)) { a.log.push({ k: "chat", to: x.name, text, sent: true }); }
    if (sleeping.length && sleeping.every((x) => x.state === "working")) return;
    const targets = (want ? named : all.filter((x) => x !== a)).filter((x) => x.send && (x.state === "working" || x.state === "starting"));
    for (const x of targets) { x.send({ type: "chat", from: a.name, text, to: !!want }); x.log?.push({ k: "chat", from: a.name, text }); }
    a.log.push({ k: "chat", to: to || "the team", text, sent: true });
    const note = want && !targets.length ? (named.length ? " (it has finished)" : " (no agent by that name)") : "";
    say(a.name, `${want ? `→ ${to}` : "→ team"}${note}`, "acc", text);
  }
  function startAgent(a, task, all) {
    // a restart (network drop, stuck, or you) keeps what the earlier run spent and changed (2026-10-22 review: totals,
    // learned estimates and the summary lost them)
    a.costPrev = a.child !== undefined ? a.cost || 0 : 0; // a.cost already includes any earlier restarts
    a.state = "starting"; a.started = Date.now(); a.step = "starting"; a.changed = new Set(a.changed || []); a.created = new Set(a.created || []); a.text = []; a.cost = 0; a.asks = []; a.flag = "";
    a.watchedAt = 0; a.watchNotes = 0; a.watchStopped = false; a.planSeen = 0;
    // what it spent its time on (the efficiency report), kept across restarts
    if (a.child !== undefined) { a.restarts = (a.restarts || 0) + 1; a.usagePrev = addUsage(a.usagePrev, a.usage); a.usage = null; }
    a.eff = a.eff || { read: 0, edit: 0, run: 0, check: 0, search: 0, other: 0, refused: 0 };
    a.log = [{ k: "brief", text: a.task }];
    const log = (entry) => { a.log.push(entry); if (a.log.length > 3000) a.log.splice(1, 500); };
    const child = spawn(process.execPath, [path.join(__dirname, "index.js"), "--stdio"], {
      // agents that write get 100 steps (2026-10-22: the fixer ran out at 50 mid-fix); repeats are stopped long before
      cwd: root, env: { ...process.env, YAI_MCP_READONLY: "1", YAI_THEME: "dark", // no step limit: the watcher redirects or stops an agent that wanders (2026-10-22, Yousef)
      YAI_TEAM_AGENT: "1", YAI_COLUMNS: "1000", ...((a.role === "fixer" || a.crewLead) && api.cfg.thinking !== false && { YAI_THINK: "low" }), // the fixers think first (index.js thinkFor)
YAI_TRIM_TOKENS: WIDE_ROLES.has(a.role) || a.crewLead ? "80000" : "48000", ...(a.crewLead && { YAI_CREW_LEAD: "1" }), ...(!a.role && !a.crewLead && { YAI_OWN_FILES: JSON.stringify(a.files || []) }), ...(a.readOnly ? { YAI_REPORT_ONLY: "1" } : a.role && { YAI_SAFE_CHECKS: "1" }) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    a.child = child;
    a.send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch {} };
    // fixer 2 carries on in fixer 1's process: its events then belong to fixer 2's row (continueFixer)
    child.retarget = (x) => { a = x; };
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
        a.send({ type: "prompt", text: (a.handover ? a.handover + "\n\n---\n\n" : "") + (a.crewLead ? crewBrief(task, a, all) : a.helperOf ? helperBrief(task, a) : a.role === "fixer" ? fixerBrief(task, all, a) : a.role ? roleBrief(a, task, all) : brief(task, a, all)) });
      } else if (e.type === "busy") { a.state = "working"; a.step = "thinking"; a.lastMove = Date.now(); }
      else if (e.type === "status" && e.text) { a.step = String(e.text); a.lastMove = Date.now(); }
      // its plan, cost and tokens after each reply (the board's progress bar, cost and steps)
      // the agent took in your notes (after its step): they're marked read, in its view and the feed
      else if (e.type === "note-read") { for (const x of a.log) if (x.k === "you" && !x.read) x.read = true; say(a.name, "read your note", "acc"); }
      else if (e.type === "progress") { if (e.usage) a.usage = e.usage; a.plan = e.plan ? { ...e.plan, done: Math.max(e.plan.done || 0, a.planSeen || 0) } : a.plan; a.cost = e.cost != null ? (a.costPrev || 0) + e.cost : a.cost; a.tokens = e.tokens || a.tokens; a.fallbacks = e.fallbacks || 0; a.lastMove = Date.now(); }
      else if (e.type === "chat" && String(e.text || "").trim()) relayChat(a, all, String(e.text), String(e.to || ""));
      else if (e.type === "commission" && a.crewLead) commissionHelper(a, e, task, all);
      // the same reasoning written again and again: a loop like any other
      else if (e.type === "directive-ignored" || e.type === "directive-defied") {
        a.defied = (a.defied || 0) + 1;
        log({ k: "note", text: e.type === "directive-defied" ? `tried a step the watcher blocked (${e.what})` : "didn't acknowledge the watcher's instruction" });
        say(a.name, e.type === "directive-defied" ? `ignored the watcher · tried ${e.what}` : "didn't acknowledge the watcher", "warn");
        if (a.defied >= 2 && !a.takenOver && !state.interrupted) takeover(a, all, task, `It ignored the watcher's instructions (${a.defied} times): ${e.type === "directive-defied" ? `it tried a blocked step (${e.what})` : "it didn't acknowledge them"}.`);
      }
      else if (e.type === "repeat-text") {
        a.textLoops = Number(e.count) || (a.textLoops || 0) + 1;
        log({ k: "note", text: `wrote the same reasoning again (${a.textLoops}×)` });
        if (a.textLoops === 2 && !state.interrupted) {
          const msg = "You're repeating the same reasoning without acting. Stop analysing: measure one fact with page_eval, or ask check_page a specific question with look_for, or make one change and check it.";
          a.watchNotes = (a.watchNotes || 0) + 1; a.watchTotal = (a.watchTotal || 0) + 1;
          a.send?.({ type: "directive", text: msg, block: [], steps: 6 });
          a.log.push({ k: "you", text: `(the watcher) ${msg}` });
          say("watcher", `→ ${a.name}`, "acc", msg);
        } else if (a.textLoops >= 4 && a.watchNotes && !a.takenOver && !state.interrupted) takeover(a, all, task, `It kept writing the same reasoning (${a.textLoops} times) without getting new evidence or changing anything.`);
      }
      else if (e.type === "flip") {
        a.flips = (a.flips || 0) + 1;
        log({ k: "note", text: `went back to an earlier version of ${e.path} (${e.count}×)` });
        say(a.name, `flip-flopping on ${e.path} (${e.count}×)`, "warn");
        // four flip-flops after a note from the watcher: it's not listening, so the job is handed over now
        if (a.flips >= 4 && a.watchNotes && !a.takenOver && !state.interrupted) takeover(a, all, task, `It kept changing ${e.path} back and forth (${a.flips} times) after being told to stop.`);
      }
      else if (e.type === "step") { const k = effKind(e.verb); if (a.eff) a.eff[k]++; a.step = `${e.verb} ${e.arg}`.trim(); a.lastMove = Date.now(); a.stuckSaid = false; log({ k: "step", verb: e.verb, arg: e.arg }); }
      else if (e.type === "step-result") log({ k: "result", text: e.summary || e.text || "", tone: e.tone });
      else if (e.type === "diff" && e.path) { a.lastMove = Date.now(); a.changed.add(e.path); if (e.created) a.created.add(e.path); log({ k: "diff", ...e }); }
      else if (e.type === "text-start") { a.text = []; log({ k: "gap" }); }
      else if (e.type === "text") { a.text.push(e.line); a.lastMove = Date.now(); log({ k: "text", line: e.line }); }
      else if (e.type === "note" && e.text) {
        log({ k: "note", text: e.text });
        if (a.eff && /not run|not read again|asked for the lines it needs/.test(e.text)) a.eff.refused++;
        if (/kept repeating steps|kept checking without changing/.test(e.text)) a.flag = "stuck · stopped";
        else if (/^paused after \d+ steps/.test(e.text)) a.flag = "hit the step limit";
      }
      else if (e.type === "out" && String(e.text).trim()) for (const l of (a.lastMove = Date.now(),  String(e.text).replace(/\n$/, "").split("\n"))) log({ k: "out", line: l });
      else if (e.type === "ask") { a.asks.push(e); log({ k: "ask", text: e.title, detail: e.detail }); d.wake(); }
      else if (e.type === "error") { a.error = e.message; log({ k: "error", text: e.message }); if (a.state !== "working") a.state = "failed"; }
      else if (e.type === "done" && a.state === "working") {
        a.cost = (a.costPrev || 0) + (e.cost?.session || 0);
        a.fallbacks = e.fallbacks || 0;
        // it ended without a step, a word or an edit: it never got to work (the model refused, the allowance ran out…)
        if (!a.error && !a.text.length && !a.changed.size && !a.log.some((x) => x.k === "step")) {
          const why = [...a.log].reverse().find((x) => x.k === "error" || x.k === "note" || x.k === "out");
          a.error = row1(why?.text || why?.line || "it stopped before doing anything (no answer from the model)");
        }
        if (/today'?s \$|allowance|resets at midnight|daily limit/i.test(a.error || "") && !state.interrupted) {
          say("yAI", "today's yAI allowance ran out, so the team stopped", "bad", a.error);
          state.teamStopReason = a.error;
          state.interrupted = true; // as Esc does: no later phase, round or re-run starts
          setTimeout(() => state.abort?.abort(), 0);
        }
        // the connection to yAI dropped (after the client's own retries): start it again, twice at most
        if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|other side closed|^terminated$|Bad Gateway|Service Unavailable|Gateway Time|HTTP 50[234]/i.test(a.error || "") && !state.interrupted && (a.netRetries || 0) < 2) {
          a.netRetries = (a.netRetries || 0) + 1;
          say(a.name, `lost the connection · restarting it (${a.netRetries} of 2)`, "warn", a.error);
          a.child = null; a.error = ""; a.plan = null;
          try { child.stdin.end(); } catch {}
          setTimeout(() => {
            if (a.child || a.state !== "working") return; // skipped or restarted from the board meanwhile
            if (state.interrupted) { Object.assign(a, { state: "stopped", ended: Date.now() }); return d.wake(); }
            startAgent(a, task, all);
          }, 5000 * a.netRetries);
          return;
        }
        if (a.crewLead && !a.error && !state.interrupted && !a.watchStopped && crewOpen(a, all).length) {
          Object.assign(a, { awaitingCrew: true, step: `waiting for ${crewOpen(a, all).length} helper${crewOpen(a, all).length === 1 ? "" : "s"}` });
          say(a.name, "finished its part · waiting for its helpers", "acc");
          return d.wake();
        }
        a.state = state.interrupted || a.watchStopped ? "stopped" : a.error ? "failed" : "done";
        a.verdict = verdictOf(a.text.join("\n"));
        if (a.takeoverNext) { const n = a.takeoverNext; a.takeoverNext = null; setTimeout(() => startTakeover(n, all, task), 0); }
        a.ended = Date.now();
        // the first fixer stays open, idle, until yAI's re-check: if it still fails, fixer 2 carries on in this same
        // conversation instead of starting over (2026-10-22, Yousef: "fixer 2 should pick up right where fixer 1 ended")
        if (a.role === "fixer" && !a.fixRound && a.state === "done") a.kept = { child, send: a.send };
        // a /crew helper stays open too: the main builder may come back with a follow-up (reawaken)
        else if (a.helperOf && a.state === "done" && !state.interrupted) a.kept = { child, send: a.send };
        else child.stdin.end();
        finished(a, all);
        if (a.helperOf) reportToLead(a, all);
        if (a.crewLead && a.state !== "working") for (const x of all) if (x.helperOf === a.name && rnd(x) === rnd(a) && x.kept) { try { x.kept.child.stdin.end(); } catch {} x.kept = null; }
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
    if (a.role === "spec" && scoreOf(a)) roundScores[rnd(a)] = scoreOf(a);
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
  // the efficiency report's helpers: a step's kind, and token counts added up
  const effKind = (verb) => /^read/i.test(verb) ? "read" : /^(edit|write|update|create|append)/i.test(verb) ? "edit" : /^run/i.test(verb) ? "run" : /check page/i.test(verb) ? "check" : /^(search|find|list|grep|glob)/i.test(verb) ? "search" : "other";
  const addUsage = (x, y) => (!x ? (y ? { ...y } : null) : !y ? x : { new: x.new + y.new, cached: x.cached + y.cached, out: x.out + y.out, real: (x.real || 0) + (y.real || 0), steps: (x.steps || 0) + (y.steps || 0) });
  const usageOf = (a) => addUsage(a.usagePrev, a.usage);
  // one agent's line in the efficiency report, and what looks wasteful about it
  const effOf = (a) => {
    const e = a.eff || {}, u = usageOf(a), mins = ((a.ended || Date.now()) - (a.started || Date.now())) / 60000;
    const steps = (e.read || 0) + (e.edit || 0) + (e.run || 0) + (e.check || 0) + (e.search || 0) + (e.other || 0);
    const warn = [];
    if ((e.check || 0) >= 8) warn.push(`${e.check} page checks`);
    if ((e.refused || 0) >= 5) warn.push(`${e.refused} repeats refused`);
    if (!a.readOnly && !a.internal && a.role !== "spec" && mins > 3 && !(a.changed?.size)) warn.push("changed no file");
    if ((a.restarts || 0) > 0) warn.push(`restarted ${a.restarts}×`);
    if ((a.watchTotal || 0) >= 3) warn.push(`${a.watchTotal} watcher notes`);
    if (u && u.new + u.cached > 50000 && u.cached / (u.new + u.cached) < 0.5) warn.push("cache mostly missed");
    return { steps, mins, u, warn, e };
  };
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
      // the team chat: what it said, and what the others told it
      else if (e.k === "chat") { blank(); out.push(e.sent ? ` ${c.accent("◇")} ${c.dim(`to ${e.to}:`)} ${c.ink(clip(row1(e.text), w - 20))}` : ` ${c.accent("◆")} ${c.bold(c.ink(e.from))} ${c.ink(clip(row1(e.text), w - 20))}`); blank(); }
      // a note you sent it: waiting until its current step ends, then read
      else if (e.k === "you") { blank(); out.push(` ${c.accent("›")} ${c.bold(c.ink("you"))} ${c.ink(clip(row1(e.text), w - 40))}  ${e.read ? c.green("✓ read") : c.faint("· it reads this after its current step")}`); blank(); }
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
    // with the team's own suite, that (and npm test) is the whole check: replaying commands the agents typed re-ran
    // "node --test tests/", which this Node can't run on a folder, and a false failure sent a second fixer round after
    // nothing (2026-10-22)
    if (own) return [own, ...cmds.filter((x) => x === "npm test")];
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
  const stageOf = (a) => STAGES.find((s) => s.has(lp(a.phase)))?.name || "BUILD";
  // the live feed (newest first): hand-offs, problems found, agents finishing or stuck, your notes
  let feed = [], teamStarted = 0, teamNotes = [];
  let teamDirection = []; // your answers to the architect's questions, for every agent's brief (see askDirection)
  // rounds (2026-10-22): how many were asked for, each round's spec score, and whether the next is being planned
  let plannedRounds = 1, roundScores = {}, planningRound = false, planFolder = "", costCap = Infinity;
  // between rounds: { round, until, go } while the board waits for you to play it and say what to change
  let feedbackWait = null;
  // /crew: one main builder that commissions helpers (crewMax at once), and the model the helpers use
  let crewMode = false, crewMax = 4, crewHelperModel = "";
  // the team chat (2026-10-22): agents tell each other what affects them; { at, from, to, text }
  let chatLog = [];
  const say = (who, what, tone = "", quote = "") => {
    if (feed[0] && feed[0].who === who && feed[0].what === what && feed[0].quote === tidy(quote) && Date.now() - feed[0].at < 5000) return; // said just now
    feed.unshift({ at: Date.now(), who, what, tone, quote: tidy(quote) });
    if (feed.length > 80) feed.pop();
  };
  const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const STUCK_MS = 120000; // no step for two minutes
  // yAI's own rows (re-check, judge, the planner…) have their own time limits and no restart: never "stuck"
  const stuck = (a) => a.state === "working" && !a.internal && !a.paused && !a.awaitingCrew && Date.now() - (a.lastMove || a.started) > STUCK_MS;
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
  // the spec checker's "SCORE: 24/27" (requirements done / asked for)
  const scoreOf = (a) => { const m = [...(a.text || []).join("\n").matchAll(/SCORE:?\**\s*(\d+)\s*\/\s*(\d+)/gi)].pop(); return m ? [Number(m[1]), Number(m[2])] : null; };
  // what a finished agent did, in one line
  function summaryOf(a) {
    const said = (a.text || []).filter((l) => l.trim() && !/^\W*VERDICT/i.test(l)).map(tidy);
    // (without the screenshot's file path, which says nothing on the board or in the report)
    if (a.role === "judge") return `${a.verdict === "PASS" ? "Looks finished" : a.verdict ? "Needs work" : "Looked at it"}${a.findings?.length ? ` · ${a.findings[0]}` : ""}`;
    if (a.role === "planner") return a.summary || "Planned the next round";
    if (a.internal) return `${a.verdict ? (BAD.test(a.verdict) ? "Fail" : "Pass") + " · " : ""}${(said[0] || a.step || "").replace(/[;,]?\s*\(?screenshot:?\s+\S+\.(?:jpe?g|png)\)?/gi, "").trim()}`;
    if (a.role === "fixer") return `${a.verdict === "FIXED" ? "Fixed" : a.verdict === "PARTLY" ? "Partly fixed" : "Finished"}${a.changed.size ? ` · ${shortFiles([...a.changed])}` : ""}`;
    if (a.role === "spec" && scoreOf(a)) { const [done, of] = scoreOf(a); return `${done} of ${of} requirements done`; }
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
    // with rounds, each round's stages get their own groups ("R2 BUILD"), and the bar shows the rounds
    const rounds = [...new Set(agents.map(rnd))].sort((x, y) => x - y);
    for (const R of rounds) for (const S of STAGES) {
      const rows = agents.filter((a) => rnd(a) === R && S.has(lp(a.phase)));
      if (!rows.length) continue;
      const w = rows.filter((a) => a.state === "working" || a.state === "starting").length;
      const bad = rows.filter((a) => a.state === "done" && BAD.test(a.verdict || "") && a.role !== "fixer").length;
      const all = rows.every((a) => ENDED.includes(a.state));
      const span = all ? Math.max(...rows.map((a) => a.ended || 0)) - Math.min(...rows.map((a) => a.started || Date.now())) : 0;
      const note = all ? (rows.every((a) => a.state === "skipped") ? "not needed" : rows.every((a) => a.state === "stopped" || a.state === "skipped") ? "stopped" : `done in ${secs(span)}${S.name === "BUILD" && rows.length > 1 ? ` · ${rows.length} at the same time` : ""}`)
        : [w && `${w} working`, bad && `${bad} found problems`, !w && rows.every((a) => a.state === "waiting") && (S.name === "FIX" ? "only if needed" : "waiting")].filter(Boolean).join(" · ");
      stages.push({ name: R > 1 ? `R${R} ${S.name}` : S.name, round: R, note, current: w > 0, all, total: rows.length, done: rows.filter((a) => ENDED.includes(a.state)).length, working: w,
        rows: rows.map((a) => ({ n: agents.indexOf(a) + 1, st: stOf(a), name: a.name, act: actOf(a, agents), pct: pctOf(a),
          time: a.state === "waiting" || !ran(a) ? "" : secs((a.ended || Date.now()) - a.started),
          cost: !ran(a) ? "" : a.internal ? "free" : a.cost ? money(a.cost) : ENDED.includes(a.state) && a.state !== "skipped" ? "free" : "" })) });
    }
    const byRound = rounds.length > 1 || plannedRounds > 1;
    const strip = byRound
      ? [...Array.from({ length: Math.max(plannedRounds, rounds.length) }, (_, i) => {
          const rows = agents.filter((a) => rnd(a) === i + 1), w = rows.filter((a) => a.state === "working" || a.state === "starting").length;
          const sc = roundScores[i + 1];
          return { label: `Round ${i + 1}${sc ? ` · ${sc[0]}/${sc[1]}` : w ? ` · ${w} working` : ""}`, total: Math.max(1, rows.length), done: rows.filter((a) => ENDED.includes(a.state)).length, working: w, current: w > 0, past: rows.length > 0 && rows.every((a) => ENDED.includes(a.state)) };
        }), { label: "Done", total: 0, done: 0, past: doneN === agents.length && !planningRound }]
      : [...stages.map((g) => ({ label: `${cap(g.name.toLowerCase())}${g.current ? ` · ${g.working} working` : ""}`, total: g.total, done: g.done, working: g.working, current: g.current, past: g.all })),
        { label: "Done", total: 0, done: 0, past: doneN === agents.length }];
    return {
      // (cut to fit the board, which is at least 70 wide: a 60-character task and " · 5 agents" made 72)
      title: `${c.bold(c.ink(clip(task, Math.min(60, Math.max(70, screenW()) - 16))))}${c.faint(` · ${agents.length} agents`)}`,
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
        steps: (a.plan?.steps || []).map((l, i) => ({ l, st: i < a.plan.done || a.state === "done" ? "done" : i === a.plan.done && a.state === "working" ? "work" : "next" })),
        touch, waiting: later,
      },
      body: logLines(a, agents, tick).slice(3), width: screenW(), height: screenH(), tick,
    };
  }
  // The board and an agent's view as plain data, for the VS Code panel (yai --stdio), which draws them itself
  // (2026-10-22: in VS Code /team had no picker and showed its progress as lines of text).
  function plainBoard(agents, task, estimate, open, over) {
    const v = runView(agents, task, 0, -1, estimate);
    const cost = agents.reduce((s, a) => s + (a.cost || 0), 0);
    const a = open ? agentView(open, agents, 0) : null;
    return {
      task, total: agents.length, done: agents.filter((x) => ENDED.includes(x.state)).length, working: agents.filter((x) => x.state === "working" || x.state === "starting").length,
      elapsed: secs(Date.now() - teamStarted), cost: money(cost) || "$0.000", estimate: estimate ? money(estimate) : "", over: !!over,
      waiting: feedbackWait ? { round: feedbackWait.round, seconds: Math.max(0, Math.ceil((feedbackWait.until - Date.now()) / 1000)) } : null,
      strip: v.strip, feed: v.feed,
      stages: v.stages.map((g) => ({ name: g.name, note: g.note, current: g.current, rows: g.rows.map((r) => ({ ...r, model: agents[r.n - 1].internal ? "built-in" : modelShort(agents[r.n - 1].model), canRetry: canRetry(agents[r.n - 1]), canSkip: canSkip(agents[r.n - 1]), paused: !!agents[r.n - 1].paused })) })),
      agent: a && { n: a.side.n, name: a.side.name, where: a.side.where, desc: a.side.desc, stats: a.side.stats, steps: a.side.steps, touch: a.side.touch, waiting: a.side.waiting,
        state: open.state, paused: !!open.paused, canRetry: canRetry(open), canSkip: canSkip(open),
        log: (open.log || []).slice(-160).map((e) => (e.k === "diff" ? { ...e, lines: (e.lines || []).slice(0, 40) } : e)) },
    };
  }
  const canRetry = (a) => !!a && !a.internal && (stuck(a) || a.state === "failed" || a.state === "stopped");
  const canSkip = (a) => !!a && (a.state === "waiting" || stuck(a) || !!a.paused);

  // The board as it ran, for the report's replay (2026-10-22): a frame a second at most, only when it changed, at a
  // fixed 140 columns; each line is stored once in a dictionary and frames list indexes into it, so a long run stays
  // small (the static rows repeat in almost every frame).
  let recording = null;
  function recordFrame(agents, task, estimate, tick) {
    if (!recording || Date.now() - recording.last < 1000) return;
    recording.last = Date.now();
    // always in the dark theme, which the report's page is (a light terminal's near-black text vanished there)
    const keep = ui.themeKey;
    if (keep !== "dark") ui.setTheme("dark", { paint: false });
    let lines;
    try { lines = V.runLines({ ...runView(agents, task, tick, -1, estimate), width: 140, height: 40 }); } finally { if (keep !== "dark") ui.setTheme(keep, { paint: false }); }
    const ids = lines.map((l) => { let k = recording.index.get(l); if (k === undefined) { k = recording.dict.push(l) - 1; recording.index.set(l, k); } return k; });
    const key = ids.join(",");
    if (key !== recording.lastKey) { recording.lastKey = key; recording.frames.push({ t: Date.now() - recording.start, f: ids }); }
  }
  // TEAM_REPORT.html (cli/teamreport.js), next to the team's contract: the run as a page to open or publish
  function writeReport(agents, task, estimate) {
    const fs = require("fs");
    const dir = contractFile ? path.dirname(contractFile) : root;
    const changed = [...new Set(agents.flatMap((a) => [...(a.changed || [])]))].filter((p) => !/TEAM_CONTRACT|TEAM_REPORT/i.test(p) && fs.existsSync(path.join(root, p))).sort();
    const files = changed.map((p) => ({ path: path.relative(dir, path.join(root, p)).split(path.sep).join("/"), lines: linesIn([p]) }));
    const spec = agents.filter((a) => a.role === "spec" && a.state === "done").pop(); // the last round's
    // the spec checker's list: a line per requirement, with DONE, PARTLY or MISSING in it
    const requirements = [];
    for (const l of spec ? spec.text : []) {
      // only the list's items (a bullet, a number or a table row), not its summary lines ("All 27 requirements are DONE")
      const m = /\b(DONE|PARTLY|MISSING)\b/.exec(l);
      if (!m || !/^\s*([-*•]|\d+[.)]|\|)/.test(l) || /^\W*(VERDICT|SCORE)/i.test(l) || /^\s*\|?\s*:?-{2,}/.test(l)) continue;
      const item = tidy(l.replace(/\*\*|`/g, "").replace(/\|/g, " — ").replace(/\b(DONE|PARTLY|MISSING)\b/, "").replace(/^\s*(\d+[.)]|[-*•])\s*/, ""))
        .replace(/(\s*[—–:-]\s*){2,}/g, " — ").replace(/^[\s:—–-]+|[\s:—–-]+$/g, "").replace(/\s{2,}/g, " ");
      if (item) requirements.push({ item, state: m[1] });
    }
    const fixer = agents.filter((a) => a.role === "fixer" && a.recheck).pop();
    const recheck = (fixer?.recheck || []).map((r) => ({ name: r.cmd, ok: r.code === 0, detail: r.counts ? `${r.counts.passed} passed, ${r.counts.failed} failed` : r.code === 0 ? "" : row1((r.tail || []).slice(-1)[0] || "") }));
    // the screenshots yAI's own checks took (the playtester's, the phone sizes)
    const shots = [];
    for (const a of agents.filter((x) => x.internal)) for (const l of a.text || []) for (const m of String(l).matchAll(/\(screenshot ([^)]+\.(?:jpe?g|png))\)/g)) {
      const abs = path.join(root, m[1]);
      // embedded, so the page is one file that still works once published (and after yai-media is cleared)
      if (fs.existsSync(abs) && shots.length < 12) shots.push({ src: `data:image/${/png$/i.test(abs) ? "png" : "jpeg"};base64,${fs.readFileSync(abs).toString("base64")}`, label: a.role === "judge" ? `Round ${rnd(a)}: ${a.findings?.[0] ? `the judge saw: ${a.findings[0]}` : "how it looked"}` : `${a.name}: ${a.role === "playtester" ? "playing it" : a.role === "mobile" ? "at phone, tablet and laptop sizes" : "what it looked like"}` });
    }
    const cost = agents.reduce((x, a) => x + (a.cost || 0), 0), tokens = agents.reduce((x, a) => x + (a.tokens || 0), 0);
    const score = spec ? scoreOf(spec) : null;
    const html = require("./teamreport").build({
      task, date: new Date().toLocaleString("en-CA", { dateStyle: "long", timeStyle: "short" }), folder: path.relative(root, dir).split(path.sep).join("/"),
      stats: [[String(agents.filter((a) => a.state !== "skipped").length), "agents worked"], [secs(Date.now() - teamStarted), "start to finish"], [money(cost) || "$0.000", "cost in all"], [tokensOf(tokens), "tokens"], [String(files.length), "files built"], [String(files.reduce((x, f) => x + f.lines, 0)), "lines of code"], ...(score ? [[`${score[0]}/${score[1]}`, "requirements done"]] : []), ...(Object.keys(roundScores).length > 1 ? [[Object.keys(roundScores).sort().map((k) => `${roundScores[k][0]}/${roundScores[k][1]}`).join(" → "), "score, round by round"]] : [])],
      score, requirements, recheck,
      agents: agents.map((a) => ({ n: agents.indexOf(a) + 1, name: a.name, stage: cap(stageOf(a).toLowerCase()), model: a.internal ? "built-in" : modelShort(a.model) || "", time: a.state === "waiting" || !ran(a) ? "" : secs((a.ended || Date.now()) - a.started), cost: !ran(a) ? "" : a.internal ? "free" : a.cost ? money(a.cost) : "free", st: stOf(a), summary: actOf(a, agents) })),
      feed: feed.map((x) => ({ t: clock(x.at - teamStarted), who: x.who, tone: x.tone, what: x.what, quote: x.quote })),
      efficiency: agents.filter((a) => !a.internal && ran(a) && a.eff).map((a) => {
        const f = effOf(a);
        return { name: a.name, time: secs(f.mins * 60000), cost: money(a.cost) || "", steps: f.steps, read: f.e.read, edit: f.e.edit, run: f.e.run, check: f.e.check, refused: f.e.refused, notes: a.watchTotal || 0, restarts: a.restarts || 0,
          tokens: f.u ? tokensOf(f.u.new + f.u.cached + f.u.out) : "", cached: f.u && f.u.new + f.u.cached ? `${Math.round((100 * f.u.cached) / (f.u.new + f.u.cached))}%` : "", warn: f.warn.join(" · ") };
      }),
      shots: shots.slice(0, 12), files, recording: recording && { cols: 140, dict: recording.dict, frames: recording.frames },
    });
    const file = path.join(dir, "TEAM_REPORT.html");
    fs.writeFileSync(file, html);
    return path.relative(root, file).split(path.sep).join("/");
  }

  // what the user said while the team worked, for the agents that start later
  const notesLines = () => [
    ...(teamDirection.length ? ["", "The user's answers to the architect's questions about the direction, before the design (follow them; where they differ from the research, they win):", ...teamDirection.map((n) => `- ${n}`)] : []),
    ...(teamNotes.length ? ["", "Notes from the user while the team worked (follow them):", ...teamNotes.map((n) => `- ${n}`)] : []),
  ];
  // The architect's questions (2026-10-23, Yousef: "as a part of architects role, ask the user 10-15 questions abt the
  // direction of their request based on the research"): written from the task and TEAM_SPEC.md, asked one by one with
  // answer choices before the architect designs anything.
  const DIRECTION_SYSTEM = [
    "You are the architect of a team of AI agents about to build what the user asked for. Before you design anything, you ask the user 10 to 15 questions about the direction of the request, so the team builds what they actually want.",
    "Ask where the request leaves real room: scope and must-have features, style and look, feel and difficulty, platform and controls, content and amount, what matters most, what to leave out. Base the questions on the research: the choices, trade-offs and options it found.",
    "Don't ask what the request already answers, or technical choices the team should make itself (files, libraries, code structure) unless they change what the user gets.",
    "Each question is short (at most 15 words), with 2 to 4 concrete answers (at most 8 words each), the likeliest first; \"why\" is optional, at most 15 words, plain words a non-programmer understands.",
    "Reply with JSON only: {\"questions\":[{\"q\":\"…\",\"why\":\"…\",\"options\":[\"…\",\"…\"]}]}",
  ].join("\n");

  let lastTeam = null; // the last team's agents, for /team log
  function showLog(arg) {
    if (!lastTeam) return print(c.yellow("   No team has run yet in this session."));
    const q = arg.trim().toLowerCase();
    const a = /^\d+$/.test(q) ? lastTeam[Number(q) - 1] : lastTeam.find((x) => x.name.toLowerCase() === q) || lastTeam.find((x) => x.name.toLowerCase().includes(q));
    if (!a) return print(c.yellow(`   Which agent? ${lastTeam.map((x, i) => `${i + 1} ${x.name}`).join(" · ")}`));
    print("");
    for (const l of logLines(a, lastTeam).filter((l, i) => i !== 1)) print(l);
  }

  async function team(arg, opts = {}) {
    teamStarted = 0; // set when the run starts; until then entryPage only trusts planned pages
    if (/^log\b/i.test(arg.trim())) return showLog(arg.trim().slice(3));
    crewMode = !!opts.crew;
    if (crewMode) { const c2 = /^([1-8])\s+([\s\S]+)$/.exec(arg.trim()); crewMax = c2 ? Number(c2[1]) : 4; if (c2) arg = c2[2]; }
    let max = MAX_AGENTS;
    const m = /^([2-8])\s+([\s\S]+)$/.exec(arg.trim());
    if (m) { max = Number(m[1]); arg = m[2]; }
    else if (/\b(as many agents|lots of agents|max(imum)? (number of )?agents|many agents|more agents)\b/i.test(arg)) max = MAX_ASKED;
    const task = arg.trim();
    if (!task && crewMode) return print(c.yellow("   Usage: /crew <task>   (or /crew 6 <task> to let up to 6 helpers work at once). One main builder builds it and hands separate jobs to helpers; the checks run after it."));
    if (!task) return print(c.yellow("   Usage: /team <task>   (or /team 6 <task> for up to 6 builders, at most 8). A lead splits it, the agents work at the same time."));
    if (state.mode === "plan" || state.tutor) return print(c.yellow("   /team changes files; leave plan or tutor mode first (⇧⇥ or /tutor)."));
    // started in the home folder: the team's files (and yai-media) would land there among everything else
    if (path.resolve(root) === path.resolve(require("os").homedir()) && process.stdout.isTTY) {
      const i = await d.select({ title: "yAI Code is running in your home folder, so the team's files would go there.", detail: "Better: quit, make a folder for the project, and start yai inside it:\n  mkdir my-game && cd my-game && yai", options: ["Cancel", "Build here anyway"] });
      if (i !== 1) return print(c.dim("   Cancelled. Start yai in a project folder and run /team there."));
    }

    // 1. The lead splits the work.
    // The lead decides everything after it, so it's yAI Ultra (DeepSeek V4 Pro), else Ultra Flash: both on DeepSeek's
    // own API. (2026-10-22: Lite wrote the plan as broken JSON; the partner model, Q3.8 Max on Modal, failed on a Modal
    // billing limit and a run hung for 25 minutes.) If the first choice fails, the next one is tried.
    const has = (id) => state.models.some((m) => m.id === id);
    const leads = [...new Set(["deepseek-v4-pro", "deepseek-v4.1-flash"].filter(has).concat(state.model))];
    let lead = leads[0];
    let agents;
    if (crewMode) { agents = [{ name: "main builder", task, files: [], crewLead: true }]; contract = ""; planFolder = ""; }
    else try {
      const ask = async (messages) => {
        for (let i = 0; ; i++) {
          try { return await X.busy("splitting the work", (signal) => X.oneShot({ model: lead, system: LEAD_SYSTEM, think: "high", signal, messages })); }
          catch (err) { if (state.interrupted || i + 1 >= leads.length) throw err; lead = leads[i + 1]; }
        }
      };
      const first = [{ role: "user", content: `Project files:\n${projectFiles()}\n\nTask: ${task}\n\nUse at most ${max} agents${max > MAX_AGENTS ? " (the user asked for many: use as many as the work splits into cleanly)" : ""}.` }];
      let text = await ask(first);
      // a plan that still can't be read: the lead is asked once more, with the exact error
      try { agents = parsePlan(text, max); }
      catch (err) {
        if (state.interrupted) throw err;
        text = await ask([...first, { role: "assistant", content: String(text) }, { role: "user", content: `That plan couldn't be read (${err.message}). Reply with only the JSON object, valid JSON with double-quoted names, nothing before or after it.` }]);
        agents = parsePlan(text, max);
      }
      try { contract = String(planJson(text).contract || "").trim().slice(0, 6000); } catch { contract = ""; }
      let folder = "";
      try { folder = String(planJson(text).folder || "").replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, ""); } catch {}
      if (folder && !folder.includes("..")) for (const a of agents) a.files = a.files.map((f) => (f.startsWith(folder + "/") ? f : `${folder}/${f}`));
      planFolder = folder && !folder.includes("..") ? folder : "";
    } catch (err) {
      return print(c.red(`   ${state.interrupted ? "Stopped." : err.message}`));
    }
    let left = null;
    try { const u = (await api.hub("usage"))?.today?.ultra; if (u && u.limitUsd != null) left = Math.max(0, u.limitUsd - (u.spentUsd || 0)); } catch {}
    state.teamStopReason = "";
    // 2. You pick the team: the lead's builders, the checkers after them, and the fixer. The picks are remembered.
    const saved = { ...(api.cfg.team?.roles || {}) };
    // picks saved before QA existed: the three checks it replaces follow the new defaults once (2026-10-22)
    if (!("qa" in saved)) { delete saved.integration; delete saved.tester; delete saved.reviewer; }
    const roles = ROLES.filter((r) => !(crewMode && ["merger", "architect", "integration"].includes(r.key))).map((r) => ({ ...r, on: r.key in saved ? !!saved[r.key] : typeof r.on === "function" ? r.on(task, agents.length) : r.on }));
    print("");
    if (crewMode) ui.note(`${c.accent("◆")} ${c.ink("One main builder builds it and hands separate jobs to helpers as it goes")} ${c.dim("· pick who checks it after")}`);
    else ui.note(`${c.accent("◆")} ${c.ink(agents.length === 1 ? "The lead kept it as one part" : `The lead split it into ${agents.length} parts`)} ${c.dim(`· with ${d.modelLabel()}; pick who joins them`)}`);
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
    const SUGGESTED = { main: TOP, helpers: MID, qa: MID, researcher: MID, architect: TOP, builders: CHEAP, designer: CHEAP, docs: CHEAP, api: CHEAP, setup: CHEAP, merger: MID, integration: MID, tester: MID, reviewer: MID, security: MID, fixer: MID, spec: MID };
    const savedModels = api.cfg.team?.suggestedV === 1 ? api.cfg.team?.models || {} : {};
    const modelFor = (key) => [savedModels[key], ...(SUGGESTED[key] || []), state.model, models[0]?.id].find((id) => models.some((m) => m.id === id));
    crewHelperModel = crewMode ? [savedModels.helpers, ...MID].find((id) => models.some((m) => m.id === id)) || "" : "";
    const group = (label, test) => { const list = roles.filter((r) => test(r.phase)); return list.length ? [{ kind: "head", label }, ...list.map((r) => ({ label: r.key, desc: r.desc, on: r.on, role: r, model: r.internal ? undefined : modelFor(r.key) }))] : []; };
    const rows = [
      ...group("Before the builders", (p) => p < 1),
      { kind: "head", label: crewMode ? "Main builder · builds it, commissions helpers as it goes" : "Builders · the lead's split, at the same time" },
      ...agents.map((a) => ({ label: a.name, desc: a.task, on: true, model: modelFor(crewMode ? "main" : "builders") })),
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
    // main: /crew's builder, with a few helpers' worth in it
    const PROFILE = { main: [90, 45, 20, 15], qa: [22, 40, 4, 3], researcher: [10, 15, 4, 1.5], architect: [8, 14, 8, 2], builder: [14, 16, 4, 1], merger: [16, 35, 2, 2], designer: [10, 18, 2, 1], integration: [12, 35, 1.5, 1.5], tester: [20, 25, 4, 2], reviewer: [12, 35, 1.5, 1.5], security: [12, 35, 1.5, 1.5], docs: [8, 18, 2, 1], api: [12, 25, 2, 1.5], setup: [10, 25, 1.5, 1], fixer: [18, 40, 3, 2], spec: [10, 35, 1.5, 1] };
    const estOf = (r) => {
      if (r.role?.internal) return { usd: 0, min: 0.5 };
      // what this role really took on this model in earlier runs, when there are any (learned at the end of a run)
      const seen = api.cfg.team?.learned?.[`${r.role?.key || (crewMode ? "main" : "builder")}|${r.model}`];
      if (seen) return { usd: seen.usd, min: seen.min, seen: seen.n };
      const [req, ctx, out, min] = PROFILE[r.role?.key || (crewMode ? "main" : "builder")] || PROFILE.builder;
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
      { key: "q", label: "Quick", on: (r) => ["qa", "fixer"].includes(r.role.key) || (r.role.key === "merger" && agents.length >= 3) || (!!r.role.internal && defOn(r)) },
      { key: "r", label: "Recommended", on: defOn },
      { key: "e", label: "Everything", on: () => true },
      // quality first, for a run you'll show (2026-10-22): every check that proves it works, Ultra where judgement
      // decides the result, Ultra Flash everywhere else (Lite drifted on whole-project roles)
      { key: "s", label: "Showcase", on: (r) => defOn(r) || ["researcher", "architect", "merger", "qa", "fixer", "spec"].includes(r.role.key), models: (r) => (r.role ? (["architect", "spec"].includes(r.role.key) ? TOP : MID) : crewMode ? TOP : MID) },
    ];
    const pickModel = (list) => list.find((id) => models.some((m) => m.id === id));
    let rounds = 1; // build → judge → improve, up to this many times (+ and − in the picker; Showcase sets 3)
    const count = (p) => items.filter((r) => (r.role ? p.on(r) : r.on)).length;
    const NOTES = { PLAN: "first", BUILD: crewMode ? "one builder, helpers when it asks" : `${agents.length} at the same time`, JOIN: "after the builders", CHECK: "yAI's own, then AI", FIX: "only if needed" };
    // VS Code (yai --stdio): the panel shows the same picker and sends back each row's tick and model
    const pickInPanel = async () => {
      const ans = await state.pickTeamHook({
        task, builders: agents.length, rounds,
        models: models.map((m) => ({ ...m, price: state.models.find((x) => x.id === m.id)?.price || null })),
        presets: PRESETS.map((p) => ({ key: p.key, label: p.label })),
        groups: STAGES.map((S) => ({ name: S.name, note: NOTES[S.name], rows: items.filter((r) => S.has(r.role ? r.role.phase : 1)).map((r) => ({
          i: items.indexOf(r), label: r.label, desc: r.desc, on: !!r.on, model: r.model || null, builtIn: !!r.role?.internal, builder: !r.role,
          profile: r.role?.internal ? null : PROFILE[r.role?.key || "builder"] || PROFILE.builder,
          presets: r.role ? Object.fromEntries(PRESETS.map((p) => [p.key, !!p.on(r)])) : null,
          presetModels: r.model ? Object.fromEntries(PRESETS.filter((p) => p.models).map((p) => [p.key, pickModel(p.models(r)) || r.model])) : null })) })).filter((g) => g.rows.length),
      });
      if (!ans) return null;
      if (ans.chat) return { chat: true };
      if (ans.rounds) rounds = Math.max(1, Math.min(5, Number(ans.rounds) || 1));
      for (const x of ans.rows || []) { const r = items[x.i]; if (!r) continue; r.on = !!x.on; if (x.model && r.model && models.some((m) => m.id === x.model)) r.model = x.model; }
      return items.map((r) => !!r.on);
    };
    const picked = state.pickTeamHook ? await pickInPanel() : await d.checklist({
      rows, models, start: () => "",
      render: (sel) => {
        const t = totals(), n = items.filter((r) => r.on).length, b = items.filter((r) => !r.role && r.on).length;
        const groups = STAGES.map((S) => ({ name: S.name, note: NOTES[S.name], rows: items.filter((r) => S.has(r.role ? r.role.phase : 1)) })).filter((g) => g.rows.length);
        return V.pickLines({
          title: "Pick your team", width: screenW(), sel,
          sub: crewMode ? `One main builder builds "${clip(task, 60)}" and hands side jobs to helpers. Choose who checks it after, and which model each one uses.` : `The lead split "${clip(task, 60)}" into ${agents.length} builder job${agents.length === 1 ? "" : "s"}. Choose who else joins and which model each one uses.`,
          presets: PRESETS.map((p) => ({ label: p.label, count: count(p), on: items.every((r) => !r.role || !!r.on === p.on(r)) })),
          start: { n: b ? n : 0, time: `~${Math.max(1, Math.round(t.min * rounds))} min`, cost: t.usd ? `~${money(t.usd * rounds)}` : "free", parallel: b, rounds, cap: rounds > 1 ? money(Math.max(0.3, t.usd * rounds * 2)) : "", short: left != null && t.usd * rounds > left ? money(left) || "$0" : "" },
          groups: groups.map((g) => ({ ...g, rows: g.rows.map((r) => ({ n: items.indexOf(r) + 1, label: r.label, on: r.on, model: modelShort(r.model), desc: r.desc, est: estText(r), builtIn: !!r.role?.internal })) })),
        });
      },
      onKey: (s, key, { draw, finish }) => {
        const p = !key.ctrl && PRESETS.find((x) => x.key === s);
        if (p) { for (const r of items) { if (r.role) r.on = p.on(r); if (p.models && r.model) r.model = pickModel(p.models(r)) || r.model; } if (p.key === "s") rounds = 3; draw(); return true; }
        if ((s === "+" || s === "=") && rounds < 5) { rounds++; draw(); return true; }
        if (s === "-" && rounds > 1) { rounds--; draw(); return true; }
        if (s === "c" && !key.ctrl) { finish({ chat: true }); return true; }
        return false;
      },
      keys: [["↑↓", "move"], ["space", "toggle"], ["← →", "model"], ["q r e s", "presets"], ["+ −", "rounds"], ["enter", "start"], ["c", "chat"], ["esc", "cancel"]],
    });
    if (!picked) return print(c.dim("   Cancelled."));
    if (picked.chat) {
      state.pendingContext.push(`I ran /team for: "${task}". The lead split it into: ${agents.map((a) => `${a.name} (${a.task}${a.files.length ? `; files: ${a.files.join(", ")}` : ""})`).join("; ")}. I want to talk the plan over before starting; when it's right I'll run /team again.`);
      return print(c.dim("   Not started. Say what you'd change about the plan, then run /team again."));
    }
    const estimate = totals().usd * rounds;
    plannedRounds = Math.max(1, picked.rounds || rounds);
    // the cost cap: twice the estimate, so a run that goes long stops planning more rounds instead of running away
    costCap = Math.max(0.3, estimate * 2);
    items.forEach((r, i) => (r.on = picked[i]));
    const builderRows = items.filter((r) => !r.role);
    agents.forEach((a, i) => (a.model = builderRows[i].model));
    api.cfg.team = { ...(api.cfg.team || {}), suggestedV: 1, roles: Object.fromEntries(items.filter((r) => r.role).map((r) => [r.role.key, r.on])),
      models: { ...savedModels, ...Object.fromEntries(items.filter((r) => r.role && r.model).map((r) => [r.role.key, r.model])), ...(builderRows[0]?.model && { [crewMode ? "main" : "builders"]: builderRows[0].model }) } };
    api.save();
    agents = agents.filter((a, i) => builderRows[i].on);
    if (!agents.length) return print(c.dim("   No builders picked, so nothing ran."));
    const memberRows = items.filter((r) => r.role && r.on);
    const members = memberRows.map((r) => r.role);
    if (agents.length === 1 && !members.length && !crewMode) { // /crew always runs on the board: its builder commissions helpers
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
      const i = await choose({ title: "What should happen to them?", options: ["Move them aside first (to .yai-old/)", "Keep them (the agents see them)", "Cancel"] });
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
    if (entryPage(agents) || (crewMode && WEB.test(task))) agents.splice(agents.findIndex((a) => a.role) === -1 ? agents.length : agents.findIndex((a) => a.role), 0, { name: "browser", task: "yAI opens the page in a browser: console errors, failed loads, a blank screen, and what it looks like", files: [], role: "browser", phase: 1.5, readOnly: true, hasVerdict: true, internal: true });
    // the finish gate: yAI's re-check after the fixer (see startRecheck)
    if (agents.some((a) => a.role === "fixer")) agents.push({ name: "re-check", task: "yAI re-runs the tests and the page, and plays it, after the fixer", files: [], role: "recheck", phase: 3.2, readOnly: true, internal: true, hasVerdict: true });
    // the skeleton check (2026-10-22): the architect's skeleton must load and run before builders fill it in
    if (agents.some((a) => a.role === "architect") && entryPage(agents)) agents.push({ name: "skeleton check", task: "yAI opens the architect's skeleton page: it must load and run, with no errors, before the builders start", files: [], role: "skeleton", phase: 0.8, readOnly: true, internal: true, hasVerdict: true });
    if (plannedRounds > 1 && (entryPage(agents) || (crewMode && WEB.test(task)))) agents.push({ name: "judge", task: "yAI plays it and a model that can see compares it with the request", files: [], role: "judge", phase: 3.8, readOnly: true, internal: true, hasVerdict: true });
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
    feed = []; teamNotes = []; teamDirection = []; teamStarted = Date.now(); roundScores = {}; planningRound = false; chatLog = [];
    recording = { start: Date.now(), last: 0, lastKey: "", dict: [], index: new Map(), frames: [] };
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
    // the VS Code panel (yai --stdio): the board as data, at most every 400 ms and only when it changed
    let lastBoard = "", lastBoardAt = 0;
    const emitBoard = (force) => {
      if (!state.stdio || (!force && Date.now() - lastBoardAt < 400)) return;
      const json = JSON.stringify(plainBoard(agents, task, estimate, viewing, over));
      if (json === lastBoard) return;
      lastBoard = json; lastBoardAt = Date.now();
      ui.event({ type: "team", view: JSON.parse(json) });
    };
    // what the panel asks for: open or close an agent, retry, skip, pause, or a note (to one agent or everyone)
    state.teamAction = (m) => {
      const a = agents[(Number(m.n) || 0) - 1];
      if (m.action === "open") viewing = a || null;
      else if (m.action === "close") viewing = null;
      else if (m.action === "retry") retry(a);
      else if (m.action === "skip") skip(a);
      else if (m.action === "pause") togglePause(a);
      else if (m.action === "go") feedbackWait = null;
      else if (m.action === "play") openPage();
      else if (m.action === "note" && String(m.text || "").trim()) {
        const keep = viewing;
        viewing = a || null;
        state.teamInput(String(m.text).trim());
        viewing = keep;
      }
      emitBoard(true);
    };
    const report = () => { // without a terminal: the panel gets the board; anything else a line when an agent's step changes
      if (tty) return;
      if (state.stdio) return emitBoard();
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
    const retry = (a, auto) => {
      if (!a || a.state === "waiting" || a.state === "skipped") return;
      letGo(a);
      Object.assign(a, { ended: 0, error: "", verdict: "", summary: "", plan: null, paused: false, flag: "", lastMove: Date.now(), stuckSaid: false });
      if (!auto) say(a.name, "restarted by you", "you");
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
      if (feedbackWait && s === "o") { openPage(); return true; }
      if (feedbackWait && s === "g") { feedbackWait = null; return true; }
      if (key.name === "up") { sel = (sel + agents.length - 1) % agents.length; draw(); return true; }
      if (key.name === "down") { sel = (sel + 1) % agents.length; draw(); return true; }
      if (key.name === "return" || key.name === "enter") { open(agents[sel]); return true; }
      const a = agents[sel];
      if (s === "r" && a && (stuck(a) || a.state === "failed" || a.state === "stopped")) { retry(a); return true; }
      if (s === "s" && a && (stuck(a) || a.paused)) { skip(a); return true; }
      if (/^[1-9]$/.test(s || "") && Number(s) <= agents.length) { open(agents[Number(s) - 1]); return true; }
      return false;
    };
    state.teamKeys = () => feedbackWait && !viewing
      ? [["o", "open it to play"], ["type", "what to change"], ["g", "go on"], ["esc", "stop all"]]
      : viewing
      ? [["esc", "back to team"], ["tab", "next agent"], ...(viewing.state === "working" ? [["p", viewing.paused ? "resume it" : "pause it"]] : []), ...(["failed", "stopped"].includes(viewing.state) || stuck(viewing) ? [["r", "restart it"]] : [])]
      : [["↑↓", "pick agent"], ["enter", "watch it"], ...(agents[sel] && (stuck(agents[sel]) || ["failed", "stopped"].includes(agents[sel].state)) ? [["r", "retry"]] : []), ...(agents[sel] && (stuck(agents[sel]) || agents[sel].paused) ? [["s", "skip"]] : []), ["esc", "stop all"]];
    // what you type goes to the whole team (now, and in the briefs of agents that start later), or to the agent you're watching
    state.teamInput = (text) => {
      if (over) return;
      if (viewing) {
        if (viewing.send && viewing.state === "working") { viewing.send({ type: "note", text }); viewing.log.push({ k: "you", text }); say("you", `→ ${viewing.name}: ${text}`, "you"); }
        else say("you", `(${viewing.name} isn't working, so it didn't get: ${text})`, "you");
      } else {
        teamNotes.push(text);
        for (const a of agents) if (a.send && a.state === "working") { a.send({ type: "note", text }); a.log.push({ k: "you", text: `(to the whole team) ${text}` }); }
        say("you", `note: ${text}`, "you");
        // between rounds, a note is feedback for the next round: a few more seconds for another, then it goes on
        if (feedbackWait) feedbackWait.until = Math.min(feedbackWait.until, Date.now() + 15000);
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
    // Rounds (2026-10-22): after a round's spec checker and judge, the lead plans the next round from what's still
    // missing, what the judge saw, what still fails and what you said, and new feature builders improve it while the
    // same checks run again. It stops when the rounds you asked for are used, the cost cap is reached, or the request
    // is all done and the judge calls it GOOD. (A single yAI Code session, iterating with a player's feedback, made a
    // better Minecraft clone than a one-pass team.)
    const ROUND_SYSTEM = "You are the lead of a coding team between rounds. The app exists and runs; plan the next round of improvements that close the gaps below, " +
      "most valuable first: what's broken, then what's missing, then what looks or plays unfinished. Split the work by FEATURE among agents working at the same time. " +
      'Reply with only JSON, no prose and no code fence: {"summary":"one line: what this round improves","agents":[{"name":"2-3 word name","task":"exactly what to improve or add, ' +
      'concrete, naming the files and the shared names involved","files":["files this agent may rewrite or create, relative to the project root, each file under at most one agent"]}]}. ' +
      "An agent may also make small edit_file hooks in other files. If nothing important is left, return {\"summary\":\"done\",\"agents\":[]}. No tool calls.";
    const fresh = (o) => ({ files: [], changed: new Set(), created: new Set(), text: [], cost: 0, asks: [], state: "waiting", started: Date.now(), ...o, step: WAIT_STEP[lp(o.phase)] || "later" });
    const roundKeys = new Set(["qa", "tester", "reviewer", "designer", "security", "fixer", "spec", "mobile", "performance", "accessibility", "playtester"]);
    const roundCost = () => agents.reduce((x, a) => x + (a.cost || 0), 0);
    const lastRound = () => Math.max(...agents.map(rnd));
    const roundDone = (r) => {
      const sc = roundScores[r], judge = agents.filter((a) => a.role === "judge" && rnd(a) === r).pop();
      return sc && sc[0] >= sc[1] && (!judge || judge.verdict === "PASS");
    };
    const canPlanMore = () => !state.interrupted && lastRound() < plannedRounds && roundCost() < costCap && !roundDone(lastRound());
    let notesFrom = 0; // your notes since the last round
    // opens the page in your browser (o between rounds)
    const openPage = () => {
      const entry = entryPage(agents);
      if (!entry) return;
      const abs = path.resolve(root, entry);
      try {
        if (process.platform === "win32") spawn("cmd", ["/c", "start", "", abs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        else spawn(process.platform === "darwin" ? "open" : "xdg-open", [abs], { detached: true, stdio: "ignore" }).unref();
        say("you", "opened it to play", "you");
      } catch {}
    };
    // A copy of every file the team has changed so far, in .yai-team/round-N, to go back to a round that was better
    function snapshot(r) {
      const fs = require("fs");
      const dir = path.join(root, ".yai-team", `round-${r}`);
      const files = [...new Set(agents.flatMap((a) => [...(a.changed || [])]))].filter((p) => fs.existsSync(path.join(root, p)));
      for (const p of files) { try { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.copyFileSync(path.join(root, p), path.join(dir, p)); } catch {} }
      return files.length ? path.relative(root, dir).split(path.sep).join("/") : "";
    }
    // Between rounds, the board waits up to 90 s for you: o opens it to play, what you type becomes the next round's
    // first job, g goes on. (A single yAI Code session with the user playing each round beat the one-pass team.)
    const waitForYou = (r, planner) => (!process.stdout.isTTY && !state.stdio) ? Promise.resolve() : new Promise((go) => {
      feedbackWait = { round: r, until: Date.now() + 90000, go };
      planner.step = `round ${r} is done: o opens it to play · type what to change · g goes on`;
      say("lead", `round ${r} is done: press o to play it, type what to change, or g to go on (90 s)`, "acc");
      const t = setInterval(() => {
        if (!feedbackWait || state.interrupted || Date.now() > feedbackWait.until) { clearInterval(t); feedbackWait = null; go(); }
        else planner.step = `round ${r} is done: o opens it to play · type what to change · g goes on · ${Math.ceil((feedbackWait.until - Date.now()) / 1000)}s`;
      }, 500);
    });
    async function planNextRound() {
      const r = lastRound(), base = 10 * r;
      const planner = fresh({ name: `lead · round ${r + 1}`, task: "plans the next round from the score, the judge and what still fails", role: "planner", round: r + 1, phase: base + 0.4, internal: true, readOnly: true, hasVerdict: false, state: "working", step: "reading the score and the judge's notes", log: [{ k: "brief", text: "plans the next round" }] });
      agents.push(planner);
      agents.sort((x, y) => (x.phase || 1) - (y.phase || 1));
      wake();
      const snap = snapshot(r);
      if (snap) say("yAI", `saved round ${r}'s files in ${snap}`, "you");
      await waitForYou(r, planner);
      planner.step = "reading the score, the judge's notes and yours";
      const spec = agents.filter((a) => a.role === "spec" && rnd(a) === r && a.state === "done").pop();
      const judge = agents.filter((a) => a.role === "judge" && rnd(a) === r && a.state === "done").pop();
      const missing = spec ? spec.text.filter((l) => /\b(PARTLY|MISSING)\b/.test(l)).map(tidy).slice(0, 30) : [];
      const failing = agents.filter((a) => a.role === "recheck" && rnd(a) === r && BAD.test(a.verdict || "")).flatMap((a) => a.text).slice(0, 12);
      const said = teamNotes.slice(notesFrom);
      notesFrom = teamNotes.length;
      const builders = agents.filter((a) => !a.role && rnd(a) === 1).length;
      const prompt = [
        `The task: ${task}`, "",
        roundScores[r] ? `Round ${r} is done. The spec checker's score: ${roundScores[r][0]} of ${roundScores[r][1]} requirements done.` : `Round ${r} is done.`,
        ...(missing.length ? ["", "Still missing or only partly done:", ...missing.map((x) => `- ${x}`)] : []),
        ...(judge?.findings?.length ? ["", "The judge played it and saw (most important first):", ...judge.findings.map((x) => `- ${x}`)] : []),
        ...(failing.length ? ["", "yAI's re-check still found failing:", ...failing] : []),
        ...(said.length ? ["", "What the user said (do this first):", ...said.map((x) => `- ${x}`)] : []),
        "", `Project files now:\n${projectFiles()}`,
        "", `Plan round ${r + 1} with at most ${Math.max(2, Math.min(6, builders))} agents.`,
      ].join("\n");
      let plan = null, list = [];
      try {
        const text = await X.oneShot({ model: lead, system: ROUND_SYSTEM, think: "high", messages: [{ role: "user", content: prompt }], signal: state.abort?.signal });
        plan = planJson(text);
        list = (Array.isArray(plan.agents) ? plan.agents : []).slice(0, 6).filter((x) => x && x.task);
      } catch (err) { planner.error = err.message; }
      const seen = new Set();
      if (crewMode && list.length) list = [{ name: "main builder", task: list.map((x) => `- ${x.name}: ${x.task}`).join("\n"), files: [] }];
      const added = list.map((x, i) => fresh({
        name: clip(String(x.name || `improve ${i + 1}`).trim(), 24), task: String(x.task).trim(), round: r + 1, phase: base + 1,
        files: (Array.isArray(x.files) ? x.files : []).map((p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "")).map((p) => (planFolder && !p.startsWith(planFolder + "/") && !require("fs").existsSync(path.join(root, p)) ? `${planFolder}/${p}` : p)).filter((p) => p && !seen.has(p) && seen.add(p)),
        model: agents.find((a) => !a.role && !a.helperOf && rnd(a) === 1)?.model, crewLead: crewMode || undefined,
      }));
      if (added.length) {
        const like = (key) => agents.find((a) => a.role === key && rnd(a) === 1);
        const asked = said.join(" ").toLowerCase();
        const again = (m) => ["qa", "fixer", "spec"].includes(m.role) || m.internal
          || (m.role === "designer" && /design|look|colou?r|style|pretty|ugly|font|layout/.test(asked))
          || (m.role === "security" && /secur|login|password|auth|xss|inject/.test(asked))
          || (!agents.some((x) => x.role === "qa" && rnd(x) === 1) && ["tester", "reviewer"].includes(m.role)); // no QA: the old checks stay
        const members = agents.filter((a) => rnd(a) === 1 && a.role && roundKeys.has(a.role) && !a.fixRound && again(a)).map((m) => fresh({ name: m.name, task: m.task, role: m.role, round: r + 1, phase: base + lp(m.phase), readOnly: m.readOnly, internal: m.internal, hasVerdict: m.hasVerdict, model: m.model }));
        if (like("browser")) members.push(fresh({ name: "browser", task: like("browser").task, role: "browser", round: r + 1, phase: base + 1.5, readOnly: true, hasVerdict: true, internal: true }));
        if (members.some((m) => m.role === "fixer")) members.push(fresh({ name: "re-check", task: "yAI re-runs the tests and the page, and plays it, after the fixer", role: "recheck", round: r + 1, phase: base + 3.2, readOnly: true, internal: true, hasVerdict: true }));
        members.push(fresh({ name: "judge", task: "yAI plays it and a model that can see compares it with the request", role: "judge", round: r + 1, phase: base + 3.8, readOnly: true, internal: true, hasVerdict: true }));
        agents.push(...added, ...members);
        agents.sort((x, y) => (x.phase || 1) - (y.phase || 1));
      }
      planner.text = added.length ? [`Round ${r + 1}: ${plan?.summary || "improvements"}`, ...added.map((a) => `- ${a.name}: ${clip(a.task, 160)}`)] : [planner.error ? `Couldn't plan the next round: ${planner.error}` : "Nothing important left to improve."];
      for (const l of planner.text) planner.log.push({ k: "text", line: l });
      planner.summary = added.length ? `Round ${r + 1}: ${added.length} improvement${added.length === 1 ? "" : "s"} · ${clip(plan?.summary || "", 120)}` : planner.text[0];
      Object.assign(planner, { state: "done", ended: Date.now() });
      say("lead", added.length ? `round ${r + 1}: ${plan?.summary || "improvements"}` : "no more rounds needed", "acc", added.map((a) => a.name).join(" · "));
      if (!added.length) plannedRounds = r; // nothing left: the run ends here
    }

    const started = Date.now();
    // The builders start now; the checkers wait for them, so they check finished work, not files half-written; the
    // fixer waits for the checkers and only runs if one of them found something.
    const ended = (a) => ENDED.includes(a.state) && !a.asks.length;
    const phase = (n) => agents.filter((a) => (a.phase || 1) === n);
    const hasArchitect = agents.some((a) => a.role === "architect");
    agents.forEach((a) => Object.assign(a, { state: "waiting", step: WAIT_STEP[lp(a.phase)] || "later", started: Date.now(), changed: new Set(), created: new Set(), text: [], cost: 0, asks: [] }));
    if (!hasArchitect) for (const a of agents) if (!a.role) a.step = "starting";
    const PHASES = () => [...new Set(agents.map((a) => a.phase || 1))].sort((x, y) => x - y); // fixer 2 can join mid-run
    // Integration costs a whole agent (2026-10-22: ~$0.20 a run). The reviewer takes it on when both run; and when the
    // page opened cleanly and every built-in check passed, the pieces visibly fit, so it isn't needed.
    const integrationNotNeeded = (a) => {
      if (agents.some((x) => x.role === "qa" && x.state === "waiting" && rnd(x) === rnd(a))) return (a.merged = true, a.step = "done by QA");
      if (agents.some((x) => x.role === "reviewer" && x.state === "waiting")) return (a.merged = true, a.step = "done by the reviewer");
      const page = agents.filter((x) => x.internal && rnd(x) === rnd(a) && (x.phase || 1) < a.phase);
      if (page.some((x) => x.role === "browser") && page.every((x) => x.state === "done" && x.verdict && !BAD.test(x.verdict))) return (a.step = "the page checks all passed");
      return false;
    };
    // The merger only joins pieces that don't fit (2026-10-22: it read the whole project for minutes even when they
    // did). When yAI's own map of the code finds no name, id or script that fails to line up, and every builder of its
    // round finished, there's nothing to join: the page check and the fixer after it catch the rest.
    const mergerNotNeeded = (a) => {
      const builders = agents.filter((x) => !x.role && rnd(x) === rnd(a));
      if (!builders.length || builders.some((x) => x.state !== "done")) return false;
      try {
        const files = [...new Set(builders.flatMap((x) => [...(x.files || []), ...(x.changed || [])]))].filter((f) => !/TEAM_CONTRACT/i.test(f));
        const m = PM.projectMap(root, files);
        if (!m.text || m.mismatches.length || m.modules) return false; // the map doesn't follow imports
      } catch { return false; }
      return (a.step = "the pieces already fit");
    };
    // the architect's questions about the direction (see DIRECTION_SYSTEM), once, before it starts. Not without a way
    // to answer: select() with no terminal and no panel answers its first option at once.
    let direction = process.stdout.isTTY || state.askHook ? "" : "done";
    const askDirection = async (a) => {
      direction = "asking";
      Object.assign(a, { step: "writing its questions for you", lastMove: Date.now() });
      draw();
      let qs = [];
      try {
        const fs = require("fs");
        const spec = fs.existsSync(specFile()) ? fs.readFileSync(specFile(), "utf8").slice(0, 14000) : "";
        const out = await Promise.race([
          X.oneShot({ model: a.model || state.model, system: DIRECTION_SYSTEM, think: "high", signal: state.abort?.signal, messages: [{ role: "user", content: `The request: ${task}\n\n${spec ? `The researcher's findings (TEAM_SPEC.md):\n${spec}` : "(No research was done for this one.)"}` }] }),
          new Promise((r) => setTimeout(() => r(""), 240000)),
        ]);
        qs = (JSON.parse((/\{[\s\S]*\}/.exec(out || "") || ["{}"])[0]).questions || [])
          .map((q) => ({ q: String(q?.q || "").trim(), why: String(q?.why || "").trim(), options: (Array.isArray(q?.options) ? q.options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, 4) }))
          .filter((q) => q.q && q.options.length >= 2)
          .slice(0, 15);
      } catch {}
      if (qs.length && !state.interrupted && !state.abort?.signal.aborted) {
        while (asking) await new Promise((r) => setTimeout(r, 300)); // an agent's question is up
        asking = true;
        a.step = `asking you ${qs.length} questions`;
        say("architect", `has ${qs.length} questions for you about the direction`, "acc");
        draw();
        drawn = 0;
        for (let k = 0; k < qs.length; k++) {
          if (state.abort?.signal.aborted) break;
          const q = qs[k];
          const i = await choose({ title: `The architect asks (${k + 1} of ${qs.length}): ${q.q}`, detail: [q.why, "Esc skips the rest: the team decides them."].filter(Boolean).join("  · "), options: [...q.options, "You decide"] });
          if (i < 0) break;
          teamDirection.push(`${q.q} → ${i < q.options.length ? q.options[i] : "(left to the team)"}`);
        }
        asking = false;
        try {
          if (teamDirection.length) require("fs").writeFileSync(path.join(path.dirname(specFile()), "TEAM_DIRECTION.md"), `# The user's direction\n\nAnswers to the architect's questions, before the design.\n\n${teamDirection.map((n) => `- ${n}`).join("\n")}\n`);
        } catch {}
        const picked = teamDirection.filter((n) => !n.endsWith("(left to the team)")).length;
        say("architect", `got your answers · ${picked} chosen, ${teamDirection.length - picked} left to the team`, "acc");
      }
      direction = "done";
      a.step = "starting";
      wake();
    };
    const next = () => {
      for (const n of PHASES()) {
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
        for (const a of waiting) {
          if (a.role === "architect" && direction !== "done" && !state.interrupted) { if (!direction) askDirection(a); continue; }
          a.started = Date.now();
          if (state.interrupted) Object.assign(a, { state: "stopped", ended: Date.now() });
          else if (a.role === "integration" && integrationNotNeeded(a)) Object.assign(a, { state: "skipped", ended: Date.now() });
          else if (a.role === "merger" && mergerNotNeeded(a)) { Object.assign(a, { state: "skipped", ended: Date.now() }); say("merger", "not needed · yAI's map found nothing to join", "dim"); }
          else if (lp(n) === 3 && a.role === "fixer" && !a.fixRound && !agents.filter((x) => x.role && rnd(x) === rnd(a) && (x.phase || 1) < n).some(concern))
            Object.assign(a, { state: "skipped", step: agents.some((x) => x.role && (x.phase || 1) < 3) ? "nothing to fix" : "no checkers ran", ended: Date.now() });
          // the re-check only runs after a fixer that ran
          // ...or one that changed files and then stopped or failed (2026-10-23: a stopped fixer left game.js as the one
          // word "placeholder", nothing re-checked it, and the team "finished" with a page that threw on load)
          else if (a.role === "recheck" && !agents.some((x) => x.role === "fixer" && rnd(x) === rnd(a) && (x.phase || 1) < a.phase && (x.state === "done" || x.changed?.size))) Object.assign(a, { state: "skipped", step: "nothing was fixed", ended: Date.now() });
          else if (a.role === "recheck") startRecheck(a, task, agents);
          else if (a.role === "judge") startJudge(a, task, agents);
          else if (a.role === "skeleton") startSkeleton(a, task, agents);
          else if (a.role === "browser") startBrowser(a, task, agents);
          else if (a.internal) startInternal(a, task, agents);
          else {
            if (a.role === "fixer" && !a.fixRound) {
              const n = agents.filter((x) => concern(x) && rnd(x) === rnd(a)).length;
              say("fixer", `started · ${n} report${n === 1 ? "" : "s"} to fix`, "acc");
              // first, the reports become one to-do list (cheap; the fixer then starts from it)
              Object.assign(a, { state: "working", step: "merging the reports into one to-do list", lastMove: Date.now() });
              fixerTodo(a, agents, task).finally(() => {
                if (a.state !== "working") return; // skipped meanwhile
                if (state.interrupted) { Object.assign(a, { state: "stopped", ended: Date.now() }); return d.wake(); }
                startAgent(a, task, agents);
              });
            } else if (a.role === "fixer" && a.fixRound === 2) {
              // carries on in fixer 1's conversation while that process is still open; otherwise a fresh fixer
              const prev = agents.find((x) => x.role === "fixer" && !x.fixRound && rnd(x) === rnd(a) && x.kept);
              if (prev && prev.kept.child.exitCode === null && !prev.kept.child.killed) continueFixer(prev, a, agents);
              else { if (prev) letGoKept(agents, rnd(a)); startAgent(a, task, agents); }
            } else startAgent(a, task, agents);
          }
        }
      }
    };
    // The watcher (2026-10-22, Yousef: "one agent active at all times probing what the active agents are doing, telling
    // them to stop or to change what they're doing"). Agents have no step limit and are never stopped for repeating
    // themselves; instead, every 20 s (Yousef: 75 s was too slow) a cheap model reads what each working agent did since it last looked, and sends
    // it a note, or stops one that kept looping after a note. Off with "team": { "watcher": false } in ~/.yai/config.json.
    const WATCH_SYSTEM = [
      "You supervise a team of AI coding agents building one project together. About every minute you see what each working agent did lately: its tool steps, newest last.",
      "Catch an agent wasting time or going wrong: re-reading the same files, running near-identical commands or test harnesses without editing anything, calling check_page over and over after small edits (each takes 10-25 s), drifting from its job, editing files another agent owns, redoing work that is done, or chasing a problem that doesn't matter for the task. Tell it plainly what to do instead.",
      "Leave alone an agent that is making progress (reading what it needs, then editing; testing what it just changed). Most of the time the right answer is no action.",
      "Also say, for each agent that has a numbered plan, how many of its plan steps are finished judging by what it actually did (files read, changed, checked), not by what it said.",
      "Step in only when the steps show a loop that is really wasting time (changing something and back, the same check again and again with nothing changed in between); an agent that repeats a check after a real change is working, not looping.",
      "Reply with JSON only: {\"progress\":[{\"agent\":\"<exact name>\",\"done\":<number of finished plan steps>}],\"actions\":[{\"agent\":\"<exact name>\",\"do\":\"note\" or \"stop\" or \"takeover\",\"message\":\"<one or two plain sentences>\",\"block\":[optional: \"check_page\", \"page_eval\", \"run\", \"read:<path>\" (no reading that file until it edits it) or \"edits-only\" (no looking until it makes a change)],\"steps\":<how many steps the block lasts, default 8>}]}. \"note\" redirects it; add a block to stop the exact thing it keeps doing. \"takeover\" stops it and hands its job to a fresh, stronger agent with your message as the hand-over: use it when it already had a note from you and is still looping or going nowhere. \"stop\" ends it without a replacement: only when its job is clearly done and it's only checking again. An empty actions list is fine.",
    ].join("\n");
    let watching = false;
    const watch = async () => {
      if (watching || over || state.interrupted || api.cfg.team?.watcher === false) return;
      // /crew: it looks every 20 s too, so each agent's to-do stays accurate (Yousef), but steps in (a note or a stop)
      // at most once a minute
      const mayAct = !crewMode || Date.now() - (watch.acted || 0) >= 60000;
      const busy = agents.filter((a) => a.state === "working" && !a.internal && a.log && !a.paused && a.send && !a.awaitingCrew);
      const fresh = busy.filter((a) => a.log.length >= (a.watchedAt || 0) + 2);
      if (!fresh.length) return;
      watching = true;
      const askedAt = Date.now();
      try {
        const show = (x) => x.k === "step" ? `- ${x.verb} ${clip(String(x.arg || ""), 140)}` : x.k === "result" ? `    → ${clip(row1(x.text), 110)}` : x.k === "diff" ? `- changed ${x.path}` : x.k === "you" ? `- (a note it got: ${clip(row1(x.text), 140)})` : `- (${x.k}: ${clip(row1(x.text || x.line), 120)})`;
        const lines = fresh.map((a) => [
          `## ${a.name}${a.role ? ` (${a.role})` : ""}: working for ${secs(Date.now() - a.started)}, ${a.changed.size} file(s) changed${a.watchNotes ? `, ${a.watchNotes} note(s) from you already` : ""}${a.flips ? `, went back to an earlier version of a file ${a.flips} time(s)` : ""}${a.textLoops ? `, wrote the same reasoning again ${a.textLoops} time(s)` : ""}${a.isTakeover ? ", it is ALREADY a takeover (one more loop and it goes to the user)" : ""}`,
          `Its job: ${clip(row1(a.task), 300)}`,
          ...(a.plan?.steps?.length ? ["Its plan:", ...a.plan.steps.map((l, i) => `${i + 1}. ${clip(row1(l), 120)}`), `(it has marked ${a.plan.done} finished)`] : []),
          "Recent steps:",
          ...a.log.filter((x) => ["step", "result", "diff", "note", "you", "error"].includes(x.k)).slice(-20).map(show),
        ].join("\n"));
        const model = ["deepseek-v4.1-flash"].find((id) => state.models.some((m) => m.id === id)) || state.model;
        const out = await X.oneShot({ model, system: WATCH_SYSTEM, signal: state.abort?.signal, messages: [{ role: "user", content: `The task: ${task}\n\n${lines.join("\n\n")}` }] });
        for (const a of fresh) a.watchedAt = a.log.length;
        let acts = [], progress = [];
        try { const j = JSON.parse((/\{[\s\S]*\}/.exec(out) || ["{}"])[0]); acts = j.actions || []; progress = j.progress || []; } catch {}
        for (const p of progress) {
          const a = busy.find((x) => x.name === p.agent), n = Math.floor(Number(p.done));
          if (!a || !a.plan?.steps?.length || a.started > askedAt || !(n > a.plan.done)) continue;
          a.planSeen = Math.min(n, a.plan.steps.length - (a.state === "working" ? 1 : 0)); // the last step ends with the agent
          a.plan = { ...a.plan, done: Math.max(a.plan.done, a.planSeen) };
        }
        if (!mayAct) acts = [];
        else if (acts.length) watch.acted = Date.now();
        for (const act of acts.slice(0, 4)) {
          const a = busy.find((x) => x.name === act.agent), msg = row1(act.message);
          if (!a || !msg || a.state !== "working" || a.started > askedAt) continue;
          // 3 min between two notes to one agent; a takeover or a stop (both only after a note) needn't wait (2026-10-23: a
          // stop for an agent only re-checking finished work was held back 3 minutes, and it went on checking)
          if (Date.now() - (a.notedAt || 0) < 180000 && !["takeover", "stop"].includes(act.do)) continue;
          a.notedAt = Date.now();
          if (act.do === "takeover" && a.watchNotes && !a.takenOver) {
            takeover(a, agents, task, msg);
          } else if (act.do === "stop" && a.watchNotes) {
            a.flag = "stopped by the watcher"; a.watchStopped = true;
            a.log.push({ k: "you", text: `(the watcher stopped it) ${msg}` });
            say("watcher", `stopped ${a.name}`, "warn", msg);
            a.send({ type: "stop" });
          } else {
            a.watchNotes = (a.watchNotes || 0) + 1; a.watchTotal = (a.watchTotal || 0) + 1;
            const block = (Array.isArray(act.block) ? act.block : []).map(String).filter((b) => /^(check_page|page_eval|run|search|read_file|edits-only|read:.+)$/.test(b)).slice(0, 4);
            a.send({ type: "directive", text: msg, block, steps: Number(act.steps) || 8 });
            a.log.push({ k: "you", text: `(the watcher${block.length ? `, blocking ${block.join(", ")}` : ""}) ${msg}` });
            say("watcher", `→ ${a.name}${block.length ? ` · blocks ${block.join(", ")}` : ""}`, "acc", msg);
          }
        }
      } catch {} finally { watching = false; }
    };
    // The slowest agent holds up its whole stage (2026-10-22: one builder at 12 min while the others were done in 4).
    // Once the others in its stage and round have finished and it has run half again as long as the slowest of them
    // (and 3 min past their end), it's told once that the team is waiting: finish the essentials, note what's left.
    // /crew: a main builder 4 min in with no helper yet is reminded once that it can hand parts off
    const crewNudge = () => {
      if (!crewMode) return;
      for (const a of agents) {
        if (!a.crewLead || a.state !== "working" || !a.send || a.helperNudged || a.awaitingCrew) continue;
        if (Date.now() - a.started < 240000 || agents.some((x) => x.helperOf === a.name && rnd(x) === rnd(a))) continue;
        a.helperNudged = true;
        const msg = "You have been building for 4 minutes without a helper. Look at what's left: parts that can be done apart from you (level or map data, sprites or textures, sound, a self-contained module, tests) are faster as helpers working while you go on. Commission 2 or 3 now if the work allows; if it really doesn't, carry on.";
        a.send({ type: "note", text: `From yAI: ${msg}` });
        a.log.push({ k: "you", text: `(yAI) ${msg}` });
        say("yAI", `reminded ${a.name} it can commission helpers`, "acc");
      }
    };
    const straggle = () => {
      for (const a of agents) {
        if (a.state !== "working" || a.internal || !a.send || a.wrapSaid) continue;
        const peers = agents.filter((x) => x !== a && !x.internal && rnd(x) === rnd(a) && lp(x.phase) === lp(a.phase));
        if (!peers.length || !peers.every((x) => x.state === "done")) continue;
        const slowest = Math.max(...peers.map((x) => (x.ended || 0) - (x.started || 0))), lastEnd = Math.max(...peers.map((x) => x.ended || 0));
        if (Date.now() - a.started < slowest * 1.5 || Date.now() - lastEnd < 180000) continue;
        a.wrapSaid = true;
        const msg = `The rest of the team has finished this stage and is waiting for you (for ${secs(Date.now() - lastEnd)}). Finish the essentials of your part in the next few steps, write down anything left undone in your report under "For the others", and end with your report.`;
        a.send({ type: "note", text: `From yAI: ${msg}` });
        a.log.push({ k: "you", text: `(yAI) ${msg}` });
        say("yAI", `the team is waiting on ${a.name} · asked it to wrap up`, "warn");
      }
    };
    // (e) Progress against the request while the builders work (2026-10-22: after 25 min of a Doom run the game was an
    // empty corridor, and nobody said so until the end): every 8 min yAI opens the page, gets past its menus, and a
    // model that can see says what's there and what's missing next to the request. It goes in the feed and to the
    // builders still working, as a team chat message.
    const PROGRESS_SYSTEM = "You check a game or app while it is being built. From the screenshot and the request, say in at most 4 short lines: what is visibly working, and the most important things the request asks for that are not on screen yet. Be concrete and blunt; no praise.";
    let progressBusy = false, progressAt = Date.now();
    const progress = async () => {
      if (progressBusy || over || state.interrupted || Date.now() - progressAt < 480000) return;
      const building = agents.filter((a) => !a.role && a.state === "working" && a.send);
      const entry = entryPage(agents);
      if (!building.length || !entry || !require("fs").existsSync(path.resolve(root, entry))) return;
      progressBusy = true; progressAt = Date.now();
      try {
        const spec = (() => { try { return require("fs").readFileSync(specFile(), "utf8").slice(0, 2500); } catch { return ""; } })();
        const describe = (img) => X.withVision((m) => X.oneShot({ model: m.id, signal: state.abort?.signal, system: PROGRESS_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: `The request: ${clip(task, 1500)}${spec ? `\n\nThe team's checklist:\n${spec}` : ""}` }, X.imagePart(img, "image/jpeg")] }] }), state.abort?.signal).then((x) => String(x?.text || "").trim());
        const r = await require("./teamchecks").pageCheck({ entry: path.resolve(root, entry), keys: "KeyW:600", describe });
        const seen = r.blank ? "The page still draws nothing (a single-colour screen)." : r.frozen ? "The page froze." : (r.lines.find((l) => l.startsWith("On screen")) ? r.lines.slice(r.lines.findIndex((l) => l.startsWith("On screen")) + 1).join(" ") : "");
        if (!seen) return;
        const text = `${secs(Date.now() - teamStarted)} in: ${row1(seen)}`;
        say("yAI", "progress check against the request", "acc", text);
        for (const a of agents.filter((x) => !x.role && x.state === "working" && x.send)) { a.send({ type: "chat", from: "yAI's progress check", text, to: false }); a.log.push({ k: "chat", from: "yAI's progress check", text }); }
      } catch {} finally { progressBusy = false; }
    };
    const watchTimer = setInterval(() => { if (over) clearInterval(watchTimer); else { straggle(); crewNudge(); watch(); progress(); } }, Number(process.env.YAI_TEAM_WATCH_MS) || 20000); // (shorter only in test/crew-team)
    try {
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          // an agent with no step for two minutes is stuck: once in the feed (the board offers r retry · s skip)
          // the first time, yAI restarts it itself (2026-10-22); a second time it's flagged for you
          for (const a of agents) {
            if (!stuck(a) || a.stuckSaid || state.interrupted) continue;
            if (!a.autoRetried && !a.internal) { a.autoRetried = true; say(a.name, "no progress for 2m · restarted automatically", "warn"); retry(a, true); }
            else { a.stuckSaid = true; say(a.name, "has not done anything for 2m", "warn"); }
          }
          draw(); report();
          recordFrame(agents, task, estimate, tick);
        }, 120);
        wake = async () => {
          if (over) return;
          next();
          // a round is over: plan the next one while there are rounds left (the board shows the lead planning it)
          if (agents.every(ended) && !planningRound && canPlanMore()) {
            planningRound = true;
            planNextRound().catch(() => {}).finally(() => { planningRound = false; wake(); });
            return;
          }
          if (planningRound) return;
          if (agents.every(ended)) { clearInterval(timer); if (recording) { recording.last = 0; recordFrame(agents, task, estimate, 0); } draw(); over = true; return resolve(); }
          if (asking) return;
          const a = agents.find((x) => x.asks.length);
          if (!a) return;
          // An agent wants to run something: the board steps aside for the question.
          const q = a.asks[0];
          draw();
          drawn = 0;
          asking = true;
          const i = state.abort.signal.aborted ? -1 : await choose({ title: `${a.name}: ${q.title}`, detail: q.detail, options: q.options.slice(0, 2).concat("No") });
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
      // the panel's last board, marked as over (it stays in the conversation there)
      letGoKept(agents); // a first fixer still kept open for fixer 2
      if (state.stdio) { over = true; viewing = null; emitBoard(true); }
      state.keyHook = null;
      state.teamKeys = null;
      state.teamInput = null;
      state.teamAction = null;
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
    const fixer = agents.filter((a) => a.role === "fixer" && a.state === "done").pop();
    if (fixer && !state.interrupted && !fixer.recheck) {
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
    const fixerA = crew.filter((a) => a.role === "fixer" && a.state !== "waiting").pop() || crew.find((a) => a.role === "fixer"); // the last round that ran
    const free = agents.filter((a) => !a.internal && a.state !== "skipped" && !a.cost).length;
    print("");
    ui.note(`${files.size ? c.green("✓") : c.yellow("!")} ${c.ink(`Team finished in ${secs(Date.now() - started)}`)} ${c.dim(`· ${files.size} file${files.size === 1 ? "" : "s"} changed · $${cost.toFixed(3)}${free ? ` · ${free} agent${free === 1 ? "" : "s"} cost nothing` : ""}`)}`);
    print("");
    row("Built", builders.map((a) => `${ICON[a.state] ? ICON[a.state]() : "·"} ${c.ink(a.name)}${a.flag ? " " + c.yellow(a.flag) : ""}`));
    row("Checked", crew.filter((a) => a.role !== "fixer" && a.role !== "recheck" && a.role !== "spec").map((a) => `${c.dim(a.role)} ${outcome(a)}`));
    // every fixer round, then what yAI's last re-check found
    const fixers = crew.filter((a) => a.role === "fixer");
    if (fixers.length) row("Fixed", [
      ...fixers.map((f) => (f.state === "skipped" ? c.faint("nothing to fix") : `${c.dim(f.name)} ${outcome(f)}${f.changed.size ? c.faint(` · ${shortFiles([...f.changed])}`) : ""}`)),
      ...(fixerA.recheck || []).map((r) => `${r.code === 0 ? c.green("✓") : c.red("✗")} ${c.dim(clip(r.cmd, 40))}${r.counts ? c.dim(` ${r.counts.passed} passed, ${r.counts.failed} failed`) : ""}`),
    ]);
    const spec = crew.filter((a) => a.role === "spec" && a.state === "done").pop(); // the last round's
    if (spec) row("Request", [scoreOf(spec) ? `${c.bold(c.ink(`${scoreOf(spec)[0]} of ${scoreOf(spec)[1]}`))} ${c.dim("requirements done")}` : outcome(spec)]);
    // what needs a look, one line each
    const attention = [
      ...(state.teamStopReason ? [`The team stopped because today's yAI allowance ran out (${clip(state.teamStopReason, 120)}). It resets at midnight UTC, and an admin can raise it on /people.`] : []),
      ...agents.filter((a) => a.state === "failed").map((a) => `${a.name} failed${a.error ? `: ${row1(a.error)}` : ""}`),
      ...agents.filter((a) => a.flag).map((a) => `${a.name}: ${a.flag}`),
      ...quiet.map((a) => `${a.role} gave no verdict, so its check may be incomplete`),
      ...(fixerA?.verdict === "FIXED" && fixerA.recheck?.some((r) => r.code !== 0) ? ["the fixer said FIXED, but the checks still fail"] : []),
      ...(fixerA?.recheck || []).filter((r) => r.code !== 0).map((r) => `${clip(r.cmd, 40)} still fails: ${row1(r.tail.slice(-1)[0] || "")}`),
    ];
    for (const t of attention) print(`   ${c.yellow("!")} ${c.ink(clip(t, ui.width() - 6))}`);
    // where the time went (the full table is in TEAM_REPORT.html): the cache rate, and the agents that look wasteful
    {
      const worked = agents.filter((a) => !a.internal && ran(a) && a.eff);
      const all = worked.map(usageOf).filter(Boolean).reduce((x, u) => addUsage(x, u), null);
      const waste = worked.map((a) => ({ a, f: effOf(a) })).filter((x) => x.f.warn.length).sort((x, y) => y.f.mins - x.f.mins).slice(0, 3);
      if (all && all.new + all.cached) print(`   ${c.dim("Efficiency")}  ${c.ink(`${Math.round((100 * all.cached) / (all.new + all.cached))}% of prompt tokens cached`)}${c.dim(` · ${tokensOf(all.new)} new, ${tokensOf(all.cached)} cached, ${tokensOf(all.out)} written`)}`);
      for (const { a, f } of waste) print(`   ${c.yellow("·")} ${c.ink(a.name)} ${c.dim(`${secs(f.mins * 60000)}, ${f.steps} steps: ${f.warn.join(", ")}`)}`);
    }
    // What each role really cost and took, per model, so the next estimate is this user's own average instead of a
    // guess (2026-10-22: the picker's numbers were always off). Only agents that finished count; the newest run weighs
    // a third.
    try {
      const learned = { ...(api.cfg.team?.learned || {}) };
      for (const a of agents) {
        if (a.internal || a.state !== "done" || !a.model || !a.started || !a.ended) continue;
        const k = `${a.role || (a.crewLead ? "main" : a.helperOf ? "helper" : "builder")}|${a.model}`, min = (a.ended - a.started) / 60000, usd = a.cost || 0;
        const o = learned[k];
        learned[k] = o ? { usd: o.usd + (usd - o.usd) / 3, min: o.min + (min - o.min) / 3, n: (o.n || 1) + 1 } : { usd, min, n: 1 };
      }
      api.cfg.team = { ...(api.cfg.team || {}), learned };
      api.save();
    } catch {}
    let reportAt = "";
    if (files.size) { try { reportAt = writeReport(agents, task, estimate); } catch (err) { print(c.yellow(`   Couldn't write the team report: ${err.message}`)); } }
    if (reportAt) print(`   ${c.accent("◆")} ${c.ink("The run as a page")} ${c.dim(`· ${reportAt}: open it in a browser (a replay of the board, the score, every agent, screenshots)`)}`);
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

  return { team, crew: (arg) => team(arg, { crew: true }), browserCheck, _views: { runView, agentView, V } }; // browserCheck: for trying the check on its own; _views: for testing the screens
};
