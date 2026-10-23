// /crew (2026-10-23, Yousef: "rework /crew to move off of the /team model"): a normal yAI Code chat, plan and all, that
// commissions its own background agents for work it wants done on the side: building a separate piece, QA, or tests.
// They run as their own processes (index.js --stdio, like /team's agents), show up under the plan in the panel, and
// report back to the chat. A watcher looks over the chat and the background agents every 20 s and steps in when one
// is going round in circles: an instruction that can block what it keeps doing, and for a background agent one
// takeover (a fresh agent on Ultra Flash with a hand-over) before it's left for you.
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

module.exports = function createCrew({ state, root, ui, X, ctx }) {
  const { c } = ui;
  const agents = []; // { name, task, files, role, model, state, step, started, ended, cost, child, send, text, log, kept, ... }
  let watchTimer = null, tickTimer = null, watching = false;
  const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
  const row1 = (x) => String(x ?? "").replace(/\s+/g, " ").trim();
  const secs = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`);
  const money = (x) => (!x ? "" : x < 0.001 ? "<$0.001" : `$${x.toFixed(3)}`);
  const has = (id) => state.models.some((m) => m.id === id);
  const FLASH = () => ["deepseek-v4.1-flash", "deepseek-v4-pro"].find(has) || state.model;
  const LITE = () => (has("glm-4.7-flash") ? "glm-4.7-flash" : FLASH());
  const label = (id) => (state.models.find((m) => m.id === id)?.label || id || "").replace(/^yAI\s+/, "");
  // the crew log: { at, from, to, text, tone }
  const feed = [];
  function say(from, to, text, tone = "") {
    feed.push({ at: Date.now(), from, to, text: row1(text), tone });
    if (feed.length > 300) feed.splice(0, 100);
    try { ui.screen?.render?.(); } catch {}
  }
  const working = () => agents.filter((a) => ["starting", "working"].includes(a.state));

  // ---------- on and off ----------
  function start() {
    if (state.crewActive) return;
    state.crewActive = true;
    ctx.crew = ctx.crew || { open: new Set(), reports: [] };
    clearInterval(watchTimer);
    watchTimer = setInterval(watch, 20000);
    clearInterval(tickTimer); tickTimer = setInterval(tick, 1000); // the times in the panel move
    try { ui.screen?.onClick?.((text) => { clickRow(text); }); } catch {}
  }
  function stop() {
    state.crewActive = false;
    if (viewing) close();
    try { ui.screen?.onClick?.(null); } catch {}
    clearInterval(watchTimer); watchTimer = null; clearInterval(tickTimer); tickTimer = null;
    for (const a of agents) { try { a.child?.stdin.end(); } catch {} try { a.kept?.child.stdin.end(); } catch {} }
    agents.length = 0;
    if (ctx.crew) { ctx.crew.open.clear(); ctx.crew.reports.length = 0; }
  }

  // ---------- briefs ----------
  const RULES = "Don't commit, push or change git history, don't install packages, and don't start servers that keep running. Delete any scratch or debug files you make before you finish.";
  const ROLE = {
    researcher: () => [
      "Your job: research the topic before the main agent builds anything, quickly: it waits for you, so aim for about 3 minutes. Search the web (web_search, then web_fetch 3 to 5 of the best sources) for:",
      "- the topic itself: what it is, how it works, its rules, mechanics and the real numbers behind them (speeds, sizes, timings, formulas);",
      "- how it is usually built: the techniques and algorithms people use for it, and the mistakes that commonly go wrong;",
      "- what a great version needs: what users or players expect, and what makes amateur versions feel unfinished.",
      'Then write RESEARCH.md in three short parts: "## The topic" (key facts and numbers), "## How it\'s built" (the approach and the pitfalls), and "## Checklist" (15 to 40 numbered requirements, most important first, each one line with how to check it). Write only RESEARCH.md; no code. If a source refuses you (403), move on to another; don\'t retry it. If web search itself fails or finds nothing twice, stop searching and write RESEARCH.md from what you already know, saying at the top that it is from memory.',
      "End with a short report: the 5 facts and the 5 requirements that matter most.",
    ],
    builder: (a) => [
      "Your job, as the main agent described it:", a.task, "",
      a.files.length ? `Files you own (create and change only these; read anything else you need): ${a.files.join(", ")}.` : "Change only what your job needs.",
      "Do exactly this job, with the names, interface and formats it gives. Check your work (a syntax check, check_page or page_eval if it shows on a page). If something is unclear, make the most sensible choice and say so.",
      "End with a short report: what you made, the names other code should call, and anything left undone.",
    ],
    qa: (a) => [
      "Your job: quality-check the project for the main agent. Its focus:", a.task, "",
      "Read the core files whole, then walk through a session the way a user or player would: what breaks, freezes, does nothing, feels wrong, or doesn't match the request? Confirm what you suspect with check_page, page_eval or the tests. Don't change the app's code: the main agent fixes it from your report.",
      "End with a short report: every real problem worst first, each with its file, line, what's wrong and how to fix it.",
    ],
    tester: (a) => [
      "Your job: write and run tests for the main agent. What to test:", a.task, "",
      "Write tests only in test files (tests/, test/, *.test.*), with the project's runner or the language's built-in one (node --test), without installing anything, and run them. If a test fails because of a bug in the app, don't fix the app: report it.",
      "End with a short report: the command you ran, what passed, and every failure with its file and line.",
    ],
  };
  const brief = (a) => [`You are a background agent working for the main agent in a yAI Code session. The overall task is: ${clip(state.crewTask || "", 1500)}`, "", ...ROLE[a.role](a), "", RULES].join("\n");

  // ---------- commissioning ----------
  // spec: { name, task, files, model: "lite" | "flash", role: "builder" | "qa" | "tester" }
  function commission(spec) {
    const name = row1(spec.name).slice(0, 30) || "helper";
    ctx.crew = ctx.crew || { open: new Set(), reports: [] };
    // a follow-up to one that has finished: the same agent wakes up, in its own conversation
    const earlier = agents.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.kept);
    if (earlier && reawaken(earlier, spec.task)) return say("main", earlier.name, `follow-up: ${spec.task}`);
    if (working().length >= (state.crewMax || 4)) return report(name, `(not started: ${state.crewMax || 4} background agents are already working; do it yourself, or wait for one with crew_wait)`);
    const role = ["qa", "tester", "researcher"].includes(spec.role) ? spec.role : "builder";
    const model = spec.model === "lite" ? LITE() : FLASH();
    const a = { name, task: String(spec.task || "").trim(), files: (spec.files || []).map(String).filter((p) => p && !p.includes("..")), role, model, state: "starting", step: "starting", started: Date.now(), cost: 0, text: [], log: [], changed: new Set(), defied: 0 };
    agents.push(a);
    say("main", a.name, `${a.role !== "builder" ? `(${a.role}) ` : ""}${a.task}`);
    spawnAgent(a, brief(a));
  }
  function spawnAgent(a, firstPrompt) {
    const child = spawn(process.execPath, [path.join(__dirname, "index.js"), "--stdio"], {
      cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, YAI_TEAM_AGENT: "1", YAI_MCP_READONLY: "1", YAI_THEME: "dark", YAI_COLUMNS: "1000", YAI_MAX_STEPS: "100000", YAI_TRIM_TOKENS: a.role === "builder" ? "48000" : "80000",
        ...(a.role === "builder" && a.files.length && { YAI_OWN_FILES: JSON.stringify(a.files) }), ...(a.role !== "builder" && { YAI_SAFE_CHECKS: "1" }) },
    });
    a.child = child;
    a.send = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n"); } catch {} };
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (a.child !== child) return;
      let e; try { e = JSON.parse(line); } catch { return; }
      if (e.type === "ready") { a.send({ type: "mode", mode: "acceptEdits" }); if (e.model !== a.model) a.send({ type: "model", id: a.model }); a.send({ type: "prompt", text: firstPrompt }); }
      else if (e.type === "busy") { a.state = "working"; a.lastMove = Date.now(); }
      else if (e.type === "step") { a.step = `${e.verb} ${e.arg}`.trim(); a.lastMove = Date.now(); a.log.push(`- ${e.verb} ${clip(String(e.arg || ""), 120)}`); seen(a, "", `${c.accent("•")} ${c.bold(c.ink(e.verb))} ${c.dim(String(e.arg || ""))}`); }
      else if (e.type === "step-result") { a.log.push(`    → ${clip(row1(e.summary || e.text), 100)}`); seen(a, `   ${c.faint("└")} ${c.dim(clip(row1(e.summary || e.text), 160))}`); }
      else if (e.type === "diff" && e.path) { a.changed.add(e.path); seen(a, `   ${c.green("✎")} ${c.ink(e.path)}`); }
      else if (e.type === "text-start") a.text = [];
      else if (e.type === "text") { a.text.push(e.line); seen(a, `   ${c.ink(e.line)}`); }
      else if (e.type === "out" && String(e.text || "").trim()) for (const l of String(e.text).replace(/\n$/, "").split("\n").slice(-6)) seen(a, `     ${c.faint(clip(l, 160))}`);
      else if (e.type === "progress") { if (e.cost != null) a.cost = (a.costPrev || 0) + e.cost; }
      else if (e.type === "error") { a.error = e.message; seen(a, `   ${c.red("✕")} ${c.ink(row1(e.message))}`); }
      else if (e.type === "repeat-text") { a.repeats = Number(e.count) || (a.repeats || 0) + 1; if (a.repeats >= 4) takeover(a, `It kept writing the same reasoning (${a.repeats} times) without acting.`); }
      else if (e.type === "flip") { a.flips = (a.flips || 0) + 1; if (a.flips >= 3) takeover(a, `It kept changing ${e.path} back and forth.`); }
      else if (e.type === "note" && /not run|not read again/.test(String(e.text || ""))) a.refused = (a.refused || 0) + 1;
      else if ((e.type === "directive-ignored" || e.type === "directive-defied") && ++a.defied >= 2) takeover(a, "It ignored the watcher's instructions.");
      if (a.log.length > 200) a.log.splice(0, 100);
      redraw(); // the panel shows the change now, not at your next keypress
      if (e.type === "done" && a.state === "working") {
        if (a.replacing) return; // stopped for a takeover: the new agent reports instead
        a.cost = (a.costPrev || 0) + (e.cost?.session || 0);
        a.state = a.userStopped || a.stuck ? "stopped" : a.error ? "failed" : "done";
        a.ended = Date.now();
        // it stays open, idle, for a follow-up (reawaken); the crew closes it when it stops
        a.kept = a.state === "done" ? { child } : null;
        if (!a.kept) try { child.stdin.end(); } catch {}
        // a researcher that ended without its notes: the chat is told so, plainly
        if (a.role === "researcher" && !require("fs").existsSync(path.join(root, "RESEARCH.md"))) a.text.unshift("(It wrote no RESEARCH.md: its research got nowhere, most likely because web search failed. Work from what you know.)");
        a.onDone?.(); a.onDone = null;
        report(a.name, `(${a.state}${a.error ? `: ${row1(a.error)}` : ""}; files changed: ${a.changed.size ? [...a.changed].join(", ") : "none"})\n${(a.text.join("\n").trim() || "(no report)").slice(-3000)}`);
      }
    });
    child.on("exit", () => { if (a.child === child && ["starting", "working"].includes(a.state)) { a.state = "failed"; a.ended = Date.now(); report(a.name, "(failed: its process ended)"); } });
  }
  // its report goes to the main chat: with a step's result, or at the start of its next turn
  function report(name, text) {
    say(name, "main", text.replace(/^\([^)]*\)\s*/, (m) => (/stopped|failed/.test(m) ? m : "")).split("\n").find((l) => l.trim()) || text, /failed|stopped/.test(text.slice(0, 40)) ? "bad" : "");
    ctx.crew.open.delete(name);
    ctx.crew.reports.push({ name, report: text });
  }
  function reawaken(a, task) {
    const child = a.kept?.child;
    if (!child || child.exitCode !== null) return false;
    a.kept = null;
    Object.assign(a, { state: "working", step: "a follow-up", lastMove: Date.now(), ended: 0, text: [], error: "" });
    a.send({ type: "prompt", text: `The main agent has a follow-up for you:\n${task}\n\nYour earlier work is above. Do this, check it, and end with a short report as before.` });
    return true;
  }
  // one takeover per agent: a fresh one on Ultra Flash with a hand-over; the second time it's stopped and reported
  function takeover(a, why) {
    if (a.replacing || !["starting", "working"].includes(a.state)) return;
    if (a.isTakeover) {
      a.stuck = true;
      a.send({ type: "stop" });
      ui.note(`${c.yellow("!")} ${c.ink(`${a.name} is stuck again after a takeover, so it was stopped.`)}`);
      return;
    }
    a.replacing = true;
    a.send({ type: "stop" });
    const old = a.child;
    setTimeout(() => { try { old.stdin.end(); old.kill(); } catch {} }, 1500);
    const handover = [`You are taking over this job from a background agent that got stuck, so the watcher stopped it. Why: ${why}`, `It changed: ${a.changed.size ? [...a.changed].join(", ") : "nothing yet"}. Its last steps:`, ...a.log.slice(-20), "Don't repeat its loop: read the current files, decide what's actually wrong, say what you expect each change to do, and finish the job.", "", "---", ""].join("\n");
    Object.assign(a, { replacing: false, isTakeover: true, model: FLASH(), state: "starting", step: "taking over", started: Date.now(), costPrev: a.cost, text: [], log: [], defied: 0 });
    say("watcher", a.name, `took over: ${why}`, "warn");
    ui.note(`${c.yellow("!")} ${c.ink(`The watcher took over from ${a.name}`)} ${c.dim(`· ${why}`)}`);
    spawnAgent(a, handover + brief(a));
  }

  // ---------- watching one: its transcript in the conversation's place ----------
  let viewing = null, prevHook = null;
  function seen(a, ...lines) {
    (a.view ||= []).push(...lines);
    if (a.view.length > 1500) a.view.splice(0, 500);
    if (viewing === a) try { ui.screen?.render?.(); } catch {}
  }
  function open(a) {
    if (!a) return;
    if (a === "LOG" && !feed.length) return;
    if (!viewing) { prevHook = state.keyHook; state.keyHook = (s, key) => { if (key?.name === "left") { close(); return true; } /* ← back: Esc stops the chat (2026-10-23) */ return prevHook ? prevHook(s, key) : false; }; }
    viewing = a;
    try { ui.screen?.toBottom?.(); ui.screen?.render?.(); } catch {}
  }
  function close() {
    viewing = null;
    state.keyHook = prevHook; prevHook = null;
    try { ui.screen?.toBottom?.(); ui.screen?.render?.(); } catch {}
  }
  const who = (n) => (n === "main" ? c.accent("main") : n === "watcher" ? c.yellow("watcher") : n === "you" ? c.red("you") : c.ink(n));
  const logLine = (m, w, full) => {
    const t = new Date(m.at), hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    const text = m.tone === "bad" ? c.red(m.text) : m.tone === "warn" ? c.ink(m.text) : c.dim(m.text);
    return `${c.faint(hm)} ${who(m.from)} ${c.faint("→")} ${who(m.to)}: ${full ? text : clip(m.text, Math.max(20, w * 2 - 20))}`;
  };
  function viewLines(w) {
    if (!viewing) return null;
    if (viewing === "LOG") return [c.bold(c.ink("Crew log")) + c.faint("  · the chat, its background agents and the watcher"), c.faint("← to go back to the chat"), c.line("─".repeat(Math.max(10, w - 2))), ...(feed.length ? feed.flatMap((m) => ["", logLine(m, w, true)]) : [c.dim("   Nothing yet.")])];
    const a = viewing;
    const head = `${c.bold(c.ink(a.name))}${a.role !== "builder" ? c.faint(` · ${a.role}`) : ""} ${c.faint(`· ${label(a.model)} · ${a.state} · ${secs((a.ended || Date.now()) - a.started)}${a.cost ? ` · ${money(a.cost)}` : ""}`)}`;
    return [head, c.faint(clip(`Its job: ${row1(a.task)}`, w * 2)), c.faint("← to go back to the chat"), c.line("─".repeat(Math.max(10, w - 2))), ...(a.view?.length ? a.view : [c.dim("   Starting…")])];
  }
  // a click on a row of the panel: the background agent whose name is on it
  function clickRow(text) {
    const side = String(text).split("│").pop();
    if (/Crew log/.test(side)) { open("LOG"); return true; }
    const a = [...agents].sort((x, y) => y.name.length - x.name.length).find((x) => side.includes(x.name));
    if (a) open(a);
    return !!a;
  }

  // ---------- the panel: the background agents under the plan ----------
  function panelLines(w) {
    if (!agents.length) return [];
    const out = ["", c.bold(c.ink("Background agents")) + c.faint("  click one to watch it"), c.line("━".repeat(w))];
    for (const a of agents) {
      const icon = a.state === "done" ? c.green("✓") : a.state === "failed" || a.stuck ? c.red("✕") : a.state === "stopped" ? c.yellow("■") : c.accent("◐");
      const meta = [label(a.model), secs((a.ended || Date.now()) - a.started), money(a.cost)].filter(Boolean).join(" · ");
      out.push(`${icon} ${c.ink(clip(a.name, w - 4))}${a.role !== "builder" ? c.faint(` ${a.role}`) : ""}`);
      out.push(`  ${c.faint(clip(meta, w - 2))}`);
      if (["starting", "working"].includes(a.state)) out.push(`  ${c.dim(clip(a.step || "", w - 2))}`);
    }
    if (feed.length) {
      out.push("", c.bold(c.ink("Crew log")) + c.faint("  click for all"), c.line("━".repeat(w)));
      for (const m of feed.slice(-6)) out.push(...wrapIn(logLine(m, w, false), w).slice(0, 2));
    }
    return out;
  }
  function wrapIn(line, w) {
    const plain = ui.stripAnsi ? ui.stripAnsi(line) : line.replace(/\x1b\[[0-9;]*m/g, "");
    if (plain.length <= w) return [line];
    // broken at a space, so no word is cut in two; the second row ends with … if there's more
    const cut = plain.lastIndexOf(" ", w) > w / 2 ? plain.lastIndexOf(" ", w) : w;
    return [plain.slice(0, cut), "  " + clip(plain.slice(cut).trim(), w - 2)].map((l, i) => (i ? c.dim(l) : l));
  }
  const count = () => agents.length;

  // ---------- the watcher ----------
  const WATCH_SYSTEM = [
    "You supervise a coding session: a main agent working with the user, and background agents it commissioned. Every 20 seconds you see each one's recent steps, newest last.",
    "You are only shown agents that yAI's own counters flagged (the same step again and again, a file changed back and forth, the same reasoning written again), with the evidence. Step in only if the steps show a loop that is really wasting time; if the agent has since moved on, or the repeats are reasonable (checking after real changes), take no action.",
    "Be brief and specific: one or two sentences on what to do instead. Most of the time the right answer is no action.",
    "Reply with JSON only: {\"actions\":[{\"agent\":\"main\" or \"<background agent name>\",\"message\":\"<one or two plain sentences: what to do instead>\",\"block\":[optional: \"check_page\", \"page_eval\", \"run\", \"read:<path>\" or \"edits-only\"],\"steps\":<how long the block lasts, default 8>}]}. An empty list is fine.",
  ].join("\n");
  // what yAI's own counters show: the same step 3 or more times in the last 12, flip-flops, repeated reasoning, refusals
  const sameSteps = (lines) => { const n = {}; for (const l of lines.slice(-12)) { const k = l.replace(/\s*→.*$/, "").trim(); if (k.startsWith("-")) n[k] = (n[k] || 0) + 1; } return Math.max(0, ...Object.values(n)); };
  const evidence = (x) => {
    const parts = [];
    const same = sameSteps(x.lines);
    if (same >= 3) parts.push(`the same step ${same} times in its last 12`);
    if ((x.flips || 0) >= 2) parts.push(`changed a file back and forth ${x.flips} times`);
    if ((x.repeats || 0) >= 2) parts.push(`wrote the same reasoning ${x.repeats} times`);
    if ((x.refused || 0) >= 3) parts.push(`${x.refused} steps refused as repeats`);
    return parts;
  };
  const COOLDOWN = 180000; // between two instructions to the same agent
  async function watch() {
    if (watching || !state.crewActive || state.interrupted) return;
    const mainLines = state.busy && state.crewSteps?.length ? state.crewSteps.slice(-20) : [];
    const mainEvidence = mainLines.length && Date.now() - (state.crewMainNoted || 0) > COOLDOWN ? evidence({ lines: mainLines, flips: ctx.flips ? [...ctx.flips.values()].reduce((s, n) => s + n, 0) : 0 }) : [];
    const main = mainEvidence.length ? mainLines : [];
    const busy = working().filter((a) => a.log.length >= (a.watchedAt || 0) + 2 && Date.now() - (a.notedAt || 0) > COOLDOWN && evidence({ lines: a.log, flips: a.flips, repeats: a.repeats, refused: a.refused }).length);
    if (!main.length && !busy.length) return;
    watching = true;
    try {
      const parts = [
        ...(main.length ? [`## main (the session itself)\nFlagged: ${mainEvidence.join("; ")}\nIts plan: ${state.plan ? state.plan.steps.map((s, i) => `${i + 1}. ${clip(s, 80)}`).join(" ") : "(none)"}\nRecent steps:\n${main.join("\n")}`] : []),
        ...busy.map((a) => `## ${a.name} (${a.role}), working for ${secs(Date.now() - a.started)}\nFlagged: ${evidence({ lines: a.log, flips: a.flips, repeats: a.repeats, refused: a.refused }).join("; ")}\nIts job: ${clip(row1(a.task), 300)}\nRecent steps:\n${a.log.slice(-20).join("\n")}`),
      ];
      const out = await X.oneShot({ model: FLASH(), system: WATCH_SYSTEM, messages: [{ role: "user", content: `The task: ${clip(state.crewTask || "", 800)}\n\n${parts.join("\n\n")}` }] });
      for (const a of busy) a.watchedAt = a.log.length;
      let acts = [];
      try { acts = JSON.parse((/\{[\s\S]*\}/.exec(out) || ["{}"])[0]).actions || []; } catch {}
      for (const act of acts.slice(0, 3)) {
        const msg = row1(act.message); if (!msg) continue;
        const block = (Array.isArray(act.block) ? act.block : []).map(String).filter((b) => /^(check_page|page_eval|run|search|read_file|edits-only|read:.+)$/.test(b)).slice(0, 4);
        const steps = Number(act.steps) || 8;
        if (String(act.agent).toLowerCase() === "main") {
          if (!state.busy || !main.length) continue;
          state.crewMainNoted = Date.now();
          state.crewMainNotes = (state.crewMainNotes || 0) + 1;
          say("watcher", "main", msg, "warn");
          (state.directives ||= []).push({ text: msg, block: state.crewMainNotes > 1 ? block : [], steps });
          ui.note(`${c.accent("◆")} ${c.ink("The watcher:")} ${c.dim(msg)}`);
        } else {
          const a = busy.find((x) => x.name === act.agent);
          if (!a) continue;
          a.notedAt = Date.now(); a.notes = (a.notes || 0) + 1;
          say("watcher", a.name, msg, "warn");
          a.send({ type: "directive", text: msg, block: a.notes > 1 ? block : [], steps });
        }
      }
    } catch {} finally { watching = false; }
  }
  // the panel shows times that move
  // (the screen redraws itself only for this chat's own output: 2026-10-23, the panel sat still until a click)
  function tick() { if (working().length) try { ui.screen?.render?.(); } catch {} }
  let drawSoon = null;
  function redraw() { if (drawSoon) return; drawSoon = setTimeout(() => { drawSoon = null; try { ui.screen?.render?.(); } catch {} }, 200); }

  // the researcher /crew starts with: it shows in the panel, and the main chat starts once it's done (10 min at most)
  function research() {
    ctx.crew = ctx.crew || { open: new Set(), reports: [] };
    ctx.crew.open.add("researcher");
    commission({ name: "researcher", role: "researcher", model: "flash", task: "Research the task above.", files: ["RESEARCH.md"] });
    const a = agents.find((x) => x.name === "researcher" && ["starting", "working"].includes(x.state));
    if (!a) return Promise.resolve();
    return new Promise((done) => {
      const t = setTimeout(done, 300000); // 5 min at most: then the chat starts with what RESEARCH.md has, and the report comes later
      a.onDone = () => { clearTimeout(t); done(); };
      const iv = setInterval(() => { if (!state.crewActive || state.interrupted) { clearInterval(iv); clearTimeout(t); done(); } else if (!["starting", "working"].includes(a.state)) clearInterval(iv); }, 500);
    });
  }

  // Esc: every background agent still working stops (they show as stopped, and the chat is told)
  function stopAll() {
    if (working().length) say("you", "all", "stopped the background agents", "bad");
    for (const a of working()) { a.userStopped = true; a.send({ type: "stop" }); }
    try { ui.screen?.render?.(); } catch {}
  }

  return { start, stop, stopAll, commission, research, panelLines, viewLines, clickRow, close, viewing: () => !!viewing, count, working: () => working().length };
};
