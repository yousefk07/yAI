"use strict";
// /crew end to end over --stdio: the researcher first, the chat commissions background agents, their reports reach it
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { suite, T, session, command, ask, until, sleep, strip, homeEnv } = require("../lib/harness");

const research = (r) => (r.turn === 0 ? T("write_file", { path: "RESEARCH.md", content: "## The topic\nfacts\n## Checklist\n1. it works" }) : "Researched: the 5 facts.");
const notesOf = (y) => y.notes();
const helperTask = "Write js/levels.js defining window.LEVELS as an array of 3 levels, each { name, grid } with 5 rows.";

suite(__filename, [
  { name: "the full flow: researcher first, a helper, crew_wait, its report reaches the chat", ms: 90000, fn: async (ctl) => {
    const main = [
      "<plan>\n1. Hand out levels\n2. Page\n3. Finish\n</plan>\n" + T("commission", { name: "levels", model: "lite", task: helperTask, files: "js/levels.js" }),
      T("write_file", { path: "index.html", content: '<!doctype html><script src="js/levels.js"></script>' }),
      T("crew_wait", { minutes: "2" }),
      "Done: the page loads the three levels.",
    ];
    const helper = [T("write_file", { path: "js/levels.js", content: "window.LEVELS = [1,2,3];" }), "Made js/levels.js with window.LEVELS (3 levels)."];
    const { y, srv, file } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") { if (r.turn === 0) await sleep(800); return helper[r.turn] ?? "Done."; }
      if (r.who === "main") return main[r.turn] ?? "Done.";
      return "Done.";
    });
    await command(y, "/crew build a tiny level viewer page", { mode: "acceptEdits", ms: 80000 });
    const mains = srv.of("main");
    assert.ok(srv.log.findIndex((r) => r.who === "researcher") < srv.log.findIndex((r) => r.who === "main"), "the researcher ran first");
    assert.match(mains[0].all, /Researched: the 5 facts/, "the research reached the chat's first turn");
    assert.match(mains[0].all, /RESEARCH\.md/);
    assert.strictEqual(srv.of("helper")[0].model, "glm-4.7-flash", "a lite job runs on Lite");
    assert.match(mains[3].all, /window\.LEVELS \(3 levels\)/, "the helper's report came back through crew_wait");
    assert.strictEqual(file("js/levels.js"), "window.LEVELS = [1,2,3];");
    assert.ok(file("index.html"));
  } },
  { name: "a researcher that wrote no RESEARCH.md: the chat is told plainly", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, (r) => (r.who === "researcher" ? "Nothing to research: it's a job on this project's files." : r.who === "main" ? "<plan>\n1. Do it\n</plan>\nDone." : "Done."));
    await command(y, "/crew rename the variable x to y", { mode: "acceptEdits" });
    assert.match(srv.of("main")[0].all, /wrote no RESEARCH\.md/);
  } },
  { name: "a report arrives with the chat's next step result when it isn't waiting", ms: 60000, fn: async (ctl) => {
    let helperDone = false;
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") { const out = ["Made the sounds.", "x"][r.turn]; helperDone = true; return out; }
      if (r.who === "main") {
        if (r.turn === 0) return "<plan>\n1. a\n</plan>\n" + T("commission", { name: "sounds", task: "Write js/sfx.js with window.SFX.play(name) for jump and coin, using WebAudio.", files: "js/sfx.js" });
        if (r.turn < 6) { await until(() => helperDone, 10000).catch(() => {}); await sleep(300); return T("write_file", { path: `p${r.turn}.txt`, content: "x" }); }
        return "Done.";
      }
      return "Done.";
    });
    await command(y, "/crew a game with sounds", { mode: "acceptEdits" });
    assert.ok(srv.of("main").some((r) => /Your helper "sounds" has finished/.test(r.text)), "the report came with a step's result");
  } },
  { name: "the chat ending while a helper works is held (at most twice) to wait for it", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") { await sleep(4000); return "Made it."; }
      if (r.who === "main") return r.turn === 0 ? "<plan>\n1. a\n</plan>\n" + T("commission", { name: "maker", task: "Make js/a.js with window.A = 1 and nothing else, then check it with node --check.", files: "js/a.js" }) : r.turn < 4 ? "I'm finished." : "Done.";
      return "Done.";
    });
    await command(y, "/crew make a", { mode: "acceptEdits" });
    const held = srv.of("main").filter((r) => /Your background agents are still working \(maker\)/.test(r.all));
    assert.ok(held.length >= 1);
    assert.ok(srv.of("main").length <= 4, `held at most twice (${srv.of("main").length} requests)`);
  } },
  { name: "/crew 2: a third agent at once isn't started, and the chat is told why", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") { await sleep(3000); return "Made it."; }
      if (r.who === "main") {
        const jobs = ["one", "two", "three"];
        if (r.turn < 3) return (r.turn === 0 ? "<plan>\n1. a\n</plan>\n" : "") + T("commission", { name: jobs[r.turn], task: `Make js/${jobs[r.turn]}.js with window.${jobs[r.turn].toUpperCase()} = 1 and check it.`, files: `js/${jobs[r.turn]}.js` });
        if (r.turn === 3) return T("crew_wait", {});
        return "Done.";
      }
      return "Done.";
    });
    await command(y, "/crew 2 make three modules", { mode: "acceptEdits" });
    assert.ok(srv.of("main").some((r) => /not started: 2 background agents are already working/.test(r.all)));
    assert.strictEqual(new Set(srv.of("helper").map((r) => r.messages[0].content.match(/window\.(\w+)/)[1])).size, 2);
  } },
  { name: "yolo: background agents run commands without asking", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") return [T("run", { command: "node -e \"console.log('helper-ran')\"" }), "Ran it."][r.turn] ?? "Done.";
      if (r.who === "main") return ["<plan>\n1. a\n</plan>\n" + T("commission", { name: "runner", task: "Run node -e to print helper-ran and report what it printed.", files: "x.js" }), T("crew_wait", {}), "Done."][r.turn] ?? "Done.";
      return "Done.";
    });
    await command(y, "/crew run it", { mode: "yolo" });
    assert.ok(srv.of("helper").some((r) => /helper-ran/.test(r.all)));
  } },
  { name: "acceptEdits: a background agent's question reaches the panel, and the answer reaches the agent", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") return [T("run", { command: "node -e \"console.log('asked-ran')\"" }), "Ran it."][r.turn] ?? "Done.";
      if (r.who === "main") return ["<plan>\n1. a\n</plan>\n" + T("commission", { name: "asker", task: "Run node -e to print asked-ran and report what it printed.", files: "x.js" }), T("crew_wait", {}), "Done."][r.turn] ?? "Done.";
      return "Done.";
    });
    y.send({ type: "mode", mode: "acceptEdits" });
    y.send({ type: "command", text: "/crew run it" });
    const q = await y.waitFor((e) => e.type === "ask" && /asker/.test(e.title || ""), 30000, "the agent's question in the panel");
    y.send({ type: "answer", id: q.id, choice: 0 });
    await until(() => srv.of("helper").some((r) => /asked-ran/.test(r.all)), 30000, "the command to run");
  } },
  { name: "switching the panel to yolo reaches working agents (and allows a waiting question)", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") return [T("run", { command: "node -e \"console.log('later-ran')\"" }), "Ran it."][r.turn] ?? "Done.";
      if (r.who === "main") return ["<plan>\n1. a\n</plan>\n" + T("commission", { name: "waiter", task: "Run node -e to print later-ran and report what it printed.", files: "x.js" }), T("crew_wait", {}), "Done."][r.turn] ?? "Done.";
      return "Done.";
    });
    y.send({ type: "mode", mode: "acceptEdits" });
    y.send({ type: "command", text: "/crew run it" });
    await y.waitFor((e) => e.type === "note" && /waiter asks/.test(strip(e.text)), 30000, "the question note");
    y.send({ type: "mode", mode: "yolo" });
    await until(() => srv.of("helper").some((r) => /later-ran/.test(r.all)), 20000, "the command to run after yolo");
  } },
  { name: "a stop in the panel stops the background agents too", ms: 60000, fn: async (ctl) => {
    let helperCalls = 0, stopped = false;
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") { helperCalls++; return { text: "working on it slowly ".repeat(3000), chunk: 30, delay: 20 }; }
      if (r.who === "main") return r.turn === 0 ? "<plan>\n1. a\n</plan>\n" + T("commission", { name: "slow", task: "Write js/slow.js with a big table of data, carefully, and check it.", files: "js/slow.js" }) : stopped ? "It was stopped." : { text: "still going ".repeat(3000), chunk: 30, delay: 20 };
      return "Done.";
    });
    y.send({ type: "mode", mode: "yolo" });
    y.send({ type: "command", text: "/crew slow" });
    await until(() => helperCalls >= 1 && srv.of("main").length >= 2, 30000, "the helper and the chat working");
    stopped = true;
    y.send({ type: "stop" });
    await y.waitFor((e) => e.type === "done" && y.events.some((x) => x.type === "busy"), 20000, "done");
    const before = helperCalls;
    await sleep(2500);
    assert.strictEqual(helperCalls, before, "no new helper requests after the stop");
    // the stopped helper's report waits for the chat
    await ask(y, "what happened?");
    assert.ok(srv.of("main").some((r) => /"slow"[\s\S]*stopped/.test(r.text)), "the chat hears the helper was stopped");
  } },
  { name: "a commission in plan mode is refused: nothing may change before the plan is approved", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "main") return ["<plan>\n1. a\n</plan>\n" + T("commission", { name: "builder", task: "Write js/b.js with window.B = 2 and check it with node --check.", files: "js/b.js" }), "Here is my plan."][r.turn] ?? "Done.";
      return "Made it.";
    });
    y.send({ type: "mode", mode: "plan" });
    y.send({ type: "command", text: "/crew plan it" });
    const q = await y.waitFor((e) => e.type === "ask" && /Go ahead with this plan/.test(e.title || ""), 40000, "the plan question");
    y.send({ type: "answer", id: q.id, choice: 2 });
    await y.waitFor((e) => e.type === "done" && y.events.some((x) => x.type === "busy"), 20000, "done");
    await sleep(500);
    assert.strictEqual(srv.of("helper").length, 0, "no helper started");
    assert.match(srv.of("main")[1].all, /plan mode/i);
  } },
  { name: "background agents don't save their own sessions (yai -c must find the chat, not a helper)", ms: 60000, fn: async (ctl) => {
    const { y } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") return [T("write_file", { path: "js/h.js", content: "window.H = 1;" }), "Made js/h.js."][r.turn] ?? "Done.";
      if (r.who === "main") return ["<plan>\n1. a\n</plan>\n" + T("commission", { name: "h", task: "Write js/h.js with window.H = 1 and check it with node --check.", files: "js/h.js" }), T("crew_wait", {}), "Done."][r.turn] ?? "Done.";
      return "Done.";
    }, { name: "sessions" });
    await command(y, "/crew build h", { mode: "acceptEdits" });
    await sleep(800);
    const dir = path.join(homeEnv().YAI_DIR, "sessions");
    const mine = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))).filter((s) => /background agent working for the main agent|research the topic before/.test(String(s.messages?.[0]?.content || "")));
    assert.strictEqual(mine.length, 0, `${mine.length} background agents saved a session`);
  } },
  { name: "/crew off ends it: a plain chat again, without the crew's prompt", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, async (r) => (r.who === "researcher" ? research(r) : r.who === "main" ? "<plan>\n1. a\n</plan>\nDone." : "Plain answer."));
    await command(y, "/crew something", { mode: "acceptEdits" });
    await command(y, "/crew off");
    await ask(y, "hello");
    assert.strictEqual(srv.log[srv.log.length - 1].who, "other");
  } },
  { name: "a second /crew in the same chat gets a fresh researcher for the new task", ms: 90000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, async (r) => (r.who === "researcher" ? research(r) : r.who === "main" ? "<plan>\n1. a\n</plan>\nDone." : "Done."));
    await command(y, "/crew a snake game", { mode: "acceptEdits" });
    await command(y, "/crew a chess clock", { mode: "acceptEdits" });
    const second = srv.of("researcher").filter((r) => /chess clock/.test(r.all));
    assert.ok(second.length, "a researcher worked on the chess clock");
    assert.strictEqual(second[0].turn, 0, "in a fresh conversation, not the snake game's");
    assert.ok(!/snake game/.test(second[0].all), "with nothing of the first task in it");
  } },
  { name: "a helper whose model fails is reported as failed, with the reason", ms: 60000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") return { status: 500, error: "upstream exploded" };
      if (r.who === "main") return ["<plan>\n1. a\n</plan>\n" + T("commission", { name: "boom", task: "Write js/boom.js with window.BOOM = 1 and check it with node --check.", files: "js/boom.js" }), T("crew_wait", {}), "Done."][r.turn] ?? "Done.";
      return "Done.";
    });
    await command(y, "/crew boom", { mode: "acceptEdits" });
    assert.match(srv.of("main")[2].all, /failed: upstream exploded/);
  } },
  { name: "the same name in other letter case wakes the earlier agent, and crew_wait doesn't hang on it", ms: 90000, fn: async (ctl) => {
    const { y, srv } = await session(ctl, async (r) => {
      if (r.who === "researcher") return research(r);
      if (r.who === "helper") return ["Made js/l.js.", "Made the follow-up."][r.turn] ?? "Done.";
      if (r.who === "main") return ["<plan>\n1. a\n</plan>\n" + T("commission", { name: "levels", task: "Write js/l.js with window.L = 1 and check it with node --check.", files: "js/l.js" }), T("crew_wait", {}), T("commission", { name: "Levels", task: "Add a fourth level to js/l.js and check it again with node --check.", files: "js/l.js" }), T("crew_wait", { minutes: "1" }), "Done."][r.turn] ?? "Done.";
      return "Done.";
    });
    const t0 = Date.now();
    await command(y, "/crew levels", { mode: "acceptEdits", ms: 80000 });
    assert.ok(Date.now() - t0 < 40000, "crew_wait didn't wait out its minute");
    assert.match(srv.of("main")[4].all, /Made the follow-up/);
    assert.match(srv.of("main")[4].all, /No helper is working now/);
  } },
]);
