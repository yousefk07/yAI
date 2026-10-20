"use strict";
// /bench (2026-10-20): the yAI coding benchmark on any model. Six small tasks with 44 tests (cli/bench/, the same ones
// as yai-demo/bench) are copied to a temporary folder, and yAI Code works through each one on its own, the way
// `yai -p "<task>" --accept-edits --allow-commands` would: a fresh session per task and 5 minutes at most. Then every
// task's tests run. A test file the model changed is put back first and the task is flagged, so it can't pass by
// editing the tests. The score goes to ~/.yai/bench.json and to the site's leaderboard (/arena → Leaderboard).

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const TASKS_DIR = path.join(__dirname, "bench");
const CLI = path.join(__dirname, "index.js");
const LIMIT_MS = 5 * 60 * 1000;
const PROMPTS = {
  "01-text": "The tests in bench/01-text are failing. Fix the bugs in bench/01-text/text.js so that `node --test` passes in that folder. Don't change the test file.",
  "02-lru": "Implement the LRUCache class in bench/02-lru/lru.js so that the tests in bench/02-lru/lru.test.js pass. Run `node --test` in that folder to check. Don't change the test file.",
  "03-business-days": "bench/03-business-days/days.js gets delivery dates wrong. Fix it so that `node --test` passes in bench/03-business-days. Don't change the test file.",
  "04-csv": "The CSV parser in bench/04-csv/csv.js only handles simple files. Rewrite parseCSV so it follows the rules in the comment and `node --test` passes in bench/04-csv. Don't change the test file.",
  "05-inventory": "Make the tests in bench/05-inventory/inventory.test.js pass. You'll need to change both store.js and report.js. Run `node --test` in that folder to check. Don't change the test file.",
  "06-retry": "Implement retry() in bench/06-retry/retry.js as described in its comment, so that `node --test` passes in bench/06-retry. Don't change the test file.",
};
const hash = (file) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`);

// Runs a task folder's tests and counts them (TAP output).
function score(dir) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=10000"], { cwd: dir, encoding: "utf8", timeout: 60000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const num = (name) => Number((out.match(new RegExp(`^# ${name} (\\d+)`, "m")) || [])[1] || 0);
  const passed = num("pass"), failed = num("fail") + num("cancelled");
  return { passed, total: passed + failed };
}

function copyTasks(dest) {
  const tests = {};
  for (const task of Object.keys(PROMPTS)) {
    const from = path.join(TASKS_DIR, task), to = path.join(dest, "bench", task);
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      fs.copyFileSync(path.join(from, f), path.join(to, f));
      if (f.endsWith(".test.js")) tests[`${task}/${f}`] = hash(path.join(from, f));
    }
  }
  return tests;
}

