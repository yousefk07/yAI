"use strict";
// /debate and /hunt: fixed crews in rounds (cli/crew.js), over --stdio
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { suite, T, session, command, ask, until, sleep } = require("../lib/harness");

const DEBATE = {
  proposer: ["<plan>\n1. Argue\n</plan>\nPOSITION: Use localStorage.\nIt's simple and saves are small.", "POSITION: Still localStorage.\nB's point on size is fair but saves are 20 KB."],
  challenger: ["POSITION: Use IndexedDB.\nIt's async and has no 5 MB cap.", "POSITION: IndexedDB, behind a tiny wrapper.\nA is right that it's more code."],
  judge: ["DECISION: localStorage now, behind a save() wrapper.\n## Why\nSaves are 20 KB.\n## What the other side got right\nThe cap.\n## Risks to watch\nGrowth.\n## Next steps\n1. Write save()."],
};
const reply = (script) => (r) => { const s = script[r.who]; return s ? s[r.turn] ?? s[s.length - 1] : "Done."; };
const repro = T("write_file", { path: "t.test.js", content: 'const sum = require("./sum");\nif (sum(2, 3) !== 5) { console.error("sum(2,3) = " + sum(2, 3)); process.exit(1); }\nconsole.log("ok");' });
const HUNT = {
  reproducer: [repro, "sum subtracts.\nREPRO: node t.test.js"],
  tracer: ["Root cause: sum.js line 1 uses a - b instead of a + b."],
  fixer: [T("read_file", { path: "sum.js" }), T("write_file", { path: "sum.js", content: "module.exports = (a, b) => a + b;" }), "Changed - to + in sum.js; the reproduction passes."],
};
const BUG = { "sum.js": "module.exports = (a, b) => a - b;\n" };

