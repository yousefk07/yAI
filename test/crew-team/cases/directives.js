"use strict";
// The watcher's directives as an agent takes them (cli/index.js): loud once then one quiet line, blocks, the ack
const assert = require("assert");
const { suite, T, session, ask, sleep } = require("../lib/harness");

const AGENT = { YAI_TEAM_AGENT: "1", YAI_CREW_AGENT: "1" };
const assistantTexts = (r) => r.messages.filter((m) => m.role === "assistant").map((m) => String(m.content));
const banner = (r) => r.all.includes("INSTRUCTION FROM yAI");
const quiet = (r) => r.all.includes("watcher said, earlier");
const results = (r) => r.messages.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n");

// a session where the directive is sent while the first reply is being written
async function withDirective(ctl, directive, replies, opts = {}) {
  let y;
  const s = await session(ctl, async (r) => {
    if (r.n === 0) y.send({ type: "directive", ...directive });
    return typeof replies === "function" ? replies(r) : replies[r.turn] ?? "Done.";
  }, { env: AGENT, ...opts });
  y = s.y;
  return s;
}

suite(__filename, [
  { name: "shown loudly once, then as one quiet line; 'Following the watcher' isn't kept", fn: async (ctl) => {
    const { y, srv } = await withDirective(ctl, { text: "Stop reading a.txt; make the change.", block: [], steps: 4 }, ["Looking.\n" + T("read_file", { path: "a.txt" }), "Following the watcher: I'll edit now.\n" + T("write_file", { path: "b.txt", content: "x" }), "Following the watcher: still.\n" + T("write_file", { path: "c.txt", content: "y" }), "Done."], { files: { "a.txt": "hello" } });
    await ask(y, "do it", { mode: "yolo" });
    assert.ok(!banner(srv.log[0]));
    assert.ok(banner(srv.log[1]), "the banner is in the next request");
    assert.ok(!banner(srv.log[2]) && quiet(srv.log[2]), "then only the quiet line");
    for (const r of srv.log.slice(2)) assert.ok(!assistantTexts(r).some((t) => /following the watcher/i.test(t)), "no 'Following the watcher' in the history");
    assert.ok(!y.events.some((e) => e.type === "directive-ignored"));
  } },
  { name: "not acknowledged: directive-ignored", fn: async (ctl) => {
    const { y } = await withDirective(ctl, { text: "Stop and write the file.", block: [], steps: 4 }, ["Looking.\n" + T("read_file", { path: "a.txt" }), "Hmm, more looking.\n" + T("list_files", { path: "." }), "Done."], { files: { "a.txt": "hello" } });
    await ask(y, "do it", { mode: "yolo" });
    assert.ok(y.events.some((e) => e.type === "directive-ignored"));
  } },
  { name: "a blocked tool isn't run: the agent is told, and directive-defied says what", fn: async (ctl) => {
    const { y, srv, dir } = await withDirective(ctl, { text: "No more commands; edit the code.", block: ["run"], steps: 6 }, ["Start.\n" + T("read_file", { path: "a.txt" }), "Following the watcher: editing.\n" + T("run", { command: "node -e \"require('fs').writeFileSync('ran.txt','1')\"" }), "Done."], { files: { "a.txt": "hello" } });
    await ask(y, "do it", { mode: "yolo" });
    assert.match(results(srv.log[2]), /Blocked by yAI's watcher \(no run for now/);
    const d = y.events.find((e) => e.type === "directive-defied");
    assert.ok(d && /no run/.test(d.what));
    assert.ok(!require("fs").existsSync(require("path").join(dir, "ran.txt")), "the command never ran");
  } },
  { name: "a read block on one file lifts once that file is changed", fn: async (ctl) => {
    const { y, srv } = await withDirective(ctl, { text: "You've read a.txt enough: change it.", block: ["read:a.txt"], steps: 8 }, ["Start.\n" + T("read_file", { path: "a.txt" }), "Following the watcher: ok.\n" + T("read_file", { path: "a.txt" }), T("edit_file", { path: "a.txt", old: "hello", new: "hello world" }), T("read_file", { path: "a.txt" }), "Done."], { files: { "a.txt": "hello" } });
    await ask(y, "do it", { mode: "yolo" });
    assert.match(results(srv.log[2]), /no reading a\.txt again until you change it/);
    assert.match(results(srv.log[4]), /hello world/, "read again after the edit");
  } },
  { name: "edits-only blocks reads and page checks until the first edit", fn: async (ctl) => {
    const { y, srv } = await withDirective(ctl, { text: "Make your change now.", block: ["edits-only"], steps: 8 }, ["Start.\n" + T("read_file", { path: "a.txt" }), "Following the watcher: ok.\n" + T("search", { pattern: "hello" }), T("page_eval", { code: "1+1" }), T("write_file", { path: "a.txt", content: "changed" }), T("read_file", { path: "a.txt" }), "Done."], { files: { "a.txt": "hello" } });
    await ask(y, "do it", { mode: "yolo" });
    assert.match(results(srv.log[2]), /edits only/);
    assert.match(results(srv.log[3]), /edits only/);
    assert.match(results(srv.log[5]), /changed/);
  } },
  { name: "a block lasts its steps, then lifts", fn: async (ctl) => {
    const { y, srv } = await withDirective(ctl, { text: "Write files for a while.", block: ["list_files"], steps: 2 }, ["Start.\n" + T("read_file", { path: "a.txt" }), "Following the watcher: ok.\n" + T("write_file", { path: "1.txt", content: "1" }), T("write_file", { path: "2.txt", content: "2" }), T("list_files", { path: "." }), "Done."], { files: { "a.txt": "hello" } });
    await ask(y, "do it", { mode: "yolo" });
    assert.ok(!/Blocked by yAI's watcher/.test(results(srv.log[4])), "list_files ran after the 2 steps");
    assert.match(results(srv.log[4]), /1\.txt/);
  } },
  { name: "two directives at once become one instruction with both blocks", fn: async (ctl) => {
    let y;
    const s = await session(ctl, async (r) => {
      if (r.n === 0) { y.send({ type: "directive", text: "First thing.", block: ["run"], steps: 5 }); y.send({ type: "directive", text: "Second thing.", block: ["search"], steps: 5 }); await sleep(300); }
      return ["Start.\n" + T("read_file", { path: "a.txt" }), "Following the watcher: both.\n" + T("search", { pattern: "x" }), "Done."][r.turn] ?? "Done.";
    }, { env: AGENT, files: { "a.txt": "hello" } });
    y = s.y;
    await ask(y, "do it", { mode: "yolo" });
    assert.match(s.srv.log[1].all, /First thing\. Second thing\./);
    assert.match(s.srv.log[1].all, /no run; no search/);
    assert.match(results(s.srv.log[2]), /Blocked by yAI's watcher \(no search/);
  } },
  { name: "the steps a directive asks for are kept between 2 and 30", fn: async (ctl) => {
    const { y, srv } = await withDirective(ctl, { text: "Hold off on commands.", block: ["run"], steps: 999 }, ["Start.\n" + T("read_file", { path: "a.txt" }), "Following the watcher: ok.\n" + T("list_files", { path: "." }), "Done."], { files: { "a.txt": "hello" } });
    await ask(y, "do it", { mode: "yolo" });
    assert.match(srv.log[1].all, /Blocked for your next 30 steps/);
  } },
  { name: "a directive sent while idle is read with the next request's first step", fn: async (ctl) => {
    const { y, srv } = await session(ctl, [T("read_file", { path: "a.txt" }), "Following the watcher: fine.\nDone."], { env: AGENT, files: { "a.txt": "hello" } });
    y.send({ type: "directive", text: "Remember to check the page.", block: [], steps: 3 });
    await sleep(200);
    await ask(y, "do it", { mode: "yolo" });
    assert.ok(banner(srv.log[1]));
  } },
  { name: "an empty directive is ignored", fn: async (ctl) => {
    const { y, srv } = await withDirective(ctl, { text: "   ", block: ["run"], steps: 4 }, [T("read_file", { path: "a.txt" }), "Done."], { files: { "a.txt": "hello" } });
    await ask(y, "do it", { mode: "yolo" });
    assert.ok(!banner(srv.log[1]));
  } },
]);
