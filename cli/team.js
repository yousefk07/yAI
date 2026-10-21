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

const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const MAX_AGENTS = 4;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LEAD_SYSTEM =
  "You are the lead of a small coding team. Split the user's task among agents that work AT THE SAME TIME in one folder, " +
  "each with file and shell tools. Reply with only JSON, no prose and no code fence: " +
  '{"agents":[{"name":"2-3 word name","task":"exactly what this agent does, concrete enough to do alone","files":["paths it may create or change"]}]}. ' +
  "Rules: split by independent pieces (for example the API, the page, the tests); every file belongs to at most one agent, " +
  "since two agents editing one file would overwrite each other; each task must make sense without waiting for another " +
  "(agree on names, routes and data shapes inside the task text so the pieces fit). If the task is small or can't be split " +
  "without agents stepping on each other, return a single agent. No tool calls.";

// The members who aren't builders. phase 2 runs when the builders finish; phase 3 (the fixer) only if a check found
// something. readOnly roles run in plan mode and can't edit; the others edit, and all may run checks that change nothing.
const ROLES = [
  { key: "integration", phase: 2, readOnly: true, on: true, desc: "checks the pieces fit together (imports, routes, data shapes)" },
  { key: "tester", phase: 2, on: true, desc: "writes and runs tests for the new work (test files only)" },
  { key: "reviewer", phase: 2, readOnly: true, on: false, desc: "reviews the code for bugs, edge cases and messy code" },
  { key: "security", phase: 2, readOnly: true, on: (task) => /server|api|login|auth|password|token|form|upload|database|sql|payment|cookie|session/i.test(task), desc: "looks for security holes (injection, auth, secrets, unsafe input)" },
  { key: "docs", phase: 2, on: false, verdict: false, desc: "updates the README and docs for what changed" },
  { key: "fixer", phase: 3, on: true, desc: "fixes what the checkers found, then re-runs their checks" },
];
const BAD = /^(PROBLEMS|FAIL|PARTLY)$/;

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
      `You are one of ${all.length} agents working at the same time in this project, as a team. The team's overall task: ${task}`,
      "", `Your part: ${me.task}`,
      "", me.files.length ? `Files that are yours to create or change: ${me.files.join(", ")}.` : "Keep your changes to the files your part needs.",
      ...others.map((o) => `"${o.name}" is doing: ${clip(o.task, 300)}${o.files.length ? ` (its files: ${o.files.join(", ")})` : ""}. Don't edit its files; if you need a change there, say so in your report.`),
      "", "Don't commit, push or change git history, and don't start servers that keep running.",
      ...(roles.length ? [`After the builders finish, ${roles.join(", ").replace(/, ([^,]*)$/, " and $1")} ${roles.length === 1 ? "checks" : "check"} the work, so focus on your part.`] : []),
      "When you're done, end with a short report: what you changed, file by file, and anything the others or the user still need to do.",
    ].join("\n");
  }

  const workersLines = (all) => all.filter((a) => !a.role).map((o) => `"${o.name}" did: ${clip(o.task, 300)}${o.changed?.size ? ` (files changed: ${[...o.changed].join(", ")})` : o.files.length ? ` (its files: ${o.files.join(", ")})` : ""}${o.state && o.state !== "done" ? ` (it ${o.state === "stopped" ? "was stopped" : "failed"} before finishing)` : ""}.`);
  const CHECKS = "You may run checks that don't change anything, and should when they help: a syntax check (node --check <file>, python -m py_compile <file>), the project's tests, or its linter. Run one command at a time, without chaining.";
  const RULES = "Don't commit, push or change git history, don't install packages, and don't start servers that keep running.";
  const verdictRule = (a, b) => `End your report with one last line, exactly "VERDICT: ${a}" or "VERDICT: ${b}".`;

  // The briefs of the members who check the builders' work (phase 2).
  function roleBrief(a, task, all) {
    const n = all.filter((x) => !x.role).length;
    const head = `You are the ${a.role} on a team of agents working in this project. ${n} builder agent${n === 1 ? "" : "s"} did the work and ${n === 1 ? "has" : "have"} finished. The team's overall task: ${task}`;
    const body = {
      tester: [
        "Your job: test the builders' work. Write or update tests ONLY in test files (tests/, test/, __tests__/, *.test.*, *.spec.*, test_*.py); don't change the app's code.",
        "Use the project's test setup if it has one; if it has none, use the language's built-in runner (node --test, python -m unittest) without installing anything. Run the tests.",
        "If a test fails because of a bug in the app, leave the bug for the fixer: report the file, the line and what's wrong.",
        CHECKS, "", RULES,
        "When you're done, end with a short report: the tests you wrote, what passed, and every failure with its file and line.", verdictRule("PASS", "FAIL"),
      ],
      reviewer: [
        "Your job: review the builders' code as a careful senior engineer would: bugs, wrong logic, missed edge cases (empty input, errors, nulls), missing error handling, duplicated or confusing code.",
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
        "(1) every file that is imported or required exists, and every imported name is actually exported;",
        "(2) routes, command names, event names and data shapes match between the files that produce and consume them;",
        "(3) no file is left half-wired (dangling references, TODO stubs, duplicated definitions, syntax errors);",
        "(4) the agents' changes don't contradict each other (two files defining the same thing differently).",
        "This is a READ-ONLY check: do not edit any files. Read the files the agents changed and the files that use them, and name the file and line for every problem you find.",
        CHECKS, "", RULES,
        "When you're done, end with a short report: problems found (file, what's wrong, how bad), and anything the other agents or the user still need to do. If everything is consistent, say so plainly.",
        verdictRule("OK", "PROBLEMS"),
      ],
    }[a.role];
    return [head, "", ...workersLines(all), "", ...body].join("\n");
  }

  // The fixer (phase 3) gets the reports that found something, and fixes those problems.
  function fixerBrief(task, all) {
    const found = all.filter((x) => x.role && x.role !== "fixer" && (BAD.test(x.verdict || "") || x.state === "failed"));
    return [
      `You are the fixer on a team of agents working in this project. The team's overall task: ${task}`, "",
      ...workersLines(all), "",
      "After them, these checkers found problems. Their reports:", "",
      ...found.map((x) => `## ${x.role} (${x.verdict ? "VERDICT: " + x.verdict : x.state})\n${(x.text.join("\n").trim() || x.error || "(no report)").slice(-3000)}`), "",
      "Your job: fix those problems, in any file, with the smallest changes that do it properly. Skip nits and anything that is really a question for the user (list those instead). Then re-run the checks or tests that failed to show they pass now.",
      CHECKS, "", RULES,
      "When you're done, end with a short report: each problem and what you did about it, file by file, and anything left for the user.",
      verdictRule("FIXED", "PARTLY"),
    ].join("\n");
  }

  // ---------- running the agents ----------
  function startAgent(a, task, all) {
    a.state = "starting"; a.started = Date.now(); a.step = "starting"; a.changed = new Set(); a.text = []; a.cost = 0; a.asks = [];
    const child = spawn(process.execPath, [path.join(__dirname, "index.js"), "--stdio"], {
      cwd: root, env: { ...process.env, YAI_NO_MCP: "1", YAI_THEME: "dark", ...(a.readOnly ? { YAI_REPORT_ONLY: "1" } : a.role && { YAI_SAFE_CHECKS: "1" }) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
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
      else if (e.type === "step") a.step = `${e.verb} ${e.arg}`.trim();
      else if (e.type === "diff" && e.path) a.changed.add(e.path);
      else if (e.type === "text-start") a.text = [];
      else if (e.type === "text") a.text.push(e.line);
      else if (e.type === "ask") a.asks.push(e), d.wake();
      else if (e.type === "error") { a.error = e.message; if (a.state !== "working") a.state = "failed"; }
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
    return agents.map((a) => {
      const icon = ICON[a.state] ? ICON[a.state]() : c.accent(SPIN[tick % SPIN.length]);
      const time = secs((a.ended || Date.now()) - a.started);
      const right = `${a.changed.size ? `${a.changed.size} file${a.changed.size > 1 ? "s" : ""} · ` : ""}${time}${a.cost ? ` · $${a.cost.toFixed(3)}` : ""}`;
      const what = a.state === "done" ? (a.verdict ? `finished · ${a.verdict}` : "finished") : a.state === "waiting" || a.state === "skipped" ? a.step : a.state === "failed" ? a.error || "failed" : a.state === "stopped" ? "stopped" : a.asks.length ? "waiting for you" : a.step;
      const room = Math.max(8, w - nameW - right.length - 11);
      return `   ${icon} ${c.ink(a.name.padEnd(nameW))}  ${(a.state === "failed" ? c.red : a.asks.length ? c.yellow : c.dim)(clip(String(what).replace(/\s+/g, " "), room).padEnd(room))}  ${c.faint(right)}`;
    });
  }

  async function team(arg) {
    let max = MAX_AGENTS;
    const m = /^([2-4])\s+([\s\S]+)$/.exec(arg.trim());
    if (m) { max = Number(m[1]); arg = m[2]; }
    const task = arg.trim();
    if (!task) return print(c.yellow("   Usage: /team <task>   (or /team 3 <task> for at most 3 agents). A lead splits it, the agents work at the same time."));
    if (state.mode === "plan" || state.tutor) return print(c.yellow("   /team changes files; leave plan or tutor mode first (⇧⇥ or /tutor)."));

    // 1. The lead splits the work.
    const lead = X.partnerModel()?.id || state.model;
    let agents;
    try {
      const text = await X.busy("splitting the work", (signal) => X.oneShot({
        model: lead, system: LEAD_SYSTEM, signal,
        messages: [{ role: "user", content: `Project files:\n${projectFiles()}\n\nTask: ${task}\n\nUse at most ${max} agents.` }],
      }));
      agents = parsePlan(text, max);
    } catch (err) {
      return print(c.red(`   ${state.interrupted ? "Stopped." : err.message}`));
    }
    // 2. You pick the team: the lead's builders, the checkers after them, and the fixer. The picks are remembered.
    const saved = api.cfg.team?.roles || {};
    const roles = ROLES.map((r) => ({ ...r, on: r.key in saved ? !!saved[r.key] : typeof r.on === "function" ? r.on(task) : r.on }));
    print("");
    ui.note(`${c.accent("◆")} ${c.ink(agents.length === 1 ? "The lead kept it as one part" : `The lead split it into ${agents.length} parts`)} ${c.dim(`· with ${d.modelLabel()}; pick who joins them`)}`);
    for (const a of agents) if (a.files.length) print(`     ${c.accent("•")} ${c.ink(a.name)} ${c.faint(clip(a.files.join(", "), Math.max(20, ui.width() - a.name.length - 10)))}`);
    print("");
    const rows = [
      { kind: "head", label: "Builders · the lead's split, at the same time" },
      ...agents.map((a) => ({ label: a.name, desc: a.task, on: true })),
      { kind: "head", label: "After they finish · together" },
      ...roles.filter((r) => r.phase === 2).map((r) => ({ label: r.key, desc: r.desc, on: r.on, role: r })),
      { kind: "head", label: "If anything is found" },
      ...roles.filter((r) => r.phase === 3).map((r) => ({ label: r.key, desc: r.desc, on: r.on, role: r })),
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
    for (const r of members) agents.push({ name: r.key, task: r.desc, files: [], role: r.key, phase: r.phase, readOnly: !!r.readOnly, hasVerdict: r.verdict !== false });

    // 3. They run; the board redraws while they work. Esc stops them all.
    state.busy = true;
    state.interrupted = false;
    state.abort = new AbortController();
    d.syncMute();
    const tty = process.stdout.isTTY && !state.stdio;
    let drawn = 0, tick = 0, wake = () => {}, over = false, asking = false;
    d.wake = () => wake();
    const draw = () => {
      // once the team is done the board belongs to the conversation; an agent's process ending later (it calls wake)
      // mustn't draw it again under the reports
      // while an agent's question is open it owns the bottom of the screen; redrawing the board would wipe it
      if (!tty || over || asking) return;
      const lines = boardLines(agents, tick++);
      if (ui.screen) return ui.screen.setExtra(["", ...lines]); // the full-window app keeps the board at the end
      if (drawn) process.stdout.write(`\x1b[${drawn}A`);
      for (const l of lines) process.stdout.write("\r\x1b[K" + l + "\n");
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
    const started = Date.now();
    // The builders start now; the checkers wait for them, so they check finished work, not files half-written; the
    // fixer waits for the checkers and only runs if one of them found something.
    const ended = (a) => ENDED.includes(a.state) && !a.asks.length;
    const phase = (n) => agents.filter((a) => (a.phase || 1) === n);
    agents.forEach((a) => (a.role ? Object.assign(a, { state: "waiting", step: a.phase === 3 ? "if anything is found" : "after the builders", started: Date.now(), changed: new Set(), text: [], cost: 0, asks: [] }) : startAgent(a, task, agents)));
    const next = () => {
      for (const n of [2, 3]) {
        const waiting = phase(n).filter((a) => a.state === "waiting");
        if (!waiting.length || !agents.filter((a) => (a.phase || 1) < n).every(ended)) continue;
        for (const a of waiting) {
          a.started = Date.now();
          if (state.interrupted) Object.assign(a, { state: "stopped", ended: Date.now() });
          else if (n === 3 && !phase(2).some((x) => BAD.test(x.verdict || "") || x.state === "failed"))
            Object.assign(a, { state: "skipped", step: phase(2).length ? "nothing to fix" : "no checkers ran", ended: Date.now() });
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
      });
    } finally {
      // the full-window app: the board's last state goes into the conversation, where it stays
      if (ui.screen) { ui.screen.setExtra([]); for (const l of boardLines(agents, 0)) print(l); }
      state.busy = false;
      state.abort = null;
      d.syncMute();
    }

    // 4. The reports: the builders' last lines, then each member's report whole, the fixer last.
    const cost = agents.reduce((s, a) => s + a.cost, 0);
    state.cost.session += cost;
    const files = new Set(agents.flatMap((a) => [...a.changed]));
    const builders = agents.filter((a) => !a.role);
    const crew = agents.filter((a) => a.role);
    print("");
    ui.note(`${files.size ? c.green("✓") : c.yellow("!")} ${c.ink(`Team finished in ${secs(Date.now() - started)}`)} ${c.dim(`· ${files.size} file${files.size === 1 ? "" : "s"} changed${cost ? ` · $${cost.toFixed(3)}` : ""}`)}`);
    if (crew.length) print(`     ${crew.map((a) => `${c.dim(a.role)} ${a.state === "skipped" ? c.faint("not needed") : a.state !== "done" ? c.yellow(a.state) : verdictPill(a.verdict) || c.faint(a.hasVerdict ? "no verdict" : "done")}`).join(c.faint("  ·  "))}`);
    for (const a of [...builders, ...crew]) {
      if (a.state === "skipped") continue;
      print("");
      const what = a.readOnly ? "read-only check" : a.changed.size ? [...a.changed].join(", ") : "no files changed";
      print(` ${ICON[a.state] ? ICON[a.state]() : "·"} ${c.ink(a.name)}${a.verdict ? " " + verdictPill(a.verdict) : ""} ${c.faint(clip(what, Math.max(20, ui.width() - a.name.length - 16)))}`);
      const said = a.text.join("\n").trim() || a.error || "";
      // a builder's report shows its last lines; the others' reports are shown whole (up to 40 lines), wrapped, without the VERDICT line
      const lines = said.split("\n").filter((x) => x.trim() && !/^\W*VERDICT:/i.test(x.trim()));
      if (a.role) for (const l of lines.slice(0, 40)) for (const w of wrapText(l, ui.width() - 6)) print(`     ${c.ink(w)}`);
      else for (const l of lines.slice(-8)) print(`     ${c.dim(clip(l, ui.width() - 6))}`);
    }
    print("");
    print(c.dim("   Their reports are in this conversation now: ask a follow-up, or /review to check the change as a whole."));
    const skipped = crew.filter((a) => a.state === "skipped");
    state.pendingContext.push(
      `I ran /team: ${builders.length} builder agent${builders.length === 1 ? "" : "s"} worked on this at the same time${crew.length ? `, then ${crew.map((a) => a.role).join(", ")}` : ""}: "${task}". Their reports:\n\n` +
      agents.filter((a) => a.state !== "skipped").map((a) => `## ${a.name}${a.role ? ` (${a.readOnly ? "read-only " : ""}${a.role})` : ""} (${a.state}${a.verdict ? `, VERDICT: ${a.verdict}` : ""})\nPart: ${a.task}\nFiles changed: ${a.changed.size ? [...a.changed].join(", ") : "none"}\n${(a.text.join("\n").trim() || a.error || "(no report)").slice(-3000)}`).join("\n\n") +
      (skipped.length ? `\n\n(${skipped.map((a) => a.role).join(", ")} didn't run: nothing to fix.)` : "") +
      "\n\nThe files may have changed since you last read them; re-read before editing.",
    );
  }

  return { team };
};
