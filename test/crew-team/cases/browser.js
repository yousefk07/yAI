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
