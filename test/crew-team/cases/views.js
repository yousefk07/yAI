"use strict";
// The /team board and agent view (cli/teamview.js through team.js's own view builders) at odd widths and heights
const assert = require("assert");
const path = require("path");
const { suite, REPO, strip, homeEnv } = require("../lib/harness");

Object.assign(process.env, homeEnv());
const ui = require(path.join(REPO, "cli", "ui.js"));
const state = { models: [{ id: "deepseek-v4.1-flash", label: "yAI Ultra Flash", cloud: true }, { id: "glm-4.7-flash", label: "yAI Lite", cloud: true }], model: "deepseek-v4.1-flash", mode: "acceptEdits", cost: { session: 0 } };
const TEAM = require(path.join(REPO, "cli", "team.js"))({ state, root: process.cwd(), api: require(path.join(REPO, "cli", "api.js")), ui, X: {}, syncMute() {}, runAgent() {}, select: async () => 0, checklist: async () => null, inputLine: () => "", testCounts: () => null, riskOf: () => ({ tag: "" }), topLevel: () => "", modelLabel: () => "yAI Ultra Flash" });
const { runView, agentView, V } = TEAM._views;
const now = Date.now();
const long = "a very long task description that goes on and on about building a voxel game with menus, terrain, mining, crafting, mobs and sound ".repeat(4);
const agents = [
  { name: "world and terrain", task: long, files: ["js/world.js", "js/noise.js"], phase: 1, state: "working", step: "Edit js/world.js " + "x".repeat(300), started: now - 90000, cost: 0.0123, changed: new Set(["js/world.js"]), created: new Set(), text: ["line"], asks: [], log: [{ k: "brief", text: long }, { k: "step", verb: "Edit", arg: "js/world.js" }, { k: "result", text: "ok" }, { k: "diff", path: "js/world.js", added: 1, removed: 0, lines: [["+", 1, "a"], ["…", "", ""], [" ", 9, "b"]] }, { k: "text", line: "said " + "y".repeat(500) }, { k: "out", line: "\tout\rput" }, { k: "you", text: "a note" }, { k: "ask", text: "Run this command?", detail: "node x.js" }, { k: "error", text: "boom" }, { k: "chat", from: "cli", text: "hi" }, { k: "gap" }], plan: { steps: ["one", "two", "three"], done: 1 }, model: "glm-4.7-flash", eff: { read: 1, edit: 2, run: 0, check: 0, search: 0, other: 0, refused: 0 } },
  { name: "x", task: "", files: [], phase: 1, state: "done", step: "", started: now - 50000, ended: now - 1000, cost: 0, changed: new Set(), created: new Set(), text: [], asks: [], log: [], model: "deepseek-v4.1-flash" },
  { name: "qa", role: "qa", task: "checks", files: [], phase: 2, state: "waiting", step: "after the builders", started: now, changed: new Set(), created: new Set(), text: [], asks: [], log: [], hasVerdict: true },
  { name: "fixer", role: "fixer", task: "fixes", files: [], phase: 3, state: "skipped", step: "nothing to fix", started: now, ended: now, changed: new Set(), created: new Set(), text: [], asks: [], log: [] },
  { name: "browser", role: "browser", internal: true, task: "opens it", files: [], phase: 1.5, state: "failed", error: "Chrome didn't start", started: now - 3000, ended: now, changed: new Set(), created: new Set(), text: ["FROZEN"], asks: [], log: [], verdict: "FAIL" },
];
const WIDTHS = [1, 10, 20, 39, 40, 60, 80, 100, 120, 200, 400];

suite(__filename, [
  { name: "the board draws at every width without throwing", fn: () => {
    for (const w of WIDTHS) for (const h of [5, 16, 60]) {
      const v = runView(agents, long, 3, 0, 0.05);
      const lines = V.runLines({ ...v, width: w, height: h });
      assert.ok(Array.isArray(lines) && lines.length, `width ${w}`);
      for (const l of lines) assert.strictEqual(typeof l, "string");
    }
  } },
  // (the board and the agent view are drawn at least 70 wide, by design)
  { name: "the board's rows aren't wider than the screen (or 70)", fn: () => {
    for (const w of [40, 60, 80, 120, 200]) {
      process.stdout.columns = w + 2; // (screenW() reads it)
      const lines = V.runLines({ ...runView(agents, long, 3, 0, 0.05), width: w, height: 40 });
      const over = lines.map(strip).filter((l) => l.length > Math.max(70, w));
      assert.deepStrictEqual(over.map((l) => `${l.length}: ${l.slice(0, 60)}`), [], `width ${w}`);
    }
  } },
  { name: "one agent's view draws at every width", fn: () => {
    for (const a of agents) for (const w of WIDTHS) {
      const lines = V.agentLines({ ...agentView(a, agents, 2), width: w, height: 30 });
      assert.ok(Array.isArray(lines), `${a.name} at ${w}`);
    }
  } },
  { name: "the agent view fits its width, the transcript beside the side panel included", fn: () => {
    for (const w of [100, 120, 160]) { // (narrower, there is no side panel and the screen wraps long rows itself)
      process.stdout.columns = w + 2;
      const lines = V.agentLines({ ...agentView(agents[0], agents, 2), width: w, height: 40 });
      const over = lines.map(strip).filter((l) => l.length > Math.max(70, w));
      assert.deepStrictEqual(over.map((l) => `${l.length}: ${l.slice(0, 60)}`), [], `width ${w}`);
    }
  } },
  { name: "an empty team and odd values don't throw", fn: () => {
    V.runLines({ ...runView([], "", 0, -1, 0), width: 80, height: 20 });
    V.runLines({ ...runView(agents, "", NaN, 99, NaN), width: NaN, height: NaN });
    V.agentLines({ ...agentView({ ...agents[0], log: undefined, plan: null }, agents, 0), width: 80, height: 10 });
  } },
  { name: "the picker draws at every width", fn: () => {
    for (const w of WIDTHS) {
      const lines = V.pickLines({ title: "Pick your team", sub: long, width: w, sel: 0, presets: [{ label: "Quick", count: 2, on: true }], start: { n: 3, time: "~4 min", cost: "~$0.20", parallel: 2, rounds: 1, cap: "", short: "" }, groups: [{ name: "BUILD", note: "2 at the same time", rows: [{ n: 1, label: "world", on: true, model: "Ultra Flash", desc: long, est: "4m · $0.05" }, { n: 2, label: "qa", on: false, model: "Lite", desc: "checks", est: "free", builtIn: true }] }] });
      assert.ok(lines.length);
    }
  } },
]);
