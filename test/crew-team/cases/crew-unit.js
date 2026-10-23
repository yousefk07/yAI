"use strict";
// cli/crew.js required directly: the panel, the agent view, clicks, the watcher, takeovers, snapshot and restore
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { suite, T, fakeServer, project, crewKit, until, sleep, strip } = require("../lib/harness");

process.env.YAI_CREW_WATCH_MS = "700"; // the watcher looks every 0.7 s here, not every 20 s
const brief = "Write js/a.js with window.A = 1 and nothing else, then check it with node --check.";

async function kit(ctl, handler, opts = {}) {
  const srv = await fakeServer(handler);
  const root = project(opts.name || "crew-unit", opts.files || {});
  const k = crewKit({ url: srv.url, root, oneShot: opts.oneShot });
  ctl.cleanup(() => srv.close());
  ctl.cleanup(() => { try { k.CREW.stop(); } catch {} });
  if (opts.mode) k.state.mode = opts.mode;
  k.CREW.start();
  return { ...k, srv, root };
}
const plain = (lines) => lines.map(strip);
const stateOf = (k, name) => k.CREW.snapshot()?.agents.find((a) => a.name === name)?.state;

suite(__filename, [
  { name: "the panel draws at any width without throwing", fn: async (ctl) => {
    const k = await kit(ctl, () => ({ text: "working ".repeat(500), chunk: 20, delay: 30 }));
    k.CREW.commission({ name: "a rather long background agent name", task: brief, files: ["js/a.js"], model: "flash" });
    await sleep(300);
    for (const w of [-5, 0, 1, 2, 5, 9, 20, 32, 40, 200, NaN, undefined]) {
      const lines = k.CREW.panelLines(w);
      assert.ok(Array.isArray(lines) && lines.length >= 4, `width ${w}`);
      if (w > 5) for (const l of plain(lines)) assert.ok(l.length <= Math.max(w, 2) + 2, `width ${w}: "${l}" is ${l.length} long`);
    }
  } },
  { name: "the agent view and the crew log draw at any width", fn: async (ctl) => {
    const k = await kit(ctl, () => "Done.");
    k.CREW.commission({ name: "viewme", task: brief, files: ["js/a.js"] });
    await until(() => stateOf(k, "viewme") === "done", 15000, "the agent to finish");
    assert.ok(k.CREW.clickRow("text │ viewme"), "a click on its row opens it");
    for (const w of [-3, 0, 1, 10, 80, 300]) assert.ok(k.CREW.viewLines(w).length > 3);
    k.state.keyHook("", { name: "left" });
    assert.strictEqual(k.CREW.viewLines(80), null, "← goes back to the chat");
    assert.ok(k.CREW.clickRow("x │ Crew log  click for all"));
    assert.match(plain(k.CREW.viewLines(80)).join("\n"), /Crew log/);
    for (const w of [0, 5]) k.CREW.viewLines(w);
    k.CREW.close();
  } },
  { name: "a click on 'waiting for you' opens the agent that asks; y answers it", fn: async (ctl) => {
    const k = await kit(ctl, (r) => (r.who === "helper" ? [T("run", { command: "node -e \"console.log('clicked-yes')\"" }), "Ran it."][r.turn] ?? "Done." : "Done."));
    k.CREW.commission({ name: "asker", task: brief, files: ["js/a.js"] });
    await until(() => k.CREW.waiting().length, 15000, "the question");
    const row = plain(k.CREW.panelLines(40)).find((l) => /waiting for you/.test(l));
    assert.ok(row, "the panel says it's waiting for you");
    assert.ok(k.CREW.clickRow("chat │ " + row));
    assert.ok(k.CREW.asking());
    assert.strictEqual(k.state.keyHook("y", { name: "y" }), true);
    await until(() => k.srv.of("helper").some((r) => /clicked-yes/.test(r.all)), 15000, "the command to run");
  } },
  { name: "n refuses the question, and the agent is told", fn: async (ctl) => {
    const k = await kit(ctl, (r) => (r.who === "helper" ? [T("run", { command: "node -e \"console.log(1)\"" }), "OK, not run."][r.turn] ?? "Done." : "Done."));
    k.CREW.commission({ name: "asker", task: brief, files: ["js/a.js"] });
    await until(() => k.CREW.waiting().length, 15000, "the question");
    k.CREW.clickRow("│ asker");
    k.state.keyHook("n", { name: "n" });
    await until(() => stateOf(k, "asker") === "done", 15000, "the agent to end");
    assert.strictEqual(k.srv.of("helper").length, 1, "a refusal with no reason ends its request");
  } },
  { name: "yolo: a question already waiting is allowed when the mode changes", fn: async (ctl) => {
    const k = await kit(ctl, (r) => (r.who === "helper" ? [T("run", { command: "node -e \"console.log('synced')\"" }), "Ran it."][r.turn] ?? "Done." : "Done."));
    k.CREW.commission({ name: "asker", task: brief, files: ["js/a.js"] });
    await until(() => k.CREW.waiting().length, 15000, "the question");
    k.state.mode = "yolo";
    k.CREW.syncMode();
    await until(() => k.srv.of("helper").some((r) => /synced/.test(r.all)), 15000, "the command to run");
  } },
  { name: "an agent woken for a follow-up gets the chat's mode as it is now", fn: async (ctl) => {
    const k = await kit(ctl, (r) => (r.who === "helper" ? (r.turn === 0 ? "Made it." : r.turn === 1 ? T("run", { command: "node -e \"console.log('woken-ran')\"" }) : "Ran it.") : "Done."));
    k.CREW.commission({ name: "worker", task: brief, files: ["js/a.js"] });
    await until(() => stateOf(k, "worker") === "done", 15000, "the first job");
    k.state.mode = "yolo"; k.CREW.syncMode();
    k.CREW.commission({ name: "worker", task: "Now run node -e to print woken-ran and report it." });
    await until(() => k.srv.of("helper").some((r) => /woken-ran/.test(r.all)), 15000, "the follow-up's command to run without a question");
    await until(() => stateOf(k, "worker") === "done", 15000, "the follow-up to end");
    assert.strictEqual(k.CREW.waiting().length, 0);
    assert.strictEqual(k.ctx.crew.reports.length, 2, "two reports, one per job");
  } },
  { name: "the same reasoning 4 times: the watcher takes over with a fresh agent on Ultra Flash", ms: 60000, fn: async (ctl) => {
    const why = "The atlas is two hundred and fifty six pixels wide so each tile is sixteen pixels and the uv mapping uses the tile index times one sixteenth which should be correct for every block face";
    const k = await kit(ctl, (r) => (r.who === "helper" ? `${why} (${r.turn})\n${T("write_file", { path: `js/t${r.turn}.txt`, content: String(r.turn) })}` : r.who === "takeover" ? "Took over and finished." : "Done."), { files: {} });
    k.CREW.commission({ name: "looper", task: brief, files: ["js/a.js"], model: "lite" });
    await until(() => k.srv.of("takeover").length, 30000, "the takeover agent");
    assert.strictEqual(k.srv.of("takeover")[0].model, "deepseek-v4.1-flash");
    assert.match(k.srv.of("takeover")[0].all, /kept writing the same reasoning/);
    await until(() => stateOf(k, "looper") === "done", 15000, "the takeover to finish");
    assert.match(k.ctx.crew.reports.map((r) => r.report).join("\n"), /Took over and finished/);
    assert.strictEqual(k.ctx.crew.reports.length, 1, "one report, from the takeover");
  } },
  { name: "stuck again after a takeover: stopped and left for you", ms: 60000, fn: async (ctl) => {
    const why = "The atlas is two hundred and fifty six pixels wide so each tile is sixteen pixels and the uv mapping uses the tile index times one sixteenth which should be correct for every block face";
    const k = await kit(ctl, (r) => (["helper", "takeover"].includes(r.who) ? `${why} (${r.turn})\n${T("write_file", { path: `js/t${r.turn}.txt`, content: String(r.turn) })}` : "Done."));
    k.CREW.commission({ name: "looper", task: brief, files: ["js/a.js"] });
    await until(() => stateOf(k, "looper") === "stopped", 40000, "it to be stopped");
    assert.ok(k.notes().some((n) => /stuck again after a takeover/.test(n)));
    assert.match(k.ctx.crew.reports[0].report, /^\(stopped/);
  } },
  { name: "the watcher is only asked about flagged agents, and its message reaches the agent", ms: 60000, fn: async (ctl) => {
    const asked = [];
    const k = await kit(ctl, (r) => {
      if (r.who !== "helper") return "Done.";
      if (/INSTRUCTION FROM yAI/.test(r.all) && !/watcher said, earlier/.test(r.all)) return "Following the watcher: writing it now.\n" + T("write_file", { path: "js/a.js", content: "window.A = 1;" });
      if (/Following the watcher|watcher said, earlier/.test(r.all)) return "Done: made js/a.js.";
      return T("read_file", { path: "data.txt" + ":".repeat(0) + (r.turn % 2 ? "" : "") }) + "";
    }, { files: { "data.txt": "x" }, oneShot: async (o) => { asked.push(o); return JSON.stringify({ actions: [{ agent: "reader", message: "Stop reading data.txt; write js/a.js now.", block: ["read_file"], steps: 4 }] }); } });
    k.CREW.commission({ name: "reader", task: brief, files: ["js/a.js"] });
    await until(() => asked.length, 30000, "the watcher to be asked");
    assert.match(asked[0].messages[0].content, /## reader/);
    assert.ok(asked[0].signal, "the watcher's request has a time limit");
    await until(() => stateOf(k, "reader") === "done", 30000, "the agent to finish");
    assert.ok(k.srv.of("helper").some((r) => /INSTRUCTION FROM yAI/.test(r.all) && /Stop reading data\.txt/.test(r.all)));
    assert.ok(!k.srv.of("helper").some((r) => /Blocked for your next/.test(r.all)), "the first instruction to an agent blocks nothing");
  } },
  { name: "an agent that isn't flagged is never sent to the watcher", ms: 30000, fn: async (ctl) => {
    const asked = [];
    const k = await kit(ctl, (r) => (r.who === "helper" ? (r.turn < 8 ? T("write_file", { path: `js/f${r.turn}.js`, content: `window.F${r.turn} = ${r.turn};` }) : "Done.") : "Done."), { oneShot: async (o) => { asked.push(o); return '{"actions":[]}'; } });
    k.CREW.commission({ name: "steady", task: brief, files: [] });
    await until(() => stateOf(k, "steady") === "done", 20000, "the agent to finish");
    await sleep(1500);
    assert.strictEqual(asked.length, 0);
  } },
  { name: "ignoring the watcher twice hands the job over", ms: 60000, fn: async (ctl) => {
    const k = await kit(ctl, (r) => {
      if (r.who === "takeover") return "Finished it properly.";
      if (r.who !== "helper") return "Done.";
      return `Still looking.\n${T("search", { pattern: "x" + (r.turn % 3) })}`;
    }, { files: { "data.txt": "x" } });
    k.CREW.commission({ name: "deaf", task: brief, files: ["js/a.js"] });
    await until(() => k.srv.of("helper").length >= 1, 10000, "it to start");
    const a = () => k.CREW.snapshot().agents.find((x) => x.name === "deaf");
    // two directives it won't acknowledge
    for (let i = 0; i < 2; i++) {
      const sent = k.srv.of("helper").length;
      // (through the crew's own send: what the watcher does)
      k.CREW.agent("deaf").send({ type: "directive", text: "Stop searching; write js/a.js.", block: [], steps: 3 });
      await until(() => k.srv.of("helper").length >= sent + 2 || k.srv.of("takeover").length, 10000, "two more steps");
    }
    await until(() => k.srv.of("takeover").length, 20000, "the takeover");
    assert.ok(a());
  } },
  { name: "snapshot and restore: finished agents come back as they were, working ones start again, read-only stays read-only", ms: 60000, fn: async (ctl) => {
    const k = await kit(ctl, (r) => (r.who === "proposer" ? [T("write_file", { path: "hack.txt", content: "should not be written" }), "POSITION: no."][r.turn] ?? "POSITION: no." : /yAI was closed while you were working/.test(r.all) ? "Picked up and finished." : "Done."));
    const snap = {
      task: "a level viewer", quiet: true, feed: [{ at: Date.now() - 60000, from: "main", to: "levels", text: "Write js/levels.js", tone: "" }],
      agents: [
        { name: "sounds", task: "Make sounds", files: ["js/sfx.js"], role: "builder", model: "glm-4.7-flash", state: "done", started: Date.now() - 90000, ended: Date.now() - 30000, cost: 0.002, changed: ["js/sfx.js"], report: "Made js/sfx.js." },
        { name: "levels", task: "Write js/levels.js with window.LEVELS.", files: ["js/levels.js"], role: "builder", model: "no-such-model", state: "working", started: Date.now() - 50000, cost: 0.001, changed: [], report: "" },
        { name: "side A", task: "Which is better?", files: [], role: "proposer", model: "deepseek-v4-pro", mode: "plan", state: "working", started: Date.now() - 50000, cost: 0, changed: [], report: "" },
      ],
    };
    assert.strictEqual(k.CREW.restore(snap), 2);
    assert.strictEqual(k.state.crewQuiet, true);
    await until(() => stateOf(k, "levels") === "done" && stateOf(k, "side A") === "done", 30000, "both to finish");
    const levels = k.srv.log.find((r) => /js\/levels\.js/.test(r.all));
    assert.match(levels.all, /yAI was closed while you were working/);
    assert.strictEqual(levels.model, "deepseek-v4.1-flash", "a model that's gone falls back to Ultra Flash");
    assert.ok(!fs.existsSync(path.join(k.root, "hack.txt")), "the read-only side couldn't write");
    const again = k.CREW.snapshot();
    assert.strictEqual(again.agents.find((a) => a.name === "side A").mode, "plan");
    assert.strictEqual(again.agents.find((a) => a.name === "sounds").report, "Made js/sfx.js.");
    assert.match(plain(k.CREW.panelLines(40)).join("\n"), /sounds/);
  } },
  { name: "Esc (stopAll) stops every working agent; they report as stopped", ms: 30000, fn: async (ctl) => {
    const k = await kit(ctl, (r) => (r.who === "helper" ? { text: "slowly ".repeat(5000), chunk: 20, delay: 20 } : "Done."));
    k.CREW.commission({ name: "one", task: brief, files: ["js/a.js"] });
    k.CREW.commission({ name: "two", task: brief.replace("a.js", "b.js"), files: ["js/b.js"] });
    await until(() => k.srv.of("helper").length >= 2, 10000, "both working");
    k.CREW.stopAll();
    await until(() => stateOf(k, "one") === "stopped" && stateOf(k, "two") === "stopped", 15000, "both stopped");
    assert.strictEqual(k.ctx.crew.open.size, 0);
  } },
  { name: "an agent whose process dies is reported as failed", ms: 30000, fn: async (ctl) => {
    const k = await kit(ctl, (r) => (r.who === "helper" ? { hang: true } : "Done."));
    k.CREW.commission({ name: "dies", task: brief, files: ["js/a.js"] });
    await until(() => k.srv.of("helper").length, 10000, "it to start");
    // its process ends
    k.CREW.agent("dies").child.kill();
    await until(() => stateOf(k, "dies") === "failed", 10000, "failed");
    assert.match(k.ctx.crew.reports[0].report, /its process ended/);
  } },
  { name: "the crew log keeps at most 300 lines", fn: async (ctl) => {
    const k = await kit(ctl, () => "Done.");
    const snap = { task: "t", feed: Array.from({ length: 290 }, (_, i) => ({ at: Date.now(), from: "main", to: "x", text: `line ${i}`, tone: "" })), agents: [] };
    k.CREW.restore(snap);
    for (let i = 0; i < 30; i++) k.CREW.commission({ name: `n${i}`, task: brief, files: [] });
    k.CREW.stopAll();
    assert.ok(k.CREW.snapshot().feed.length <= 100);
  } },
]);