suite(__filename, [
  { name: "/debate: two sides, a reply round in their own conversations, a judge, DEBATE.md", ms: 90000, fn: async (ctl) => {
    const { y, srv, file } = await session(ctl, reply(DEBATE));
    await command(y, "/debate Should saves go in localStorage or IndexedDB?", { ms: 80000 });
    assert.strictEqual(srv.of("proposer")[0].model, "deepseek-v4-pro");
    assert.strictEqual(srv.of("challenger")[0].model, "deepseek-v4.1-flash");
    const r2 = srv.of("proposer").find((r) => /The other side argued/.test(r.all));
    assert.ok(r2 && r2.turn >= 1, "side A replied in its own conversation");
    assert.match(r2.text, /IndexedDB/);
    assert.match(srv.of("judge")[0].text, /Side B, reply/);
    assert.match(file("DEBATE.md"), /DECISION: localStorage now/);
    assert.ok(y.texts().some((t) => /DECISION/.test(t)));
  } },
  { name: "/debate's agents can't change files", ms: 90000, fn: async (ctl) => {
    const s = { ...DEBATE, proposer: [T("write_file", { path: "sneaky.txt", content: "x" }), ...DEBATE.proposer] };
    const { y, dir } = await session(ctl, reply(s));
    await command(y, "/debate Tabs or spaces?", { mode: "yolo", ms: 80000 });
    assert.ok(!fs.existsSync(path.join(dir, "sneaky.txt")));
  } },
  { name: "after /debate, its reports don't land in the chat's next turn; the decision does", ms: 90000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, reply({ ...DEBATE, other: ["Noted."] }));
    await command(y, "/debate Which is better?", { ms: 80000 });
    await ask(y, "ok, what now?");
    const last = srv.log[srv.log.length - 1];
    assert.ok(!/Your background agent "side A"/.test(last.text), "no side's report in the chat");
    assert.match(last.text, /\/debate just settled/);
  } },
  { name: "/hunt: reproduce, trace, fix; yAI runs the reproduction and calls it fixed", ms: 90000, fn: async (ctl) => {
    const { y, srv, file } = await session(ctl, reply(HUNT), { files: BUG });
    await command(y, "/hunt sum(2, 3) gives -1 instead of 5", { mode: "yolo", ms: 80000 });
    assert.match(file("sum.js"), /a \+ b/);
    assert.ok(y.texts().some((t) => /Fixed: the reproduction passes now/.test(t)));
    assert.match(srv.of("tracer")[0].text, /Running node t\.test\.js now gives/);
    assert.match(srv.of("tracer")[0].text, /sum\(2,3\) = -1/);
  } },
  { name: "/hunt: a fix that doesn't pass gets one more go, in the fixer's own conversation", ms: 90000, fn: async (ctl) => {
    const s = { ...HUNT, fixer: [T("read_file", { path: "sum.js" }), T("write_file", { path: "sum.js", content: "module.exports = (a, b) => a * b;" }), "Fixed it.", T("write_file", { path: "sum.js", content: "module.exports = (a, b) => a + b;" }), "Now it's really fixed."] };
    const { y, srv, file } = await session(ctl, reply(s), { files: BUG });
    await command(y, "/hunt sum(2, 3) gives -1", { mode: "yolo", ms: 80000 });
    assert.match(file("sum.js"), /a \+ b/);
    const second = srv.of("fixer").find((r) => /still fails/.test(r.text));
    assert.ok(second && second.turn >= 3, "the second go is in the same conversation");
    assert.ok(y.texts().some((t) => /Fixed/.test(t)));
  } },
  { name: "/hunt without a REPRO line says it couldn't check the fix", ms: 90000, fn: async (ctl) => {
    const s = { ...HUNT, reproducer: [repro, "sum subtracts. Run the test file to see it."] };
    const { y } = await session(ctl, reply(s), { files: BUG });
    await command(y, "/hunt sum is wrong", { mode: "yolo", ms: 80000 });
    assert.ok(y.texts().some((t) => /couldn't check the fix/.test(t)));
  } },
  { name: "/hunt stopped midway stops its agents and says Stopped", ms: 60000, fn: async (ctl) => {
    let traced = 0;
    const s = { ...HUNT };
    const { y, srv } = await session(ctl, (r) => { if (r.who === "tracer") { traced++; return { text: "thinking ".repeat(4000), chunk: 20, delay: 20 }; } return reply(s)(r); }, { files: BUG });
    y.send({ type: "mode", mode: "yolo" });
    y.send({ type: "command", text: "/hunt sum is wrong" });
    await until(() => traced, 30000, "the tracer to start");
    await sleep(300);
    y.send({ type: "stop" });
    await y.waitFor((e) => e.type === "out" && /Stopped\./.test(e.text), 15000, "Stopped.");
    await sleep(1500);
    assert.strictEqual(srv.of("fixer").length, 0, "no fixer after the stop");
  } },
  { name: "/debate while /crew's agents still work is refused", ms: 60000, fn: async (ctl) => {
    const { y } = await session(ctl, async (r) => {
      if (r.who === "researcher") return r.turn === 0 ? T("write_file", { path: "RESEARCH.md", content: "x" }) : "Researched.";
      if (r.who === "helper") return { text: "slow ".repeat(3000), chunk: 20, delay: 20 };
      if (r.who === "main") return r.turn === 0 ? "<plan>\n1. a\n</plan>\n" + T("commission", { name: "slowpoke", task: "Write js/s.js with window.S = 1 and check it with node --check.", files: "js/s.js" }) : "Done for now.";
      return "Done.";
    });
    await command(y, "/crew go", { mode: "acceptEdits" });
    await sleep(300);
    await command(y, "/debate A or B?");
    assert.ok(y.events.some((e) => e.type === "out" && /still working: wait for them/.test(e.text)));
  } },
  { name: "/crew after /debate is a full crew again (its prompt is back)", ms: 90000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.who === "researcher" ? (r.turn === 0 ? T("write_file", { path: "RESEARCH.md", content: "x" }) : "Researched.") : reply(DEBATE)(r)));
    await command(y, "/debate A or B?", { ms: 80000 });
    await command(y, "/crew build it", { mode: "acceptEdits" });
    assert.ok(srv.log.some((r) => r.who === "main"), "the crew prompt was sent");
  } },
]);
