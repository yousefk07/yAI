"use strict";
// yAI's own page checks (cli/teamchecks.js) in a real headless Chrome: what agents' page_eval and check_page use
const assert = require("assert");
const path = require("path");
const { suite, REPO, project } = require("../lib/harness");
const TC = require(path.join(REPO, "cli", "teamchecks.js"));
const B = require(path.join(REPO, "cli", "browser.js"));
const page = (body) => `<!doctype html><html><body>${body}</body></html>`;
const ok = !!B.findChrome();

suite(__filename, ok ? [
  { name: "page_eval returns a value and the page's errors", ms: 60000, fn: async () => {
    const d = project("pe", { "index.html": page('<script>window.G = { n: 41 }; console.error("bad thing");</script>') });
    const r = await TC.pageEval({ entry: path.join(d, "index.html"), code: "window.G.n + 1" });
    assert.strictEqual(r.value, "42");
    assert.ok(r.errors.some((e) => /bad thing/.test(e)));
  } },
  { name: "a start screen drawn on a canvas is started (no DOM button to find)", ms: 60000, fn: async () => {
    const game = '<canvas id="c" width="960" height="540" style="width:100vw;height:100vh;display:block"></canvas><style>body{margin:0}</style><script>window.started = false; const c = document.getElementById("c"), g = c.getContext("2d"); g.fillStyle = "#246"; g.fillRect(0, 0, 960, 540); g.fillStyle = "#fa2"; g.fillRect(380, 300, 200, 60); g.fillStyle = "#000"; g.font = "30px sans-serif"; g.fillText("Start", 445, 340); c.addEventListener("click", (e) => { const r = c.getBoundingClientRect(), x = (e.clientX - r.left) * 960 / r.width, y = (e.clientY - r.top) * 540 / r.height; if (x > 380 && x < 580 && y > 300 && y < 360) window.started = true; });</script>';
    const d = project("canvas-start", { "index.html": page(game) });
    const r = await TC.pageEval({ entry: path.join(d, "index.html"), code: "window.started" });
    assert.strictEqual(r.value, "true");
  } },
  { name: "page checks again and again don't pile up exit listeners", ms: 120000, fn: async () => {
    const before = process.listenerCount("exit");
    for (let i = 0; i < 4; i++) {
      const d = project(`pe-many-${i}`, { "index.html": page(`<script>window.N = ${i};</script>`) });
      const r = await TC.pageEval({ entry: path.join(d, "index.html"), code: "window.N" });
      assert.strictEqual(r.value, String(i));
    }
    assert.ok(process.listenerCount("exit") - before <= 1, `${process.listenerCount("exit") - before} exit listeners added`);
  } },
  { name: "a page whose script never yields: page_eval gives up, it doesn't hang", ms: 90000, fn: async () => {
    const d = project("pe-frozen", { "index.html": page("<button onclick=\"while(true){}\">Play</button>") });
    const t0 = Date.now();
    const r = await TC.pageEval({ entry: path.join(d, "index.html"), code: "1" });
    assert.ok(r.timedOut || r.value == null || /Error/.test(String(r.value)), JSON.stringify(r).slice(0, 200));
    assert.ok(Date.now() - t0 < 60000);
  } },
] : [{ name: "(no Chrome here: the browser cases were skipped)", fn: () => {} }]);
