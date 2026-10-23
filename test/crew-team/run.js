#!/usr/bin/env node
"use strict";
// The /crew and /team suite (2026-10-23): every file in cases/ is one area, run in its own process (several at once);
// each case prints pass or fail. No real model is used: a fake yAI site answers (lib/harness.js).
//
//   node test/crew-team/run.js                  everything
//   node test/crew-team/run.js loops crew       only the areas whose file names match
//   CASE="takeover" node test/crew-team/run.js  only the cases whose names match
//   JOBS=6                                      areas at once (default 4)
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const dir = path.join(__dirname, "cases");
const want = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).filter((f) => !want.length || want.some((w) => f.includes(w))).sort();
const JOBS = Number(process.env.JOBS) || 4;
const results = [];
const t0 = Date.now();
const green = (s) => `\x1b[32m${s}\x1b[0m`, red = (s) => `\x1b[31m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`;

function runFile(f) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [path.join(dir, f)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: process.env });
    let buf = "", err = "";
    const seen = [];
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (!r || r.name == null) continue;
        seen.push(r); results.push(r);
        console.log(`${r.ok ? green("pass") : red("FAIL")} ${f.replace(/\.js$/, "")} · ${r.name} ${dim(`${(r.ms / 1000).toFixed(1)}s`)}`);
        if (!r.ok) console.log(r.err.split("\n").map((l) => "     " + l).join("\n"));
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    // a whole area may take a while (real child processes), but never forever
    const kill = setTimeout(() => { child.kill(); }, Number(process.env.AREA_MS) || 15 * 60000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      if (code !== 0 || !seen.length) {
        const r = { file: f, name: "(the area itself)", ok: false, ms: 0, err: `exit ${code}\n${err.slice(-3000)}` };
        results.push(r);
        console.log(`${red("FAIL")} ${f} · the area crashed or ran no case\n${err.slice(-3000)}`);
      }
      done();
    });
  });
}

(async () => {
  const queue = [...files];
  await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => { while (queue.length) await runFile(queue.shift()); }));
  const failed = results.filter((r) => !r.ok);
  const byFile = {};
  for (const r of results) (byFile[r.file] ||= { pass: 0, fail: 0 })[r.ok ? "pass" : "fail"]++;
  console.log("\n" + Object.entries(byFile).map(([f, n]) => `  ${f.padEnd(28)} ${n.pass} passed${n.fail ? red(`, ${n.fail} failed`) : ""}`).join("\n"));
  console.log(`\n${failed.length ? red(`${failed.length} failed`) : green("all passed")} · ${results.length - failed.length} of ${results.length} cases · ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exit(failed.length ? 1 : 0);
})();
