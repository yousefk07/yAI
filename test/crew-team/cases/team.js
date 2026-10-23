"use strict";
// /team over --stdio: the lead's split, the picker (as the VS Code panel answers it), the builders, the checks and fixer
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { suite, T, session, ask, until, sleep, strip } = require("../lib/harness");

const TASK = "a node module math.js with add and sub, and cli.js that prints add(2, 3)";
const PLAN = JSON.stringify({ folder: "", contract: "add(a, b) - math.js\nsub(a, b) - math.js", agents: [
  { name: "math", task: "Write math.js exporting add(a, b) and sub(a, b).", files: ["math.js"] },
  { name: "cli", task: "Write cli.js that requires ./math and prints add(2, 3).", files: ["cli.js"] },
] });
const BUILD = {
  math: [T("write_file", { path: "math.js", content: "exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n" }), "Wrote math.js: add and sub."],
  cli: [T("write_file", { path: "cli.js", content: "console.log(require('./math').add(2, 3));\n" }), "Wrote cli.js."],
};
const builderOf = (r) => (/Your feature: Write math\.js/.test(r.text) ? "math" : /Your feature: Write cli\.js/.test(r.text) ? "cli" : "?");
// the picker, answered as the panel would: the role rows on or off, a model per row
async function pick(y, { on = [], models = {}, cancel = false, chat = false } = {}) {
  const p = await y.waitFor((e) => e.type === "team-pick", 30000, "the team picker");
  if (cancel) return y.send({ type: "team-pick-answer", id: p.id, result: null });
  if (chat) return y.send({ type: "team-pick-answer", id: p.id, result: { chat: true } });
  const rows = p.groups.flatMap((g) => g.rows).map((r) => ({ i: r.i, on: r.builder ? true : on.includes(r.label), model: models[r.label] || r.model }));
  y.send({ type: "team-pick-answer", id: p.id, result: { rows, rounds: 1 } });
  return p;
}
async function runTeam(y, opts = {}, text = `/team ${TASK}`) {
  y.send({ type: "mode", mode: opts.mode || "acceptEdits" });
  const from = y.events.length;
  y.send({ type: "command", text });
  const p = await pick(y, opts);
  if (opts.after) await opts.after(p);
  await y.waitFor((e, all) => e.type === "done" && all.indexOf(e) > from && all.slice(from).some((x) => x.type === "busy"), opts.ms || 120000, "the team to finish");
  return p;
}
const plainOut = (y) => y.events.filter((e) => e.type === "out" || e.type === "note").map((e) => strip(e.text)).join("");

