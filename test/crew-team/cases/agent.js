"use strict";
// The agent loop (cli/index.js runAgent/callModel) as background agents use it: yai --stdio against a fake site
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { suite, T, session, ask, until, strip, sleep } = require("../lib/harness");

const TEAM = { YAI_TEAM_AGENT: "1" };
const CREWAGENT = { YAI_TEAM_AGENT: "1", YAI_CREW_AGENT: "1" };
const codeLines = (n, tag = "x") => Array.from({ length: n }, (_, i) => `const ${tag}${i} = compute(${i}, "${tag}-${i * 7}");`).join("\n");
const counting = (n) => { let s = "const LEAVES = ["; for (let i = 0; s.length < n; i++) s += `"oak_leaves_${1800 + i}", "spruce_leaves_${1800 + i}", `; return s; };
// where the client stopped a looping reply, from what it told the model ("… (16,024 characters; …")
const loopAt = (all) => Number(((/repeating[^(]*\((\d[\d,]*) characters/.exec(all) || [])[1] || "0").replace(/,/g, ""));
const errors = (y) => y.events.filter((e) => e.type === "error").map((e) => e.message);

suite(__filename, [
  { name: "a write and a final answer: the file is there, one done", fn: async (ctl) => {
    const { y, file, srv } = await session(ctl, [T("write_file", { path: "a.txt", content: "hello" }), "Wrote a.txt."]);
    await ask(y, "write a.txt", { mode: "acceptEdits" });
    assert.strictEqual(file("a.txt"), "hello");
    assert.strictEqual(srv.log.length, 2);
    assert.deepStrictEqual(errors(y), []);
  } },
  { name: "an empty reply is asked again once, quietly", fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.n === 0 ? "" : "All good."));
    await ask(y, "hi");
    assert.strictEqual(srv.log.length, 2);
    assert.ok(y.notes().some((n) => /sent back nothing · asking again/.test(n)));
    assert.ok(y.texts().some((t) => /All good/.test(t)));
  } },
  { name: "two empty replies: said plainly, and an agent reports an error", fn: async (ctl) => {
    const { y, srv } = await session(ctl, () => "", { env: TEAM });
    await ask(y, "hi");
    assert.strictEqual(srv.log.length, 2);
    assert.ok(y.notes().some((n) => /No reply from the model/.test(n)));
    assert.ok(errors(y).some((m) => /nothing, twice/.test(m)));
  } },
  { name: "HTTP 500 ends the request with its message; the session takes the next prompt", fn: async (ctl) => {
    const { y } = await session(ctl, (r) => (r.n === 0 ? { status: 500, error: "the model is down" } : "Back."), { env: TEAM });
    await ask(y, "one");
    assert.ok(errors(y).some((m) => /the model is down/.test(m)));
    await ask(y, "two");
    assert.ok(y.texts().some((t) => /Back/.test(t)));
  } },
  { name: "a 502 before any text is tried again", ms: 30000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.n === 0 ? { status: 502, error: "Bad Gateway" } : "Fine now."));
    await ask(y, "go");
    assert.strictEqual(srv.log.length, 2);
    assert.ok(y.texts().some((t) => /Fine now/.test(t)));
  } },
  { name: "a 401 says the session expired", fn: async (ctl) => {
    const { y } = await session(ctl, () => ({ status: 401, error: "no" }), { env: TEAM });
    await ask(y, "go");
    assert.ok(errors(y).some((m) => /session expired/.test(m)));
  } },
  { name: "an error inside the stream is reported", fn: async (ctl) => {
    const { y } = await session(ctl, () => ({ sseError: "Modal: billing limit reached" }), { env: TEAM });
    await ask(y, "go");
    assert.ok(errors(y).some((m) => /billing limit/.test(m)));
  } },
  { name: "DeepSeek's DSML with doubled bars becomes a tool call", fn: async (ctl) => {
    const dsml = 'Writing it.\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="write_file">\n<｜｜DSML｜｜parameter name="path" string="true">d.txt</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="content" string="true">from dsml</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';
    const { y, file } = await session(ctl, [dsml, "Done."]);
    await ask(y, "go", { mode: "acceptEdits" });
    assert.strictEqual(file("d.txt"), "from dsml");
  } },
  { name: "DSML with spaces inside the tags (V4.1 Flash) and a split tag", fn: async (ctl) => {
    const dsml = '<｜DSML｜ tool_calls>\n<｜DSML｜ invoke name="write_file">\n<｜DSML｜ parameter name="path" string="true">e.txt</｜DSML｜ parameter>\n<｜DSML｜ parameter name="content" string="true">spaced</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ tool_calls>';
    const { y, file } = await session(ctl, (r) => (r.n === 0 ? { text: dsml, chunk: 7 } : "Done."));
    await ask(y, "go", { mode: "acceptEdits" });
    assert.strictEqual(file("e.txt"), "spaced");
  } },
  { name: "mixed markup: yAI's <tool> closed by a DSML closer", fn: async (ctl) => {
    const mixed = '<tool name="write_file">\n<path>m.txt</path>\n<content>\nmixed\n</｜DSML｜ parameter></｜DSML｜ invoke>';
    const { y, file } = await session(ctl, [mixed, "Done."]);
    await ask(y, "go", { mode: "acceptEdits" });
    assert.strictEqual(file("m.txt"), "mixed");
  } },
  { name: "arguments as JSON inside the call", fn: async (ctl) => {
    const { y, file } = await session(ctl, ['<tool name="write_file">{"path": "j.txt", "content": "json args"}</tool>', "Done."]);
    await ask(y, "go", { mode: "acceptEdits" });
    assert.strictEqual(file("j.txt"), "json args");
  } },
  { name: "a short step left unclosed: asked to write it again, then it works", fn: async (ctl) => {
    const { y, file, srv } = await session(ctl, ['<tool name="write_file">\n<path>\nu.txt\n</path>\n<content>\nhal', T("write_file", { path: "u.txt", content: "whole" }), "Done."]);
    await ask(y, "go", { mode: "acceptEdits" });
    assert.strictEqual(file("u.txt"), "whole");
    assert.match(srv.log[1].all, /isn't finished/);
  } },
  { name: "two unfinished steps in a row stop it, and an agent reports why", fn: async (ctl) => {
    const { y, srv } = await session(ctl, () => '<tool name="read_file">\n<path>\nx', { env: TEAM });
    await ask(y, "go");
    assert.strictEqual(srv.log.length, 2);
    assert.ok(errors(y).some((m) => /without finishing/.test(m)));
  } },
  { name: "a long write cut off mid-file: the whole lines are saved and it goes on with append", fn: async (ctl) => {
    const first = codeLines(300, "a"), rest = codeLines(50, "b");
    const cut = `${T("write_file", { path: "big.js", content: first + "\nconst half = 1" }).replace(/\nconst half = 1\n<\/content>\n<\/tool>\n$/, "\nconst half = 1")}`;
    const { y, file, srv } = await session(ctl, (r) => (r.n === 0 ? cut : r.n === 1 ? T("write_file", { path: "big.js", append: "true", content: "const half = 1;\n" + rest }) : "Done."));
    await ask(y, "go", { mode: "acceptEdits" });
    const text = file("big.js");
    assert.ok(text.startsWith("const a0 ="), "kept the start");
    assert.ok(text.includes("const a299 =") && text.includes("const b49 ="), "both parts are there");
    assert.strictEqual((text.match(/const a150 =/g) || []).length, 1, "no part written twice");
    assert.match(srv.log[1].all, /go on from the line after it|Go on from the line after it/i);
    // the cut-off reply isn't kept whole in the history
    assert.ok(srv.log[1].all.length < first.length, "the history doesn't carry the whole cut reply");
  } },
  { name: "a cut-off write to a file that exists (no append) isn't saved over it", fn: async (ctl) => {
    const cut = `<tool name="write_file">\n<path>\nkeep.js\n</path>\n<content>\n${codeLines(300)}\nconst hal`;
    const { y, file, srv } = await session(ctl, (r) => (r.n === 0 ? cut : "Done."), { files: { "keep.js": "// the original\n" } });
    await ask(y, "go", { mode: "acceptEdits" });
    assert.strictEqual(file("keep.js"), "// the original\n");
    assert.match(srv.log[1].all, /parts of at most 400 lines/);
  } },
  { name: "a looping reply is stopped early, and the next 3 go out warmer", fn: async (ctl) => {
    const loop = `<tool name="write_file">\n<path>\nblocks.js\n</path>\n<content>\n${counting(80000)}`;
    const { y, srv } = await session(ctl, (r) => (r.n === 0 ? { text: loop, chunk: 2000, delay: 2 } : r.n < 5 ? T("write_file", { path: `f${r.n}.txt`, content: "x" }) : "Done."));
    await ask(y, "go", { mode: "acceptEdits" });
    const at = loopAt(srv.log[1].all);
    assert.ok(at > 10000 && at < 20000, `it was stopped early (at ${at})`);
    assert.deepStrictEqual(srv.log.slice(0, 6).map((r) => r.temperature), [0.3, 1, 1, 1, 0.3, 0.3]);
    assert.match(srv.log[1].all, /started repeating/);
    assert.ok(srv.log[1].all.length < 20000, "the looped text isn't kept");
  } },
  { name: "loops: the second goes to the other model, the fourth stops it", ms: 90000, fn: async (ctl) => {
    const loop = `<tool name="write_file">\n<path>\nblocks.js\n</path>\n<content>\n${counting(80000)}`;
    const { y, srv } = await session(ctl, () => ({ text: loop, chunk: 2000, delay: 1 }), { env: TEAM });
    await ask(y, "go", { mode: "acceptEdits" });
    assert.strictEqual(srv.log.length, 4);
    assert.deepStrictEqual(srv.log.map((r) => r.model), ["deepseek-v4.1-flash", "deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-pro"]);
    assert.ok(y.notes().some((n) => /kept repeating themselves \(4 times/.test(n)));
    assert.ok(errors(y).some((m) => /kept repeating/.test(m)));
  } },
  { name: "a loop of plain text (no tool call) is stopped too", fn: async (ctl) => {
    const prose = Array.from({ length: 600 }, () => "I will now check the inventory system once more to be sure.").join("\n");
    const { y, srv } = await session(ctl, (r) => (r.n === 0 ? { text: prose, chunk: 1500, delay: 1 } : "Done, properly."));
    await ask(y, "go");
    const at = loopAt(srv.log[1].all);
    assert.ok(at > 10000 && at < prose.length, `stopped before the end (at ${at})`);
    assert.match(srv.log[1].all, /started repeating/);
  } },
  { name: "old big writes become one-line notes in later requests (compactWrites)", fn: async (ctl) => {
    const big = codeLines(120, "w");
    const { y, srv } = await session(ctl, (r) => (r.n === 0 ? T("write_file", { path: "w.js", content: big }) : r.n < 6 ? T("write_file", { path: `s${r.n}.txt`, content: "small" }) : "Done."));
    await ask(y, "go", { mode: "acceptEdits" });
    const last = srv.log[srv.log.length - 1].all;
    assert.ok(!last.includes("const w60 ="), "the big file's text is gone from the history");
    assert.match(last, /lines, now in w\.js/);
  } },
  { name: "an agent's old tool output is trimmed once past its budget (trimContext)", fn: async (ctl) => {
    const files = {}; for (let i = 0; i < 4; i++) files[`r${i}.txt`] = `${"line of data number something\n".repeat(400)}${i}`;
    const { y, srv } = await session(ctl, (r) => (r.n < 4 ? T("read_file", { path: `r${r.n}.txt` }) : r.n < 24 ? T("write_file", { path: `q${r.n}.txt`, content: "q" }) : "Done."), { env: { ...TEAM, YAI_TRIM_TOKENS: "6000" }, files });
    await ask(y, "go", { mode: "acceptEdits" });
    const last = srv.log[srv.log.length - 1].all;
    assert.match(last, /old tool output removed/);
  } },
  { name: "eight 200-line files written in a row: the history sent stays small", ms: 60000, fn: async (ctl) => {
    const file = (k) => Array.from({ length: 200 }, (_, i) => `export const v${k}_${i} = (x) => x * ${(i * 7919 + k * 31) % 10007} + ${(i * 104729) % 997};`).join("\n");
    const { y, srv } = await session(ctl, (r) => (r.n < 8 ? T("write_file", { path: `js/f${r.n}.js`, content: file(r.n) }) : "Done."));
    await ask(y, "go", { mode: "acceptEdits" });
    const sizes = srv.log.map((r) => r.all.length);
    assert.ok(sizes[8] < file(0).length * 4, `the last request carries ${sizes[8]} characters of history (one file is ${file(0).length})`);
  } },
  { name: "a file written with a syntax error: the step's result says so at once", fn: async (ctl) => {
    const { y, srv } = await session(ctl, [T("write_file", { path: "bad.js", content: "function x( {\n  return 1;\n}" }), "Done."]);
    await ask(y, "go", { mode: "acceptEdits" });
    assert.match(srv.log[1].text, /Check: bad\.js now has an error: SyntaxError/);
  } },
  { name: "a file written in parts isn't called broken while it's unfinished", fn: async (ctl) => {
    const { y, srv } = await session(ctl, [T("write_file", { path: "p.js", content: "function x() {\n  return 1;" }), T("write_file", { path: "p.js", append: "true", content: "}\n" }), "Done."]);
    await ask(y, "go", { mode: "acceptEdits" });
    assert.match(srv.log[1].text, /If you're still writing it in parts, finish it/);
    assert.ok(!/Check:/.test(srv.log[2].messages.slice(-1)[0].content), "whole now: no error");
  } },
  { name: "a background agent that calls commission or crew_wait anyway is told they aren't there (no phantom helper, no wait)", ms: 30000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, [T("commission", { name: "ghost", task: "Write js/ghost.js with window.GHOST = 1 and check it with node --check.", files: "js/ghost.js" }), T("crew_wait", { minutes: "10" }), T("team_say", { text: "hello" }), "Done."], { env: CREWAGENT });
    const t0 = Date.now();
    await ask(y, "go", { mode: "acceptEdits" });
    assert.ok(Date.now() - t0 < 15000, "crew_wait didn't wait");
    assert.match(srv.log[1].text, /commission isn't available/);
    assert.match(srv.log[2].text, /crew_wait isn't available/);
    assert.match(srv.log[3].text, /team_say isn't available/);
  } },
  { name: "the same page_eval again and again with nothing changed isn't run, and the chat is stopped", ms: 90000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.n < 12 ? T("page_eval", { code: "window.G && window.G.n" }) : "Done."), { files: { "index.html": "<!doctype html><script>window.G = { n: 7 };</script>" } });
    await ask(y, "check it", { mode: "acceptEdits", ms: 80000 });
    assert.match(srv.log[1].text, /Result: 7/);
    assert.match(srv.log[2].text, /You already did this exact step/);
    assert.ok(srv.log.length <= 9, `stopped after the repeats (${srv.log.length} requests)`);
    assert.ok(y.notes().some((n) => /kept repeating steps/.test(n)));
  } },
  { name: "the same page_eval after a file in the project changed is run again", ms: 90000, fn: async (ctl) => {
    const { y, srv, dir } = await session(ctl, async (r) => {
      if (r.n === 1) { await sleep(50); require("fs").writeFileSync(require("path").join(dir, "index.html"), "<!doctype html><script>window.G = { n: 8 };</script>"); } // another agent's edit
      return r.n < 2 ? T("page_eval", { code: "window.G.n" }) : "Done.";
    }, { files: { "index.html": "<!doctype html><script>window.G = { n: 7 };</script>" } });
    await ask(y, "check it", { mode: "acceptEdits", ms: 80000 });
    assert.match(srv.log[2].text, /Result: 8/);
  } },
  { name: "three refused repeats: the next steps go out warmer, on the other model, before the stop at six", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.n < 12 ? T("read_file", { path: "a.txt" }) : "Done."), { files: { "a.txt": "abc" } });
    await ask(y, "go");
    // request 0 reads; 1, 2, 3 are refused; from request 4 the next steps are warmer and on the other model
    assert.deepStrictEqual(srv.log.slice(0, 4).map((r) => r.model), Array(4).fill("deepseek-v4.1-flash"));
    assert.strictEqual(srv.log[4].model, "deepseek-v4-pro");
    assert.strictEqual(srv.log[4].temperature, 1);
    assert.ok(y.notes().some((n) => /kept repeating steps/.test(n)));
  } },
  { name: "the same read again with nothing changed isn't run", fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.n < 2 ? T("read_file", { path: "a.txt" }) : "Done."), { files: { "a.txt": "abc" } });
    await ask(y, "go");
    assert.match(srv.log[2].all, /You already did this exact step/);
  } },
  { name: "a command needs approval in acceptEdits: yes runs it", fn: async (ctl) => {
    const { y, srv } = await session(ctl, [T("run", { command: "node -e \"console.log('ran-it')\"" }), "Done."]);
    await y.ready;
    y.send({ type: "mode", mode: "acceptEdits" });
    y.send({ type: "prompt", text: "go" });
    const q = await y.waitFor((e) => e.type === "ask", 20000, "the question");
    y.send({ type: "answer", id: q.id, choice: 0 });
    await y.waitFor((e) => e.type === "done" && y.events.some((x) => x.type === "busy"), 30000, "done");
    await until(() => srv.log.length >= 2, 10000, "the next request");
    assert.match(srv.log[1].all, /ran-it/);
  } },
  { name: "a command refused with no reason stops the request", fn: async (ctl) => {
    const { y, srv } = await session(ctl, [T("run", { command: "node -e \"console.log(1)\"" }), "Should not come."]);
    y.send({ type: "mode", mode: "acceptEdits" });
    y.send({ type: "prompt", text: "go" });
    const q = await y.waitFor((e) => e.type === "ask", 20000, "the question");
    y.send({ type: "answer", id: q.id, choice: 2 });
    await y.waitFor((e) => e.type === "done" && y.events.some((x) => x.type === "busy"), 30000, "done");
    await sleep(300);
    assert.strictEqual(srv.log.length, 1);
  } },
  { name: "yolo runs commands without asking", fn: async (ctl) => {
    const { y, srv } = await session(ctl, [T("run", { command: "node -e \"console.log('yolo-ran')\"" }), "Done."]);
    await ask(y, "go", { mode: "yolo" });
    assert.ok(!y.events.some((e) => e.type === "ask"));
    assert.match(srv.log[1].all, /yolo-ran/);
  } },
  { name: "a stop mid-reply ends the request, and the next prompt runs normally", fn: async (ctl) => {
    let n = 0;
    const { y, srv } = await session(ctl, async (r) => { if (n++ === 0) return { text: "slow ".repeat(4000), chunk: 20, delay: 20 }; return "Second answer."; });
    y.send({ type: "prompt", text: "one" });
    await until(() => srv.log.length >= 1, 10000, "the request");
    await sleep(400);
    y.send({ type: "stop" });
    await y.waitFor((e) => e.type === "done", 20000, "done after stop");
    await ask(y, "two");
    assert.ok(y.texts().some((t) => /Second answer/.test(t)));
  } },
  { name: "a mode change mid-run isn't a done", fn: async (ctl) => {
    const { y } = await session(ctl, (r) => (r.n === 0 ? { text: "thinking about it ".repeat(200), chunk: 50, delay: 15 } : "Done."));
    y.send({ type: "prompt", text: "go" });
    await y.waitFor((e) => e.type === "busy", 10000, "busy");
    await sleep(200);
    y.send({ type: "mode", mode: "yolo" });
    await y.waitFor((e) => e.type === "done", 20000, "done");
    const busyAt = y.events.findIndex((e) => e.type === "busy");
    const dones = y.events.slice(busyAt).filter((e) => e.type === "done");
    await sleep(300);
    assert.strictEqual(y.events.slice(busyAt).filter((e) => e.type === "done").length, 1, "one done");
    assert.strictEqual(dones[0].mode, "yolo");
  } },
  { name: "no step limit: 70 steps run to the end", ms: 120000, fn: async (ctl) => {
    const { y, srv, dir } = await session(ctl, (r) => (r.n < 70 ? T("write_file", { path: `n/${r.n}.txt`, content: String(r.n) }) : "All 70."), { env: TEAM });
    await ask(y, "go", { mode: "acceptEdits", ms: 110000 });
    assert.strictEqual(srv.log.length, 71);
    assert.strictEqual(fs.readdirSync(path.join(dir, "n")).length, 70);
  } },
  { name: "the same reasoning written again is flagged (repeat-text)", fn: async (ctl) => {
    const why = "The atlas is two hundred and fifty six pixels wide so each tile is sixteen pixels and the uv mapping uses the tile index times one sixteenth which should be correct for every block face in the world";
    const { y } = await session(ctl, (r) => (r.n < 3 ? `${why} (${r.n})\n${T("write_file", { path: `t${r.n}.txt`, content: "x" })}` : "Done."), { env: TEAM });
    await ask(y, "go", { mode: "acceptEdits" });
    const reps = y.events.filter((e) => e.type === "repeat-text");
    assert.ok(reps.length >= 2, `flagged ${reps.length} times`);
  } },
  { name: "a stream that drops partway through a step: the step is cut off and the agent goes on", ms: 30000, fn: async (ctl) => {
    const step = T("write_file", { path: "late.txt", content: "the content of the file" });
    const { y, file, srv } = await session(ctl, (r) => (r.n === 0 ? { text: "Writing it now.\n" + step, drop: 40, chunk: 10, delay: 5 } : r.n === 1 ? step : "Done."), { env: CREWAGENT });
    await ask(y, "go", { mode: "acceptEdits" });
    assert.strictEqual(file("late.txt"), "the content of the file");
    assert.deepStrictEqual(errors(y), []);
    assert.ok(srv.log.length >= 3);
  } },
  { name: "a stream that drops partway through plain words: asked to go on, not ended as the answer", ms: 30000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.n === 0 ? { text: "Here is the first half of my answer and then", drop: 30, chunk: 6, delay: 5 } : "The whole answer."), { env: CREWAGENT });
    await ask(y, "go");
    assert.strictEqual(srv.log.length, 2);
    assert.deepStrictEqual(errors(y), []);
    assert.match(srv.log[1].all, /connection/i);
  } },
  { name: "a connection that keeps dropping mid-reply ends with an error after 3", ms: 30000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, () => ({ text: "Some words that never finish because the line keeps dropping", drop: 20, chunk: 5, delay: 3 }), { env: CREWAGENT });
    await ask(y, "go");
    assert.strictEqual(srv.log.length, 4);
    assert.ok(errors(y).length === 1, `one error: ${JSON.stringify(errors(y))}`);
  } },
  { name: "a site that never answers is given up on and asked again (no agent waits forever)", ms: 30000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.n === 0 ? { hang: true } : "Answered."), { env: { ...CREWAGENT, YAI_IDLE_MS: "1500" } });
    await ask(y, "go");
    assert.strictEqual(srv.log.length, 2);
    assert.ok(y.texts().some((t) => /Answered/.test(t)));
  } },
  { name: "a stream that goes quiet partway: what came is kept and the agent goes on", ms: 30000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.n === 0 ? { text: "The first half of my answer and", thenHang: true } : "The rest."), { env: { ...CREWAGENT, YAI_IDLE_MS: "1500" } });
    await ask(y, "go");
    assert.strictEqual(srv.log.length, 2);
    assert.match(srv.log[1].text, /connection/i);
    assert.deepStrictEqual(errors(y), []);
  } },
  { name: "a dropped stream before any text is tried again", ms: 30000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.n === 0 ? { drop: 0, text: "x" } : "Recovered."));
    await ask(y, "go");
    assert.strictEqual(srv.log.length, 2);
    assert.ok(y.texts().some((t) => /Recovered/.test(t)));
  } },
]);