module.exports = function create({ state, api, ui, syncMute, findModel, modelLabel }) {
  const { c, print, spinner } = ui;

  function runTask(task, model, cwd, logFile, signal) {
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [CLI, "-p", PROMPTS[task], "--accept-edits", "--allow-commands", "-m", model], {
        cwd, env: { ...process.env, NO_COLOR: "1", YAI_NO_MCP: "1" }, windowsHide: true,
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.stdin.end();
      let why = "";
      const kill = (reason) => {
        why = reason;
        try {
          if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
          else child.kill("SIGKILL");
        } catch {}
      };
      const timer = setTimeout(() => kill("stopped at 5 min"), LIMIT_MS);
      const onAbort = () => kill("stopped");
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        fs.writeFileSync(logFile, out);
        const allowance = /used today's \$|allowance/i.test(out);
        resolve({ secs: Math.round((Date.now() - started) / 1000), why, allowance, noReply: /No reply from the model/.test(out) });
      });
    });
  }

  // /bench [model] [--keep]
  async function bench(arg) {
    const words = arg.split(/\s+/).filter(Boolean);
    const keep = words.includes("--keep");
    const q = words.filter((w) => w !== "--keep").join(" ");
    const m = q ? findModel(q) : state.models.find((x) => x.id === state.model);
    if (!m) return print(c.yellow(q ? `No model matches "${q}".` : "Pick a model first with /model."));

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "yai-bench-"));
    const tests = copyTasks(work);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logs = path.join(api.DIR, "bench", `${stamp}-${m.id.replace(/[^\w.-]/g, "_")}`);
    fs.mkdirSync(logs, { recursive: true });

    state.busy = true;
    state.interrupted = false;
    state.abort = new AbortController();
    syncMute();
    ui.resetSections();
    print("");
    ui.toolHeader("Bench", `${m.label} · 6 tasks · 44 tests`);
    ui.toolResult(c.dim("each task gets a fresh session and up to 5 minutes · esc stops"));
    const rows = [];
    try {
      for (const task of Object.keys(PROMPTS)) {
        const t0 = Date.now();
        spinner.start(`${task} · working`);
        const tick = setInterval(() => spinner.text(`${task} · working · ${fmtSecs(Math.round((Date.now() - t0) / 1000))}`), 1000);
        const r = await runTask(task, m.id, work, path.join(logs, `${task}.log`), state.abort.signal);
        clearInterval(tick);
        spinner.stop();
        if (state.interrupted) break;
        // A changed test file is put back before scoring, and the task is marked.
        const dir = path.join(work, "bench", task);
        let tampered = false;
        for (const [key, h] of Object.entries(tests)) {
          if (!key.startsWith(task + "/")) continue;
          const file = path.join(work, "bench", key);
          if (!fs.existsSync(file) || hash(file) !== h) {
            tampered = true;
            fs.copyFileSync(path.join(TASKS_DIR, key), file);
          }
        }
        const s = score(dir);
        const row = { task, ...s, secs: r.secs, tampered };
        rows.push(row);
        const ok = s.total && s.passed === s.total;
        const mark = ok ? c.green("✓") : s.passed ? c.yellow("◐") : c.red("✕");
        const notes = [r.why, tampered && "changed the test file", r.noReply && "no reply from the model", r.allowance && "daily allowance reached"].filter(Boolean).join(" · ");
        print(`   ${mark} ${c.ink(task.padEnd(18))} ${String(`${s.passed}/${s.total}`).padStart(5)}  ${c.dim(fmtSecs(r.secs).padStart(7))}${notes ? c.dim("  " + notes) : ""}`);
        if (r.allowance) {
          print(c.yellow("   Stopped: today's allowance for this model is used up."));
          break;
        }
      }
    } finally {
      spinner.stop();
      state.busy = false;
      state.abort = null;
      syncMute();
    }
    if (!rows.length) return print(c.dim("   Nothing finished."));

    const passed = rows.reduce((n, r) => n + r.passed, 0);
    const total = Object.keys(PROMPTS).length === rows.length ? rows.reduce((n, r) => n + r.total, 0) : 44;
    const solved = rows.filter((r) => r.total && r.passed === r.total && !r.tampered).length;
    const secs = rows.reduce((n, r) => n + r.secs, 0);
    print("");
    print(`   ${c.bold(c.ink(`${passed}/${total} tests`))} ${c.dim(`· ${solved}/6 tasks solved · ${fmtSecs(secs)} in all`)}`);
    const result = { model: m.id, label: m.label, passed, total, solved, secs, tasks: rows, complete: rows.length === 6, ts: new Date().toISOString() };
    // Kept locally, and sent to the site's leaderboard when the run is complete.
    try {
      const file = path.join(api.DIR, "bench.json");
      const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
      all.push(result);
      fs.writeFileSync(file, JSON.stringify(all, null, 1));
    } catch {}
    if (result.complete && !state.interrupted) {
      try {
        await api.postBench(result);
        print(c.dim(`   on the leaderboard: ${api.baseUrl()}/arena#leaderboard`));
      } catch (err) {
        print(c.dim(`   couldn't add it to the leaderboard: ${err.message}`));
      }
    }
    print(c.dim(`   logs: ${logs}`));
    if (keep) print(c.dim(`   the model's work: ${path.join(work, "bench")}`));
    else fs.rm(work, { recursive: true, force: true }, () => {});
    state.pendingContext.push(`I ran /bench on ${m.label}: ${passed}/${total} tests, ${solved}/6 tasks solved, ${fmtSecs(secs)}.`);
  }

  return { bench };
};
