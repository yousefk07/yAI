"use strict";
// yAI Code extras (2026-10-20): /showcase (a demo video of the project), /look and image @mentions (a vision model
// looks at the page or a mockup), /duo (two models: one plans and reviews, the coder writes), /fix and test watch,
// /commit, /review, /share (a public replay of the session) and /tutor. index.js wires them in with create(deps).

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const B = require("./browser");

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_IMAGE_BYTES = 2_500_000;
const SKIP_DIRS = /(^|[\\/])(node_modules|\.git|yai-media|dist|build|\.next|coverage)([\\/]|$)/;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);
const tail = (s, n) => (s.length > n ? `… (${s.length - n} earlier characters)\n` + s.slice(-n) : s);
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

const LOOK_SYSTEM =
  "You are a senior UI designer reviewing a web page from screenshots. List the concrete visual problems, most important first: " +
  "broken layout, overflow, overlapping or cut-off text, misalignment, uneven spacing, poor contrast or readability, inconsistent " +
  "styles, and anything that breaks on the phone view. For each one say where it is, what is wrong, and the fix (CSS-level when you " +
  "can). At most 8 items. If the page looks good, say so in one line. Plain Markdown, no tool calls.";
const DESCRIBE_SYSTEM =
  "Describe this image for a developer who will rebuild it in code. Cover the layout from top to bottom, every visible piece of text " +
  "(exactly as written), colours as hex values, font styles and sizes, spacing, borders and corner radius, and each component and its " +
  "state. Be precise and complete; no opinions, no tool calls.";
const PLAN_SYSTEM =
  "You are the planner on a two-model coding team. A coding model will carry out your plan with file and shell tools. Write a short, " +
  "concrete plan for the request: at most 8 numbered steps, naming the files to look at or change and how to check the result. " +
  "Don't write the code itself. If the request is a simple question, reply with one step: answer it. No tool calls.";
const REVIEW_CHANGE_SYSTEM =
  "You are the reviewer on a two-model coding team. The coding model just made the change below for the user's request. If it is " +
  "correct and complete, reply with exactly: LGTM. Otherwise list the real problems (file and line, what is wrong, how to fix it), " +
  "at most 6, most serious first. Ignore style nits. No tool calls.";
const COMMIT_SYSTEM =
  "Write a git commit message for the staged change. First line: a short summary in the imperative mood, at most 72 characters. " +
  "Then, if it isn't obvious, a blank line and 1 to 4 short lines saying what changed and why. Plain text only: no code fences, " +
  "no quotes around it, no tool calls.";
const REVIEW_SYSTEM =
  "You are a careful senior engineer reviewing a change before it is committed. Report real problems only, most serious first: bugs, " +
  "broken edge cases, security issues, missing error handling, and changed behaviour the tests don't cover. For each: file and line, " +
  "the problem, and the fix. Then at most 3 small suggestions. If it is good, say so in one line. Be specific and brief. Markdown, no tool calls.";
const TUTOR_PROMPT = `

# Tutor mode (on)
The user is a student learning to code. Your job is to help them learn, not to do the work for them.
- Never write the solution, a whole function, or a complete fix for their task. Don't paste corrected code.
- Lead them to it: ask what they expect to happen, point to the file and line where the problem is, explain the concept behind it, and give the next small step as a hint. Give a bigger hint only if they're still stuck.
- A tiny example of syntax is fine (at most 3 lines) when it is about a general idea and not their exact answer.
- You can read their files and run their tests to see what's happening; editing files is switched off in tutor mode.
- When they show you their attempt, say what is right first, then what to look at next.
- Be warm and encouraging, and keep explanations short and plain.`;

