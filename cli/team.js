"use strict";
// /team (2026-10-21): background agents that split the work. A lead model splits the task into 2 to 4 parts that touch
// different files; each part runs as its own yAI Code (`yai --stdio`, a child process in this folder, edits approved
// for it), all at the same time. A live board shows each one's current step, time and cost; commands they want to run
// still come to you for approval, one at a time. At the end their reports go into this conversation, so you (and
// yAI) can carry on from there, or check it all with /review.

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

module.exports = function create(d) {
  const { state, root, api, ui, X } = d;
  const { c, print, spinner } = ui;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
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
    const others = all.filter((a) => a !== me);
    return [
      `You are one of ${all.length} agents working at the same time in this project, as a team. The team's overall task: ${task}`,
      "", `Your part: ${me.task}`,
      "", me.files.length ? `Files that are yours to create or change: ${me.files.join(", ")}.` : "Keep your changes to the files your part needs.",
      ...others.map((o) => `"${o.name}" is doing: ${clip(o.task, 300)}${o.files.length ? ` (its files: ${o.files.join(", ")})` : ""}. Don't edit its files; if you need a change there, say so in your report.`),
      "", "Don't commit, push or change git history, and don't start servers that keep running.",
      "When you're done, end with a short report: what you changed, file by file, and anything the others or the user still need to do.",
    ].join("\n");
  }

  // ---------- running the agents ----------
  function startAgent(a, task, all) {
    a.state = "starting"; a.started = Date.now(); a.step = "starting"; a.changed = new Set(); a.text = []; a.cost = 0; a.asks = [];
    const child = spawn(process.execPath, [path.join(__dirname, "index.js"), "--stdio"], {
      cwd: root, env: { ...process.env, YAI_NO_MCP: "1", YAI_THEME: "dark" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    a.child = child;
    a.send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch {} };
    let err = "";
    child.stderr.on("data", (b) => (err += b).length > 4000 && (err = err.slice(-4000)));
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      if (e.type === "ready") {
        a.send({ type: "mode", mode: "acceptEdits" });
        if (e.model !== state.model) a.send({ type: "model", id: state.model });
        a.send({ type: "prompt", text: brief(task, a, all) });
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

  const ICON = { done: () => c.green("✓"), failed: () => c.red("✗"), stopped: () => c.yellow("■") };
  function boardLines(agents, tick) {
    const w = ui.width();
    const nameW = Math.max(...agents.map((a) => a.name.length));
    return agents.map((a) => {
      const icon = ICON[a.state] ? ICON[a.state]() : c.accent(SPIN[tick % SPIN.length]);
      const time = secs((a.ended || Date.now()) - a.started);
      const right = `${a.changed.size ? `${a.changed.size} file${a.changed.size > 1 ? "s" : ""} · ` : ""}${time}${a.cost ? ` · $${a.cost.toFixed(3)}` : ""}`;
      const what = a.state === "done" ? "finished" : a.state === "failed" ? a.error || "failed" : a.state === "stopped" ? "stopped" : a.asks.length ? "waiting for you" : a.step;
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
    if (agents.length === 1) {
      ui.note(`${c.accent("◆")} ${c.ink("This one doesn't split well, so yAI does it on its own.")}`);
      return d.runAgent(task);
    }
    print("");
    ui.note(`${c.accent("◆")} ${c.ink(`The lead split it into ${agents.length} parts`)} ${c.dim(`· they run at the same time, with ${d.modelLabel()}`)}`);
    for (const a of agents) {
      print(`     ${c.accent("•")} ${c.ink(a.name)} ${c.dim("· " + clip(a.task, Math.max(30, ui.width() - a.name.length - 12)))}`);
      if (a.files.length) print(`       ${c.faint(clip(a.files.join(", "), ui.width() - 10))}`);
    }
    print("");
    const go = await d.select({ title: `Start ${agents.length} agents?`, note: "edits are made without asking; commands still ask", options: ["Start", "Cancel"] });
    if (go !== 0) return print(c.dim("   Cancelled."));

    // 2. They run; the board redraws while they work. Esc stops them all.
    state.busy = true;
    state.interrupted = false;
    state.abort = new AbortController();
    d.syncMute();
    const tty = process.stdout.isTTY && !state.stdio;
    let drawn = 0, tick = 0, wake = () => {};
    d.wake = () => wake();
    const draw = () => {
      if (!tty) return;
      const lines = boardLines(agents, tick++);
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
      for (const a of agents) { a.send?.({ type: "stop" }); setTimeout(() => a.child && a.child.exitCode === null && a.child.kill(), 3000); }
    });
    const started = Date.now();
    agents.forEach((a) => startAgent(a, task, agents));
    try {
      await new Promise((resolve) => {
        const timer = setInterval(() => { draw(); report(); }, 120);
        let asking = false;
        wake = async () => {
          if (agents.every((a) => ["done", "failed", "stopped"].includes(a.state) && !a.asks.length)) { clearInterval(timer); draw(); return resolve(); }
          if (asking) return;
          const a = agents.find((x) => x.asks.length);
          if (!a) return;
          // An agent wants to run something: the board steps aside for the question.
          asking = true;
          const q = a.asks[0];
          draw();
          drawn = 0;
          const i = state.abort.signal.aborted ? -1 : await d.select({ title: `${a.name}: ${q.title}`, detail: q.detail, options: q.options.slice(0, 2).concat("No") });
          a.asks.shift();
          a.send({ type: "answer", id: q.id, choice: i === 2 ? 2 : i });
          asking = false;
          wake();
        };
        draw();
      });
    } finally {
      state.busy = false;
      state.abort = null;
      d.syncMute();
    }

    // 3. The reports.
    const cost = agents.reduce((s, a) => s + a.cost, 0);
    state.cost.session += cost;
    const files = new Set(agents.flatMap((a) => [...a.changed]));
    print("");
    ui.note(`${files.size ? c.green("✓") : c.yellow("!")} ${c.ink(`Team finished in ${secs(Date.now() - started)}`)} ${c.dim(`· ${files.size} file${files.size === 1 ? "" : "s"} changed${cost ? ` · $${cost.toFixed(3)}` : ""}`)}`);
    for (const a of agents) {
      print("");
      print(` ${ICON[a.state] ? ICON[a.state]() : "·"} ${c.ink(a.name)} ${c.faint(a.changed.size ? [...a.changed].join(", ") : "no files changed")}`);
      const said = a.text.join("\n").trim() || a.error || "";
      for (const l of said.split("\n").filter((x) => x.trim()).slice(-8)) print(`     ${c.dim(clip(l, ui.width() - 6))}`);
    }
    print("");
    print(c.dim("   Their reports are in this conversation now: ask a follow-up, or /review to check the change as a whole."));
    state.pendingContext.push(
      `I ran /team: ${agents.length} agents worked on this at the same time: "${task}". Their reports:\n\n` +
      agents.map((a) => `## ${a.name} (${a.state})\nPart: ${a.task}\nFiles changed: ${a.changed.size ? [...a.changed].join(", ") : "none"}\n${(a.text.join("\n").trim() || a.error || "(no report)").slice(-3000)}`).join("\n\n") +
      "\n\nThe files may have changed since you last read them; re-read before editing.",
    );
  }

  return { team };
};