suite(__filename, [
  { name: "two builders at once, each on its own files; their reports reach the chat", ms: 120000, fn: async (ctl) => {
    const { y, srv, file } = await session(ctl, (r) => (r.who === "lead" ? PLAN : r.who === "builder" ? BUILD[builderOf(r)]?.[r.turn] ?? "Done." : "Thanks."));
    await runTeam(y);
    assert.match(file("math.js"), /add/);
    assert.match(file("cli.js"), /require/);
    assert.strictEqual(srv.of("builder").filter((r) => r.turn === 0).length, 2);
    await ask(y, "what did the team do?");
    assert.match(srv.log[srv.log.length - 1].text, /I ran \/team/);
    assert.ok(y.events.some((e) => e.type === "team" && e.view), "the board went to the panel");
  } },
  { name: "the model picked for each builder is the one it runs on", ms: 120000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.who === "lead" ? PLAN : r.who === "builder" ? BUILD[builderOf(r)]?.[r.turn] ?? "Done." : "Done."));
    await runTeam(y, { models: { math: "glm-4.7-flash", cli: "deepseek-v4-pro" } });
    const first = srv.of("builder").filter((r) => r.turn === 0);
    assert.strictEqual(first.find((r) => builderOf(r) === "math").model, "glm-4.7-flash");
    assert.strictEqual(first.find((r) => builderOf(r) === "cli").model, "deepseek-v4-pro");
  } },
  { name: "a plan that isn't valid JSON is asked for again, with the error", ms: 120000, fn: async (ctl) => {
    let leads = 0;
    const { y, srv } = await session(ctl, (r) => (r.who === "lead" ? (leads++ === 0 ? "Here's the plan: {agents: [oops" : PLAN) : r.who === "builder" ? BUILD[builderOf(r)]?.[r.turn] ?? "Done." : "Done."));
    await runTeam(y);
    assert.strictEqual(srv.of("lead").length, 2);
    assert.match(srv.of("lead")[1].text, /couldn't be read/);
  } },
  { name: "a lead whose model fails is tried on the next one", ms: 120000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.who === "lead" ? (r.model === "deepseek-v4-pro" ? { status: 500, error: "pro is down" } : PLAN) : r.who === "builder" ? BUILD[builderOf(r)]?.[r.turn] ?? "Done." : "Done."));
    await runTeam(y);
    assert.deepStrictEqual(srv.of("lead").map((r) => r.model), ["deepseek-v4-pro", "deepseek-v4.1-flash"]);
  } },
  { name: "QA finds a problem: the fixer gets its report, yAI re-checks", ms: 150000, fn: async (ctl) => {
    const { y, srv, file } = await session(ctl, (r) => {
      if (r.who === "lead") return PLAN;
      if (r.who === "builder") return BUILD[builderOf(r)]?.[r.turn] ?? "Done.";
      if (r.who === "team-qa") return "Problem: sub is fine but add is missing a test.\nmath.js:1 add has no test.\nVERDICT: PROBLEMS";
      if (r.who === "team-fixer") return [T("write_file", { path: "math.test.js", content: "const m = require('./math');\nif (m.add(2, 3) !== 5) process.exit(1);\nconsole.log('ok');\n" }), T("run", { command: "node math.test.js" }), "Added math.test.js; node math.test.js → ok.\nVERDICT: FIXED"][r.turn] ?? "VERDICT: FIXED";
      return "Done.";
    });
    await runTeam(y, { on: ["qa", "fixer"], mode: "yolo", ms: 140000 });
    const fx = srv.of("team-fixer")[0];
    assert.ok(fx, "the fixer ran");
    assert.match(fx.text, /add has no test/);
    assert.ok(file("math.test.js"));
  } },
  { name: "QA says OK: the fixer isn't needed", ms: 120000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.who === "lead" ? PLAN : r.who === "builder" ? BUILD[builderOf(r)]?.[r.turn] ?? "Done." : r.who === "team-qa" ? "All fits.\nVERDICT: OK" : "Done."));
    await runTeam(y, { on: ["qa", "fixer"] });
    assert.strictEqual(srv.of("team-fixer").length, 0);
  } },
  { name: "a builder's question goes to the panel; No means the command doesn't run", ms: 120000, fn: async (ctl) => {
    const { y, srv, dir } = await session(ctl, (r) => {
      if (r.who === "lead") return PLAN;
      if (r.who === "builder") return builderOf(r) === "math" ? [T("run", { command: "node -e \"require('fs').writeFileSync('ran.txt','1')\"" }), "Tried a command."][r.turn] ?? "Done." : BUILD.cli[r.turn] ?? "Done.";
      return "Done.";
    });
    await runTeam(y, { after: async () => {
      const q = await y.waitFor((e) => e.type === "ask" && /math/.test(e.title || ""), 60000, "the builder's question in the panel");
      y.send({ type: "answer", id: q.id, choice: 2 });
    } });
    assert.ok(!fs.existsSync(path.join(dir, "ran.txt")), "the refused command didn't run");
  } },
  { name: "files in the plan's folder that the plan doesn't use: you're asked, they aren't moved silently", ms: 120000, fn: async (ctl) => {
    const plan = JSON.stringify({ folder: "app", contract: "", agents: [{ name: "math", task: "Write math.js exporting add(a, b) and sub(a, b).", files: ["math.js"] }, { name: "cli", task: "Write cli.js that requires ./math and prints add(2, 3).", files: ["cli.js"] }] });
    const { y, dir } = await session(ctl, (r) => (r.who === "lead" ? plan : r.who === "builder" ? (builderOf(r) === "math" ? [T("write_file", { path: "app/math.js", content: "exports.add=(a,b)=>a+b;" }), "ok"] : [T("write_file", { path: "app/cli.js", content: "1;" }), "ok"])[r.turn] ?? "Done." : "Done."), { files: { "app/old-notes.txt": "mine" } });
    await runTeam(y, { after: async () => {
      const q = await y.waitFor((e) => e.type === "ask" && /What should happen to them/.test(e.title || ""), 30000, "the question about the old files");
      y.send({ type: "answer", id: q.id, choice: 1 }); // keep them
    } });
    assert.strictEqual(fs.readFileSync(path.join(dir, "app", "old-notes.txt"), "utf8"), "mine");
  } },
  { name: "a stop ends the whole team: no more requests, a done", ms: 120000, fn: async (ctl) => {
    let n = 0;
    const { y, srv } = await session(ctl, (r) => (r.who === "lead" ? PLAN : r.who === "builder" ? (n++, { text: "building slowly ".repeat(4000), chunk: 20, delay: 20 }) : "Done."));
    await runTeam(y, { after: async () => { await until(() => n >= 2, 30000, "both builders"); await sleep(300); y.send({ type: "stop" }); }, ms: 60000 });
    const before = srv.log.length;
    await sleep(2000);
    assert.strictEqual(srv.log.length, before, "nothing ran after the stop");
  } },
  { name: "a note from the panel to one agent reaches it with its next step", ms: 120000, fn: async (ctl) => {
    let noted = false;
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "lead") return PLAN;
      if (r.who === "builder") {
        if (builderOf(r) === "cli") return BUILD.cli[r.turn] ?? "Done.";
        if (r.turn < 6) { await sleep(400); return T("write_file", { path: `m${r.turn}.txt`, content: "x" }); }
        return "Done.";
      }
      return "Done.";
    });
    await runTeam(y, { after: async (p) => {
      await until(() => srv.of("builder").filter((r) => builderOf(r) === "math").length >= 2, 30000, "math working");
      const n = p.groups.flatMap((g) => g.rows).findIndex((r) => r.label === "math") + 1;
      y.send({ type: "team-action", action: "note", n, text: "Use tabs, not spaces." });
      noted = true;
    } });
    assert.ok(noted);
    assert.ok(srv.of("builder").some((r) => builderOf(r) === "math" && /A note from the user, sent while you work: Use tabs/.test(r.text)));
    assert.ok(!srv.of("builder").some((r) => builderOf(r) === "cli" && /Use tabs/.test(r.text)), "only that agent got it");
  } },
  { name: "today's allowance running out stops the team and says why", ms: 120000, fn: async (ctl) => {
    const { y } = await session(ctl, (r) => (r.who === "lead" ? PLAN : r.who === "builder" ? { sseError: "You've used today's $2.00 of yAI Ultra; it resets at midnight UTC." } : "Done."));
    await runTeam(y);
    assert.match(plainOut(y), /allowance ran out/);
  } },
  { name: "a builder whose connection keeps failing is restarted, then works", ms: 150000, fn: async (ctl) => {
    let fails = 0;
    const { y, srv, file } = await session(ctl, (r) => {
      if (r.who === "lead") return PLAN;
      if (r.who === "builder" && builderOf(r) === "math" && fails < 4) { fails++; return { status: 503, error: "Service Unavailable" }; }
      if (r.who === "builder") return BUILD[builderOf(r)]?.[r.turn] ?? "Done.";
      return "Done.";
    });
    await runTeam(y, { ms: 140000 });
    assert.match(file("math.js") || "", /add/);
    assert.match(plainOut(y) + JSON.stringify(y.events.filter((e) => e.type === "team").slice(-1)), /math/);
  } },
  { name: "/team in plan mode is refused", fn: async (ctl) => {
    const { y } = await session(ctl, () => "Done.");
    y.send({ type: "mode", mode: "plan" });
    y.send({ type: "command", text: `/team ${TASK}` });
    await y.waitFor((e) => e.type === "out" && /leave plan or tutor mode first/.test(e.text), 15000, "the refusal");
  } },
  { name: "the picker cancelled: nothing runs", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.who === "lead" ? PLAN : "Done."));
    y.send({ type: "command", text: `/team ${TASK}` });
    await pick(y, { cancel: true });
    await y.waitFor((e) => e.type === "out" && /Cancelled/.test(e.text), 15000, "Cancelled");
    assert.strictEqual(srv.of("builder").length, 0);
  } },
  { name: "the picker's 'talk it over': nothing runs, and the plan goes into the next message", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.who === "lead" ? PLAN : "Sure, let's talk."));
    y.send({ type: "command", text: `/team ${TASK}` });
    await pick(y, { chat: true });
    await y.waitFor((e) => e.type === "out" && /Not started/.test(e.text), 15000, "Not started");
    await ask(y, "can we use three agents?");
    assert.match(srv.log[srv.log.length - 1].text, /I want to talk the plan over/);
  } },
  { name: "the team's watcher: a note with a block, then a takeover on Ultra Flash when it goes on looping", ms: 120000, fn: async (ctl) => {
    let watched = 0;
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "lead") return PLAN;
      if (r.who === "team-watcher") { watched++; return JSON.stringify({ actions: [{ agent: "math", do: watched === 1 ? "note" : "takeover", message: "Stop searching; write math.js now.", block: ["search"], steps: 6 }] }); }
      if (r.who === "takeover") return [T("write_file", { path: "math.js", content: "exports.add = (a, b) => a + b;\n" }), "Took over: wrote math.js."][r.turn] ?? "Done.";
      if (r.who === "builder" && builderOf(r) === "math") { await sleep(250); return `Looking.\n${T("search", { pattern: `add${r.turn}` })}`; }
      if (r.who === "builder") return BUILD.cli[r.turn] ?? "Done.";
      return "Done.";
    }, { env: { YAI_TEAM_WATCH_MS: "700" } });
    await runTeam(y, { ms: 110000 });
    assert.ok(srv.of("builder").some((r) => builderOf(r) === "math" && /INSTRUCTION FROM yAI/.test(r.text) && /Blocked for your next 6 steps: no search/.test(r.text)), "the note, with its block");
    const tk = srv.of("takeover");
    assert.ok(tk.length, "the takeover");
    assert.strictEqual(tk[0].model, "deepseek-v4.1-flash");
    assert.match(tk[0].text, /Stop searching; write math\.js now/);
  } },
  { name: "the team's watcher can stop an agent that only re-checks finished work", ms: 120000, fn: async (ctl) => {
    let watched = 0;
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "lead") return PLAN;
      if (r.who === "team-watcher") { watched++; return JSON.stringify({ actions: [{ agent: "math", do: watched === 1 ? "note" : "stop", message: "math.js is done; finish." }] }); }
      if (r.who === "builder" && builderOf(r) === "math") { await sleep(250); return r.turn === 0 ? BUILD.math[0] : `Checking again.\n${T("read_file", { path: `math.js:${r.turn}-${r.turn + 1}` })}`; }
      if (r.who === "builder") return BUILD.cli[r.turn] ?? "Done.";
      return "Done.";
    }, { env: { YAI_TEAM_WATCH_MS: "700" } });
    await runTeam(y, { ms: 110000 });
    assert.ok(watched >= 2);
    const board = y.events.filter((e) => e.type === "team").pop().view;
    assert.ok(board.feed.some((f) => f.who === "watcher" && /stopped math/.test(f.what)));
    assert.strictEqual(board.stages[0].rows.find((r) => r.name === "math").st, "stopped");
  } },
  { name: "a builder that writes the same reasoning: a note at 2, a takeover at 4", ms: 150000, fn: async (ctl) => {
    const why = "The add function returns a plus b and the sub function returns a minus b which should be correct for all integer inputs including negative numbers and zero in every case";
    const { y, srv } = await session(ctl, (r) => {
      if (r.who === "lead") return PLAN;
      if (r.who === "takeover") return [T("read_file", { path: "math.js" }), "Took over: math.js is done."][r.turn] ?? "Done.";
      if (r.who === "builder" && builderOf(r) === "math") return r.turn === 0 ? BUILD.math[0] : `${why} (${r.turn})\n${T("write_file", { path: `n${r.turn}.txt`, content: String(r.turn) })}`;
      if (r.who === "builder") return BUILD.cli[r.turn] ?? "Done.";
      return "Done.";
    });
    await runTeam(y, { ms: 140000 });
    assert.ok(srv.of("builder").some((r) => /INSTRUCTION FROM yAI/.test(r.text) && /repeating the same reasoning/.test(r.text)), "the note");
    const tk = srv.of("takeover");
    assert.ok(tk.length, "the takeover");
    assert.strictEqual(tk[0].model, "deepseek-v4.1-flash");
  } },
]);