module.exports = function create(d) {
  const { state, ctx, root, api, ui, T } = d;
  const { c, print, spinner } = ui;

  // ---------- shared helpers ----------
  const printMarkdown = (text) => {
    const w = ui.markdownWriter();
    for (const line of String(text).split("\n")) w(line);
  };
  const relPath = (abs) => T.rel(ctx, abs);
  // The model that can see images (yAI Q3.8 Max, Qwen 3.8 27B on the cloud GPU), which also plans and reviews in /duo.
  const visionModel = () => state.models.find((m) => m.vision && /cloud/.test(m.id)) || state.models.find((m) => m.vision);
  const partnerModel = () => state.models.find((m) => m.id !== state.model && /cloud/.test(m.id) && m.vision);

  // One request to a model with no tools (planning, reviewing, describing, commit messages).
  async function oneShot({ model, system, messages, signal }) {
    if (!state.warmed.has(model)) {
      await api.warmup(model, { signal, onProgress: (t) => spinner.text(t) });
      state.warmed.add(model);
    }
    let text = "";
    await api.chat({ model, system, messages, conversationId: state.conversationId, signal, onTokens: (n) => spinner.tokens(n), onStatus: (s) => spinner.text(s), onText: (p) => void (text += p) });
    return text.replace(/<tool[\s\S]*$/, "").trim();
  }

  // Runs one piece of work with the spinner and Esc support, like a normal request.
  async function busy(label, fn) {
    state.busy = true;
    state.interrupted = false;
    state.abort = new AbortController();
    d.syncMute();
    spinner.start(label);
    try {
      return await fn(state.abort.signal);
    } finally {
      spinner.stop();
      state.busy = false;
      state.abort = null;
      d.syncMute();
    }
  }
  const failed = (err) => print(c.red(`   ${state.interrupted ? "Stopped." : err.message}`));

  function git(args, input) {
    const r = spawnSync("git", args, { cwd: root, input, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    return { ok: r.status === 0, out: (r.stdout || "").trimEnd(), err: (r.stderr || "").trim() };
  }
  const isRepo = () => git(["rev-parse", "--is-inside-work-tree"]).ok;
  const mediaDir = () => {
    const dir = path.join(root, "yai-media");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

  // What /look and /showcase open: a URL, an .html file, or the project's own index.html. Files are served from the
  // project folder so their scripts, styles and images load.
  async function target(arg) {
    const a = String(arg || "").trim().replace(/^@/, "");
    if (/^https?:\/\//i.test(a)) return { url: a, label: a, close() {} };
    let file = a ? T.resolve(ctx, a) : ["index.html", "public/index.html", "src/index.html", "dist/index.html"].map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
    if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!file || !fs.existsSync(file)) {
      throw new Error("Nothing to open. Give a URL (a running dev server, e.g. http://localhost:5173) or an .html file in this folder.");
    }
    const srv = await B.serveFolder(root);
    const rel = relPath(file).split(path.sep).map(encodeURIComponent).join("/");
    return { url: `${srv.url}/${rel}`, label: relPath(file), close: srv.close };
  }
  // "/look http://x focus on the header" -> target "http://x", focus "focus on the header".
  function splitTarget(arg) {
    const [first, ...rest] = String(arg || "").trim().split(/\s+/);
    const looksLikeTarget = first && (/^https?:\/\//i.test(first) || /\.html?$/i.test(first) || first.startsWith("@") || fs.existsSync(path.join(root, first)));
    return looksLikeTarget ? { where: first, focus: rest.join(" ") } : { where: "", focus: String(arg || "").trim() };
  }
  const imagePart = (buf, mime = "image/jpeg") => ({ type: "image_url", image_url: { url: `data:${mime};base64,${buf.toString("base64")}` } });

  // ---------- /look: a vision model reviews the page ----------
  async function look(arg) {
    const vm = visionModel();
    if (!vm) return print(c.yellow("   /look needs a model that can see images (yAI Q3.8 Max), and none is available right now."));
    const { where, focus } = splitTarget(arg);
    let t;
    try {
      t = await target(where);
    } catch (err) {
      return print(c.yellow(`   ${err.message}`));
    }
    try {
      const review = await busy(`opening ${t.label}`, async (signal) => {
        const b = await B.launch({ width: 1280, height: 800 });
        let desktop, phone;
        try {
          await B.setViewport(b, 1280, 800);
          await B.open(b, t.url);
          desktop = await B.screenshot(b, { quality: 65 });
          await B.setViewport(b, 390, 844, true);
          await B.open(b, t.url);
          phone = await B.screenshot(b, { quality: 65 });
        } finally {
          b.close();
        }
        const dir = mediaDir();
        fs.writeFileSync(path.join(dir, "look-desktop.jpg"), desktop);
        fs.writeFileSync(path.join(dir, "look-phone.jpg"), phone);
        spinner.text(`${vm.label} is looking at it`);
        return oneShot({
          model: vm.id,
          system: LOOK_SYSTEM,
          signal,
          messages: [{ role: "user", content: [
            { type: "text", text: `Review this page${focus ? `, focusing on: ${focus}` : ""}. The first screenshot is a desktop window (1280×800), the second a phone (390×844).` },
            imagePart(desktop),
            imagePart(phone),
          ] }],
        });
      });
      print("");
      print(`   ${c.accent("◆")} ${c.ink(`${vm.label} looked at ${t.label}`)} ${c.dim("· screenshots in yai-media/look-*.jpg")}`);
      printMarkdown(review);
      state.pendingContext.push(`I had ${vm.label} look at the page (${t.label}, desktop 1280×800 and phone 390×844). Its review:\n${review}`);
      print(c.dim('\n   Say "fix these" and yAI will work through them.'));
    } catch (err) {
      failed(err);
    } finally {
      t.close();
    }
  }

  // ---------- image @mentions: "@mockup.png build this" ----------
  const isImage = (p) => !!IMAGE_TYPES[path.extname(p).toLowerCase()];
  // The coder can't see images, so a vision model writes a precise description that goes in the message instead.
  async function describeImages(files) {
    const vm = visionModel();
    const out = [];
    for (const abs of files) {
      const rel = relPath(abs);
      const buf = fs.readFileSync(abs);
      if (!vm || buf.length > MAX_IMAGE_BYTES) {
        ui.toolHeader("Read", rel);
        ui.toolResult(!vm ? "skipped · no model that can see images is available" : "skipped · image over 2.5 MB", { color: c.yellow });
        continue;
      }
      ui.toolHeader("Look", rel);
      try {
        const text = await busy(`${vm.label} is looking at ${path.basename(rel)}`, (signal) =>
          oneShot({ model: vm.id, system: DESCRIBE_SYSTEM, signal, messages: [{ role: "user", content: [{ type: "text", text: "Describe this image." }, imagePart(buf, IMAGE_TYPES[path.extname(abs).toLowerCase()])] }] })
        );
        ui.toolResult(`described by ${vm.label}`);
        out.push(`<image path="${rel}" described-by="${vm.label}">\n${text}\n</image>`);
      } catch (err) {
        ui.toolResult(err.message, { color: c.yellow });
      }
    }
    return out;
  }

  // ---------- /showcase: a demo video of the project ----------
  async function showcase(arg) {
    const ff = B.findFfmpeg();
    if (!ff) return print(c.yellow("   /showcase needs ffmpeg to make the video. Install it with: winget install Gyan.FFmpeg (then open a new terminal)."));
    const { where } = splitTarget(arg);
    let t;
    try {
      t = await target(where);
    } catch (err) {
      return print(c.yellow(`   ${err.message}`));
    }
    const out = path.join(mediaDir(), `showcase-${stamp()}.mp4`);
    const FPS = 30;
    let frames = 0;
    try {
      await busy(`recording a tour of ${t.label}`, async (signal) => {
        const b = await B.launch({ width: 1280, height: 720 });
        const enc = spawn(ff, ["-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
          "-pix_fmt", "yuv420p", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2", "-movflags", "+faststart", out],
          { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        const write = async (buf, n = 1) => {
          for (let i = 0; i < n; i++) {
            if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once("drain", r));
            frames++;
          }
          spinner.text(`recording a tour of ${t.label} · ${Math.round(frames / FPS)}s of video`);
        };
        const shot = () => B.screenshot(b, { quality: 88 });
        const stop = () => { if (signal.aborted) throw new Error("Stopped."); };
        try {
          await B.setViewport(b, 1280, 720);
          await B.open(b, t.url);
          // 1. The top of the page.
          await write(await shot(), FPS * 1.5);
          // 2. A smooth scroll to the bottom (about 9 px a frame, at most 14 s), and a pause there.
          const height = (await B.evaluate(b, "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")) || 720;
          const dist = Math.max(0, height - 720);
          const steps = Math.min(FPS * 14, Math.max(FPS, Math.round(dist / 9)));
          if (dist > 0) {
            let last;
            for (let i = 1; i <= steps; i++) {
              stop();
              await B.evaluate(b, `window.scrollTo(0, ${Math.round(dist * ease(i / steps))})`);
              await write((last = await shot()));
            }
            await write(last, FPS);
            await B.evaluate(b, "window.scrollTo(0, 0)");
            await write(await shot(), FPS / 2);
          }
          // 3. A few things to click in the first screen (buttons, tabs, in-page links), each highlighted first.
          const picks = (await B.evaluate(b, `(() => {
            const ok = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
              return r.width > 20 && r.height > 14 && r.top >= 0 && r.bottom <= innerHeight && s.visibility !== "hidden" && s.display !== "none"
                && !(e.type === "submit" && e.form) && !e.disabled; };
            return [...document.querySelectorAll('button, [role="button"], [role="tab"], a[href^="#"], summary')].filter(ok).slice(0, 4)
              .map((e, i) => (e.setAttribute("data-yai-tour", i), i));
          })()`)) || [];
          for (const i of picks) {
            stop();
            await B.evaluate(b, `(() => { const e = document.querySelector('[data-yai-tour="${i}"]'); if (!e) return;
              e.scrollIntoView({ block: "center" }); e.dataset.yaiOutline = e.style.outline; e.style.outline = "3px solid #7c5cff"; e.style.outlineOffset = "3px"; })()`);
            await write(await shot(), Math.round(FPS * 0.6));
            await B.evaluate(b, `(() => { const e = document.querySelector('[data-yai-tour="${i}"]'); if (!e) return;
              e.style.outline = e.dataset.yaiOutline || ""; e.click(); })()`);
            for (let k = 0; k < 12; k++) await write(await shot(), 3); // ~1.2 s of whatever the click did
          }
          await write(await shot(), FPS);
        } finally {
          enc.stdin.end();
          await new Promise((r) => enc.on("close", r));
          b.close();
        }
      });
      ui.note(`${c.green("✓")} ${c.ink(`Showcase video: ${relPath(out)}`)} ${c.dim(`· ${Math.round(frames / FPS)}s · 1280×720`)}`);
    } catch (err) {
      failed(err);
      try { if (fs.existsSync(out) && frames < FPS) fs.unlinkSync(out); } catch {}
    } finally {
      t.close();
    }
  }

  // ---------- /duo: the partner model plans first and reviews the result ----------
  function toggleDuo(arg) {
    const want = /^(on|off)$/i.test(arg) ? arg.toLowerCase() === "on" : !state.duo;
    const p = partnerModel();
    if (want && !p) return print(c.yellow("   /duo needs a second cloud model (yAI Q3.8 Max) to plan and review, and it isn't available right now."));
    state.duo = want;
    ui.note(want
      ? `${c.accent("◆")} ${c.ink(`duo on`)} ${c.dim(`· ${p.label} plans each request and reviews the changes; ${d.modelLabel()} writes the code`)}`
      : `${c.dim("duo off · one model again")}`);
  }
  async function duoPlan(request) {
    const p = partnerModel();
    if (!state.duo || !p) return "";
    try {
      const plan = await oneShot({
        model: p.id,
        system: PLAN_SYSTEM,
        signal: state.abort && state.abort.signal,
        messages: [{ role: "user", content: `Project folder top level: ${d.topLevel()}\n\nRequest:\n${String(request).slice(0, 12000)}` }],
      });
      if (!plan) return "";
      spinner.stop();
      print(`   ${c.accent("◆")} ${c.ink(`plan from ${p.label}`)}`);
      for (const l of plan.split("\n").filter((x) => x.trim())) print(`     ${c.dim(l)}`);
      return `\n\n<plan from="${p.label}">\n${plan}\n</plan>\nFollow this plan unless you find a good reason not to.`;
    } catch {
      return "";
    }
  }
  // The files changed since the request started, as a compact diff for the reviewer.
  function changesSince(undoStart) {
    const first = new Map();
    for (const u of state.undo.slice(undoStart)) if (!first.has(u.abs)) first.set(u.abs, u);
    const parts = [];
    for (const [abs, u] of first) {
      const before = u.created ? "" : u.before;
      let after = "";
      try { after = fs.readFileSync(abs, "utf8"); } catch {}
      const ops = ui.lineDiff(before.split(/\r?\n/), after.split(/\r?\n/));
      const keep = new Set();
      ops.forEach((o, i) => { if (o.t !== " ") for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
      const lines = [];
      let gap = false;
      ops.forEach((o, i) => {
        if (!keep.has(i)) return void (gap = true);
        if (gap && lines.length) lines.push("…");
        gap = false;
        lines.push(`${o.t === "+" ? "+" : o.t === "-" ? "-" : " "}${String(o.bn || o.an || "").padStart(4)} ${o.text}`);
      });
      parts.push(`--- ${relPath(abs)}${u.created ? " (new file)" : ""}\n${lines.join("\n")}`);
    }
    return parts.join("\n\n");
  }
  // After the coder finishes: the partner reviews; problems go back to the coder for one more round.
  async function duoReview(request, undoStart) {
    const p = partnerModel();
    if (!state.duo || !p || state.undo.length === undoStart) return "";
    const diff = changesSince(undoStart);
    try {
      spinner.start(`${p.label} is reviewing the change`);
      const review = await oneShot({
        model: p.id,
        system: REVIEW_CHANGE_SYSTEM,
        signal: state.abort && state.abort.signal,
        messages: [{ role: "user", content: `User's request:\n${String(request).slice(0, 6000)}\n\nThe change:\n${clip(diff, 40000)}` }],
      });
      spinner.stop();
      if (!review || /^\W*LGTM\W*$/i.test(review)) {
        ui.note(`${c.green("✓")} ${c.ink(`reviewed by ${p.label}`)} ${c.dim("· no problems found")}`);
        return "";
      }
      print(`   ${c.yellow("◆")} ${c.ink(`${p.label} found problems`)}`);
      for (const l of review.split("\n").filter((x) => x.trim())) print(`     ${c.dim(l)}`);
      return `<review from="${p.label}">\n${review}\n</review>\nFix these problems (if you disagree with one, say why), then finish.`;
    } catch {
      spinner.stop();
      return "";
    }
  }

  // ---------- /fix and test watch ----------
  function detectTests() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      const t = pkg.scripts && pkg.scripts.test;
      if (t && !/no test specified/i.test(t)) return "npm test";
    } catch {}
    const found = { js: false, py: false };
    (function scan(dir, depth) {
      if (depth > 4 || (found.js && found.py)) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.test(p) && !e.name.startsWith(".")) scan(p, depth + 1); }
        else if (/\.(test|spec)\.[cm]?js$/.test(e.name)) found.js = true;
        else if (/^test_.*\.py$|_test\.py$/.test(e.name)) found.py = true;
      }
    })(root, 0);
    return found.js ? "node --test" : found.py ? "python -m pytest -q" : "";
  }
  async function testCommand(arg) {
    let cmd = String(arg || "").trim() || d.project().testCommand || detectTests();
    if (!cmd) cmd = ((await d.question(`   ${c.ink("How do I run the tests here?")} ${c.dim("(e.g. npm test):")} `)) || "").trim();
    if (cmd) {
      d.project().testCommand = cmd;
      api.save();
    }
    return cmd;
  }
  async function runTests(cmd, signal) {
    const { out, code, killedFor } = await T.runCommand(ctx, cmd, 300, signal);
    return { out, code: killedFor ? 1 : code, killedFor, ...T.testResults(out || "") };
  }
  const counts = (r) => [r.fail ?? (r.names.length || ""), r.pass !== undefined ? r.pass : ""].map((x, i) => (x === "" ? "" : `${x} ${i ? "passed" : "failed"}`)).filter(Boolean).join(", ");

  async function fix(arg) {
    if (/^watch$/i.test(arg)) return toggleWatch();
    const cmd = await testCommand(arg);
    if (!cmd) return;
    for (let round = 1; round <= 3; round++) {
      let r;
      try {
        r = await busy(`running ${cmd}`, (signal) => runTests(cmd, signal));
      } catch (err) {
        return failed(err);
      }
      if (state.interrupted) return;
      if (!r.code) {
        return ui.note(`${c.green("✓")} ${c.ink(`${cmd} passes`)}${r.pass !== undefined ? c.dim(` · ${r.pass} tests`) : ""}${round > 1 ? c.dim(` · fixed in ${round - 1} round${round > 2 ? "s" : ""}`) : ""}`);
      }
      print(`   ${c.red("●")} ${c.ink(`${cmd} fails`)}${counts(r) ? c.dim(` · ${counts(r)}`) : ""}`);
      for (const n of r.names.slice(0, 6)) print(`     ${c.red("●")} ${c.ink(n)}`);
      if (round === 3) return ui.note(`${c.yellow("!")} ${c.ink("Still failing after 3 rounds, so yAI stopped.")} ${c.dim("Look at the failures above, or give it a hint.")}`);
      await d.runAgent(
        `The tests are failing. Make them pass.\n- Test command: ${cmd}\n- Failing tests: ${r.names.slice(0, 20).join("; ") || "(see the output)"}\n` +
          `- Fix the code, not the tests, unless a test is clearly wrong (then say so).\n- Run \`${cmd}\` yourself to check before you finish.\n\n` +
          `End of the test output:\n\`\`\`\n${tail(r.out || "", 5000)}\n\`\`\``
      );
      if (state.interrupted) return;
    }
  }

  let watcher = null, watchTimer = null, watchCmd = "", lastWatch = "";
  async function toggleWatch() {
    if (watcher) {
      watcher.close();
      watcher = null;
      return ui.note(c.dim("test watch off"));
    }
    watchCmd = await testCommand("");
    if (!watchCmd) return;
    try {
      watcher = fs.watch(root, { recursive: true }, (_, file) => {
        if (!file || SKIP_DIRS.test(String(file))) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(runWatch, 900);
      });
    } catch (err) {
      return print(c.red(`   Couldn't watch this folder: ${err.message}`));
    }
    lastWatch = "";
    ui.note(`${c.accent("◆")} ${c.ink("test watch on")} ${c.dim(`· runs ${watchCmd} when a file changes · /fix watch to stop`)}`);
  }
  async function runWatch() {
    if (!watcher) return;
    if (state.busy) return void (watchTimer = setTimeout(runWatch, 2000)); // after yAI's own edits are done
    const r = await runTests(watchCmd, new AbortController().signal);
    if (!watcher || state.busy) return;
    const line = r.code
      ? `${c.red("●")} ${c.ink("tests failing")}${counts(r) ? c.dim(` · ${counts(r)}`) : ""}${r.names.length ? c.dim(` · ${r.names.slice(0, 2).join(", ")}${r.names.length > 2 ? "…" : ""}`) : ""} ${c.dim("· /fix")}`
      : `${c.green("✓")} ${c.ink("tests pass")}${r.pass !== undefined ? c.dim(` · ${r.pass}`) : ""}`;
    if (ui.stripAnsi(line) === lastWatch) return;
    lastWatch = ui.stripAnsi(line);
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
    print(`   ${line}`);
    d.showPrompt();
  }

  // ---------- /commit ----------
  async function commit(arg) {
    if (!isRepo()) return print(c.yellow("   This folder isn't a git repository."));
    if (git(["diff", "--cached", "--name-only"]).out === "") {
      const changed = git(["status", "--porcelain"]).out.split("\n").filter(Boolean);
      if (!changed.length) return print(c.dim("   Nothing to commit."));
      print("");
      for (const l of changed.slice(0, 15)) print(`   ${c.dim(l.slice(0, 2))} ${c.ink(l.slice(3))}`);
      if (changed.length > 15) print(c.dim(`   … ${changed.length - 15} more`));
      const a = ((await d.question(`   ${c.ink(`Nothing is staged. Stage all ${changed.length} and commit?`)} ${c.dim("[Y/n]:")} `)) || "").trim().toLowerCase();
      if (a && a !== "y" && a !== "yes") return;
      const add = git(["add", "-A"]);
      if (!add.ok) return print(c.red(`   git add failed: ${add.err}`));
    }
    const diff = `${git(["diff", "--cached", "--stat"]).out}\n\n${clip(git(["diff", "--cached"]).out, 18000)}`;
    const style = git(["log", "-8", "--format=%s"]).out;
    let msg;
    try {
      msg = await busy("writing the commit message", (signal) => oneShot({
        model: state.model,
        system: COMMIT_SYSTEM,
        signal,
        messages: [{ role: "user", content: `${style ? `Recent commit subjects here (match their style):\n${style}\n\n` : ""}The staged change:\n${diff}${arg ? `\n\nNote from the user about this change: ${arg}` : ""}` }],
      }));
    } catch (err) {
      return failed(err);
    }
    msg = msg.replace(/^```\w*\n?|\n?```$/g, "").replace(/^["']|["']$/g, "").trim();
    if (!msg) return print(c.red("   The model didn't write a message."));
    for (;;) {
      print("");
      ui.frame(msg.split("\n").map((l) => " " + c.ink(l)), { indent: 3, inner: ui.width() - 5 });
      const a = ((await d.question(ui.choices([["Y", "Commit"], ["E", "Edit"], ["N", "Cancel"]], "Y"))) || "").trim().toLowerCase();
      if (a === "n" || a === "no") return print(c.dim("   Not committed; the changes are still staged."));
      if (a === "e" || a === "edit") {
        const subject = ((await d.question(`   ${c.ink("Commit message (one line):")} `)) || "").trim();
        if (subject) msg = subject;
        continue;
      }
      break;
    }
    let r = git(["commit", "-F", "-"], msg);
    // No git name/email set anywhere: ask once and save them in this repository only, then try again.
    if (!r.ok && /Author identity unknown|Please tell me who you are/i.test(r.err)) {
      print(c.yellow("   Git doesn't know who you are in this repository yet."));
      const name = ((await d.question(`   ${c.ink("Your name for commits:")} `)) || "").trim();
      const email = ((await d.question(`   ${c.ink("Your email for commits:")} `)) || "").trim();
      if (!name || !email) return print(c.dim("   Not committed; the changes are still staged."));
      git(["config", "user.name", name]);
      git(["config", "user.email", email]);
      r = git(["commit", "-F", "-"], msg);
    }
    if (!r.ok) return print(c.red(`   git commit failed: ${(r.err || r.out).split("\n")[0]}`));
    ui.note(`${c.green("✓")} ${c.ink(r.out.split("\n")[0])}`);
  }

  // ---------- /review ----------
  async function review(arg) {
    if (!isRepo()) return print(c.yellow("   /review looks at uncommitted changes, and this folder isn't a git repository."));
    let diff = git(["diff", "HEAD"]).out || git(["diff", "--cached"]).out;
    const untracked = git(["ls-files", "--others", "--exclude-standard"]).out.split("\n").filter(Boolean).slice(0, 6);
    for (const f of untracked) {
      try {
        const text = fs.readFileSync(path.join(root, f), "utf8");
        if (text.length < 20000 && !text.includes("\0")) diff += `\n\n--- ${f} (new, untracked)\n${text}`;
      } catch {}
    }
    if (!diff.trim()) return print(c.dim("   No uncommitted changes to review."));
    const reviewer = partnerModel() || state.models.find((m) => m.id === state.model);
    const testCmd = d.project().testCommand || detectTests();
    let out;
    try {
      out = await busy("reviewing", async (signal) => {
        let tests = "not run (no test command found)";
        if (testCmd) {
          spinner.text(`running ${testCmd}`);
          const r = await runTests(testCmd, signal);
          tests = r.code ? `${testCmd} FAILS (${counts(r) || "see output"}): ${r.names.slice(0, 8).join("; ")}` : `${testCmd} passes${r.pass !== undefined ? ` (${r.pass} tests)` : ""}`;
        }
        spinner.text(`${reviewer.label} is reviewing`);
        return oneShot({
          model: reviewer.id,
          system: REVIEW_SYSTEM,
          signal,
          messages: [{ role: "user", content: `Review these uncommitted changes${arg ? ` (focus: ${arg})` : ""}.\n\nTests: ${tests}\n\n${clip(diff, 45000)}` }],
        });
      });
    } catch (err) {
      return failed(err);
    }
    print("");
    print(`   ${c.accent("◆")} ${c.ink(`review by ${reviewer.label}`)}`);
    printMarkdown(out);
    state.pendingContext.push(`${reviewer.label} reviewed my uncommitted changes:\n${out}`);
    print(c.dim('\n   Say "fix these" and yAI will work through them.'));
  }

  // ---------- /share ----------
  async function share() {
    if (!state.messages.length) return print(c.dim("   Nothing to share yet."));
    print("");
    print(`   ${c.ink("This publishes the conversation at an unlisted link: anyone with the link can open it,")}`);
    print(`   ${c.ink("including any code and file contents yAI read or wrote in it.")}`);
    const a = ((await d.question(`   ${c.ink("Share it?")} ${c.dim("[y/N]:")} `)) || "").trim().toLowerCase();
    if (a !== "y" && a !== "yes") return print(c.dim("   Not shared."));
    const text = (m) => (typeof m.content === "string" ? m.content : (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n"));
    let messages = state.messages.map((m) => ({ role: m.role, content: clip(text(m), 20000) }));
    // Keep it under the site's limit: drop the bodies of the biggest tool results first.
    while (JSON.stringify(messages).length > 800_000) {
      const i = messages.reduce((best, m, k) => (m.content.startsWith("<tool_result") && m.content.length > (messages[best]?.content.length || 0) ? k : best), -1);
      if (i < 0) break;
      messages[i] = { ...messages[i], content: messages[i].content.split("\n")[0] + "\n(output left out of the shared copy)\n</tool_result>" };
    }
    try {
      const r = await busy("publishing", () => api.share({ title: d.title(), project: path.basename(root), model: d.modelLabel(), messages }));
      ui.note(`${c.green("✓")} ${c.ink("Shared: ")}${c.link(r.url)}`);
    } catch (err) {
      failed(err);
    }
  }

  // ---------- /tutor ----------
  function toggleTutor(arg) {
    state.tutor = /^(on|off)$/i.test(arg) ? arg.toLowerCase() === "on" : !state.tutor;
    ui.note(state.tutor
      ? `${c.accent("◆")} ${c.ink("tutor mode on")} ${c.dim("· yAI explains and gives hints but won't write your solution or edit files · /tutor to turn off")}`
      : c.dim("tutor mode off"));
  }

  return { look, showcase, isImage, describeImages, toggleDuo, duoPlan, duoReview, fix, commit, review, share, toggleTutor, TUTOR_PROMPT };
};
