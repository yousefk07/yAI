"use strict";
// /team's own browser checks (2026-10-22), run by yAI itself in a headless browser (cli/browser.js) rather than by a
// model with tools, so their numbers are measured, not guessed. Each takes { root, entry (absolute path of the page),
// task, X (for a model that can see), signal } and returns { verdict: "PASS" | "FAIL" | "", lines }:
//
//   mobile         the page at phone, tablet and laptop sizes: sideways scrolling, things cut off, tiny tap targets
//   performance    load time, page weight, frame rate after Start, long freezes
//   accessibility  axe-core's rules (contrast, labels, alt text, roles…) and whether Tab reaches the controls
//   playtest       plays a game for about 30 seconds: controls, losing, game over, Play again, saved scores

const fs = require("fs");
const path = require("path");
const B = require("./browser");

// the button that starts the game (2026-10-22: "New World" wasn't one, so a Minecraft clone was "played" on its title
// screen and its freeze on New World went unseen)
const START = String.raw`(() => { const el = [...document.querySelectorAll("button, a, [role=button], .btn")].find((e) => e.offsetParent && /^(\W*)(play|start|drop in|begin|new (game|world|run)|create (a )?world|single ?player|enter|let'?s go)/i.test(e.textContent.trim())); if (!el) return ""; setTimeout(() => el.click(), 0); return el.textContent.trim().slice(0, 30); })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// does the page still answer? A page whose script never yields (an endless loop) doesn't, and waiting on it would
// hang the check too
const alive = (b, ms = 6000) => Promise.race([B.evaluate(b, "1").then(() => true, () => true), sleep(ms).then(() => false)]);

// Opens the page in a fresh browser at a size; collects console errors. Call close() when done.
async function openPage(entry, { width = 1280, height = 720, mobile = false, beforeLoad = "" } = {}) {
  const server = await B.serveFolder(path.dirname(entry));
  const b = await B.launch({ width, height });
  const errors = [];
  // a headless browser can't capture the mouse, so a game's pointer-lock request fails here and nowhere else: not
  // the game's fault (2026-10-22: a working Minecraft clone failed its playtest on it)
  const headlessOnly = (t) => /pointer ?lock|WrongDocumentError/i.test(t);
  b.on("Runtime.exceptionThrown", (p) => { const t = (p.exceptionDetails.exception?.description || p.exceptionDetails.text || "").split("\n")[0]; if (!headlessOnly(t)) errors.push(`Uncaught: ${t}`); });
  b.on("Runtime.consoleAPICalled", (p) => { if (p.type !== "error") return; const t = p.args.map((x) => x.value ?? x.description ?? "").join(" ").slice(0, 200); if (!headlessOnly(t)) errors.push(`console.error: ${t}`); });
  if (mobile || width !== 1280 || height !== 720) await B.setViewport(b, width, height, mobile);
  if (beforeLoad) await b.send("Page.addScriptToEvaluateOnNewDocument", { source: beforeLoad });
  await B.open(b, `${server.url}/${encodeURIComponent(path.basename(entry))}`);
  return { b, errors, url: server.url, close: () => { try { b.close(); } catch {} server.close(); } };
}
const keyHold = async (b, [code, key, vk], ms) => {
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: vk });
  await sleep(ms);
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: vk });
};
async function judge(X, system, content, signal) {
  if (!X?.withVision) return "";
  try { return String((await X.withVision((m) => X.oneShot({ model: m.id, system, signal, messages: [{ role: "user", content }] }), signal)).text || "").trim(); }
  catch { return ""; }
}
const save = (root, name, buf) => {
  const dir = path.join(root, "yai-media");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Date.now()}.jpg`);
  fs.writeFileSync(file, buf);
  return path.relative(root, file).split(path.sep).join("/");
};

// ---------- mobile ----------
const MOBILE_SYSTEM =
  "You check how a web page or browser game looks at different screen sizes. Each screenshot is labelled with the size. " +
  "List real problems only: content cut off at an edge, things overlapping, text too small to read, controls too small to tap, " +
  "a layout that doesn't fit the screen. End with one line: MOBILE: OK or MOBILE: PROBLEMS.";
async function mobile({ root, entry, task, X, signal }) {
  const sizes = [[390, 844, "phone", true], [820, 1180, "tablet", true], [1280, 720, "laptop", false]];
  const lines = [], content = [{ type: "text", text: `The task: ${task}` }];
  let bad = false;
  for (const [w, h, label, isMobile] of sizes) {
    const p = await openPage(entry, { width: w, height: h, mobile: isMobile });
    try {
      await B.evaluate(p.b, START).catch(() => "");
      await sleep(1000);
      const m = await B.evaluate(p.b, `(() => {
        const W = innerWidth, H = innerHeight, de = document.documentElement;
        const sideways = de.scrollWidth > W + 2;
        const noScroll = ["hidden", "clip"].includes(getComputedStyle(document.body).overflowY) || ["hidden", "clip"].includes(getComputedStyle(de).overflowY);
        const big = [...document.querySelectorAll("canvas, main, #app, .container, .game, [id*=game]")].filter((e) => e.offsetWidth > 50).map((e) => e.getBoundingClientRect());
        const cut = big.filter((r) => r.left < -2 || r.right > W + 2 || (noScroll && (r.top < -2 || r.bottom > H + 2))).length;
        const taps = [...document.querySelectorAll("button, a, input, select, [role=button]")].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect()).filter((r) => r.width < 36 || r.height < 36).length;
        return { sideways, scrollWidth: de.scrollWidth, cut, taps, W, H };
      })()`).catch(() => ({}));
      const shot = await B.screenshot(p.b, { quality: 60 });
      const problems = [m.sideways && `scrolls sideways (${m.scrollWidth}px wide on a ${m.W}px screen)`, m.cut && `${m.cut} main area${m.cut === 1 ? " is" : "s are"} cut off at the edge`, isMobile && m.taps && `${m.taps} button${m.taps === 1 ? " is" : "s are"} smaller than a fingertip (36px)`].filter(Boolean);
      if (m.sideways || m.cut) bad = true;
      lines.push(`- ${label} ${w}×${h}: ${problems.length ? problems.join("; ") : "fits"} (screenshot ${save(root, `team-${label}`, shot)})`);
      content.push({ type: "text", text: `${label}, ${w}×${h}` }, X?.imagePart ? X.imagePart(shot, "image/jpeg") : null);
    } finally { p.close(); }
  }
  const seen = await judge(X, MOBILE_SYSTEM, content.filter(Boolean), signal);
  if (seen) lines.push(`What it looks like: ${seen.replace(/\n+/g, " ")}`);
  if (/MOBILE:\s*PROBLEMS/i.test(seen)) bad = true;
  return { verdict: bad ? "FAIL" : "PASS", lines: ["Opened it at phone, tablet and laptop sizes:", ...lines] };
}

// ---------- performance ----------
async function performance({ root, entry }) {
  const p = await openPage(entry, { beforeLoad: "window.__lt=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(e.duration)}).observe({type:'longtask',buffered:true})}catch(e){}" });
  try {
    const load = await B.evaluate(p.b, `(() => { const n = performance.getEntriesByType("navigation")[0] || {}; const res = performance.getEntriesByType("resource"); return { dcl: Math.round(n.domContentLoadedEventEnd || 0), load: Math.round(n.loadEventEnd || 0), files: res.length + 1, bytes: res.reduce((s, r) => s + (r.encodedBodySize || r.transferSize || 0), 0) + (n.encodedBodySize || 0) }; })()`);
    const pressed = await B.evaluate(p.b, START).catch(() => "");
    await sleep(800);
    const fps = await B.evaluate(p.b, `new Promise((done) => { let n = 0, worst = 0, last = performance.now(); const t0 = last; const f = (t) => { n++; worst = Math.max(worst, t - last); last = t; if (t - t0 < 3000) requestAnimationFrame(f); else done({ fps: Math.round(n / ((t - t0) / 1000)), worst: Math.round(worst) }); }; requestAnimationFrame(f); })`);
    const heap = await B.evaluate(p.b, `performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null`).catch(() => null);
    const long = await B.evaluate(p.b, `(window.__lt || []).filter((d) => d > 200).length`).catch(() => 0);
    const animated = (await B.evaluate(p.b, `document.querySelectorAll("canvas").length`).catch(() => 0)) > 0 || !!pressed;
    const mb = (load.bytes / 1048576).toFixed(2);
    const problems = [
      load.load > 3000 && `loads slowly (${(load.load / 1000).toFixed(1)} s from this PC)`,
      load.bytes > 5 * 1048576 && `the page is heavy (${mb} MB)`,
      animated && fps.fps < 45 && `low frame rate (${fps.fps} fps; a smooth game runs near 60)`,
      fps.worst > 250 && `freezes for up to ${fps.worst} ms`,
      long > 3 && `${long} long freezes (over 200 ms) while loading or playing`,
    ].filter(Boolean);
    return {
      verdict: problems.length ? "FAIL" : "PASS",
      lines: [
        `Loaded in ${(load.load / 1000).toFixed(2)} s (ready at ${(load.dcl / 1000).toFixed(2)} s), ${load.files} files, ${mb} MB${heap ? `, ${heap} MB of memory` : ""}.`,
        `${pressed ? `After pressing "${pressed}": ` : ""}${fps.fps} frames a second over 3 s, longest frame ${fps.worst} ms.`,
        ...(problems.length ? ["Problems:", ...problems.map((x) => `- ${x}`)] : ["Nothing slow."]),
        ...(p.errors.length ? ["Errors in the browser:", ...[...new Set(p.errors)].slice(0, 6).map((e) => `- ${e}`)] : []),
      ],
    };
  } finally { p.close(); }
}

// ---------- accessibility ----------
const AXE = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
async function accessibility({ entry }) {
  const p = await openPage(entry);
  try {
    const loaded = await B.evaluate(p.b, `new Promise((ok) => { const s = document.createElement("script"); s.src = ${JSON.stringify(AXE)}; s.onload = () => ok(true); s.onerror = () => ok(false); document.head.appendChild(s); })`);
    if (!loaded) return { verdict: "", lines: ["Couldn't load the accessibility rules (axe-core) from the internet."] };
    const r = await B.evaluate(p.b, `axe.run(document, { resultTypes: ["violations"] }).then((res) => res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, target: (v.nodes[0]?.target || []).join(" ") })))`);
    // Tab through the page: does keyboard focus reach the controls?
    const tabbed = [];
    for (let i = 0; i < 8; i++) {
      await keyHold(p.b, ["Tab", "Tab", 9], 30);
      tabbed.push(await B.evaluate(p.b, `(() => { const e = document.activeElement; return e && e !== document.body ? (e.id ? "#" + e.id : e.tagName.toLowerCase()) + (e.textContent.trim() ? " " + JSON.stringify(e.textContent.trim().slice(0, 20)) : "") : ""; })()`));
    }
    const reached = [...new Set(tabbed.filter(Boolean))];
    const controls = await B.evaluate(p.b, `[...document.querySelectorAll("button, a[href], input, select, textarea")].filter((e) => e.offsetParent).length`);
    const serious = r.filter((v) => v.impact === "critical" || v.impact === "serious");
    const problems = [...serious.map((v) => `${v.impact}: ${v.help} (${v.n} place${v.n === 1 ? "" : "s"}, e.g. ${v.target})`)];
    if (controls && !reached.length) problems.push("serious: the Tab key never reaches any control, so it can't be used without a mouse");
    return {
      verdict: problems.length ? "FAIL" : "PASS",
      lines: [
        `axe-core found ${r.length} rule${r.length === 1 ? "" : "s"} broken (${serious.length} serious or critical).`,
        `Tab reaches: ${reached.length ? reached.join(", ") : "nothing"}.`,
        ...(problems.length ? ["Problems:", ...problems.slice(0, 10).map((x) => `- ${x}`)] : []),
        ...r.filter((v) => !serious.includes(v)).slice(0, 5).map((v) => `- minor: ${v.help} (${v.n})`),
      ],
    };
  } finally { p.close(); }
}

// ---------- playtest ----------
const PLAY_SYSTEM =
  "You playtest a browser game from screenshots taken while a script played it for about 30 seconds; each image says what happened " +
  "just before it. Say whether the game works the way the task describes: the player's controls move things, the game progresses " +
  "(score, lives, levels), losing works and shows a game over, Play again restarts it, and anything that should be saved survives a " +
  "reload. List each problem plainly. End with one line: PLAYTEST: OK or PLAYTEST: PROBLEMS.";
async function playtest({ root, entry, task, X, signal }) {
  const p = await openPage(entry);
  const shots = [], notes = [];
  const snap = async (label) => shots.push({ label, img: await B.screenshot(p.b, { quality: 55 }) });
  try {
    await snap("the page as it opens");
    const pressed = await B.evaluate(p.b, START).catch(() => "");
    notes.push(pressed ? `Pressed "${pressed}".` : "No Play/Start button found.");
    await sleep(600);
    // a game that freezes as it starts: its script never yields, so nothing can be played (or even looked at)
    if (!(await alive(p.b)) && !(await alive(p.b, 6000))) {
      return { verdict: "FAIL", lines: [`The page froze${pressed ? ` after pressing "${pressed}"` : ""}: it stopped answering for over 10 s, so nothing could be played. Look for a loop that never ends in what that starts, such as a Set or array that keeps growing while it is walked, or a while loop that never exits.`] };
    }
    const wasd = /\bwasd\b/i.test(task) && !/arrow/i.test(task);
    const L = wasd ? ["KeyA", "a", 65] : ["ArrowLeft", "ArrowLeft", 37], R = wasd ? ["KeyD", "d", 68] : ["ArrowRight", "ArrowRight", 39];
    const jump = /jump|space|shoot|fire|flap/i.test(task) ? ["Space", " ", 32] : null;
    const rect = await B.evaluate(p.b, `(() => { const c = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0]; const x = (c || document.body).getBoundingClientRect(); return { x: x.left, y: x.top, w: x.width, h: x.height }; })()`);
    // play: steer back and forth (keys, then the mouse), jump now and then, for about 30 seconds
    let over = "";
    for (let i = 0; i < 10 && !over; i++) {
      await keyHold(p.b, i % 2 ? R : L, 900);
      if (jump && i % 3 === 0) await keyHold(p.b, jump, 80);
      if (/mouse|aim|click/i.test(task)) await p.b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + rect.w * (i % 2 ? 0.8 : 0.2), y: rect.y + rect.h * 0.8 });
      await sleep(1700);
      if (i % 3 === 2) await snap(`after ${Math.round((i + 1) * 2.7)} s of play`);
      over = await B.evaluate(p.b, `(() => { const t = document.body.innerText; const b = [...document.querySelectorAll("button, a, [role=button]")].find((e) => e.offsetParent && /play again|restart|try again|new game/i.test(e.textContent)); return /game over|you lose|you win|victory|you died/i.test(t) || b ? (b ? b.textContent.trim() : "game over") : ""; })()`);
    }
    if (over) {
      await snap("the game ended");
      notes.push(`The game ended (found "${over}").`);
      const again = await B.evaluate(p.b, `(() => { const b = [...document.querySelectorAll("button, a, [role=button]")].find((e) => e.offsetParent && /play again|restart|try again|new game/i.test(e.textContent)); if (!b) return ""; b.click(); return b.textContent.trim(); })()`);
      if (again) { await sleep(1500); await snap(`after pressing "${again}"`); notes.push(`Pressed "${again}".`); }
      else notes.push("No Play again button.");
    } else notes.push("Didn't reach a game over in about 30 s.");
    // what the page saved, and whether it survives a reload
    const before = await B.evaluate(p.b, `JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k).slice(0, 80)])))`).catch(() => "{}");
    await B.open(p.b, `${p.url}/${encodeURIComponent(path.basename(entry))}`);
    const after = await B.evaluate(p.b, `JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k).slice(0, 80)])))`).catch(() => "{}");
    await snap("after reloading the page");
    notes.push(before === "{}" ? "Nothing was saved in the browser (localStorage)." : `Saved: ${before}; after a reload: ${after}${before === after ? " (kept)" : " (CHANGED)"}.`);
    const content = [{ type: "text", text: `The task: ${task}\nWhat the script did: ${notes.join(" ")}` }];
    for (const s of shots) content.push({ type: "text", text: s.label }, X.imagePart(s.img, "image/jpeg"));
    const seen = X?.imagePart ? await judge(X, PLAY_SYSTEM, content, signal) : "";
    const file = save(root, "team-playtest", shots[shots.length - 2]?.img || shots[0].img);
    const problems = /PLAYTEST:\s*PROBLEMS/i.test(seen) || p.errors.length;
    return {
      verdict: seen || p.errors.length ? (problems ? "FAIL" : "PASS") : "",
      lines: [`Played it for about 30 s: ${notes.join(" ")} (screenshot ${file})`, ...(seen ? [`What happened: ${seen.replace(/\n+/g, " ")}`] : []), ...(p.errors.length ? ["Errors in the browser:", ...[...new Set(p.errors)].slice(0, 6).map((e) => `- ${e}`)] : [])],
    };
  } finally { p.close(); }
}

// check_page (2026-10-22): one look at the app as it is right now, for an agent while it builds. Opens the page,
// presses its start button, holds any keys asked for, and reports errors, a frozen page, the frame rate, what the page
// says and (with `describe`, a model that can see) what's on screen. No model of its own, so it's cheap and can't loop.
// keys: "KeyW:1500,Space,ArrowLeft:500" (a key code, held for the ms after the colon, default 150)
// Every step has a time limit, and the whole check one of 100 s (2026-10-22: a builder's check_page sat on "opening it
// in a browser" for minutes: a key press, a read or the screenshot waits forever on a page that hangs mid-check).
async function pageCheck(o) {
  const lines = [], at = { step: "opening the browser" }, p = {};
  let timer;
  const cap = new Promise((ok) => { timer = setTimeout(() => ok({ frozen: true, lines: [...lines, `check_page gave up after 100 s while ${at.step}: the page (or the browser) stopped answering. Treat it as frozen: look for a loop that never ends, or a step that waits on something that never comes.`] }), 100000); });
  // the steps go on after a time-out until the browser is closed under them; their error then is expected
  const run = pageCheckSteps(o, lines, at, p);
  run.catch(() => {});
  try { return await Promise.race([run, cap]); }
  finally { clearTimeout(timer); p.close?.(); }
}
const within = (pr, ms, fallback) => Promise.race([Promise.resolve(pr).catch(() => fallback), sleep(ms).then(() => fallback)]);
async function pageCheckSteps({ entry, start = true, keys = "", wait = 2500, describe, lookFor = "", saveTo }, lines, at, out) {
  const p = await openPage(entry);
  out.close = p.close;
  {
    at.step = "starting the page";
    await sleep(1200);
    const pressed = start ? await Promise.race([B.evaluate(p.b, START), sleep(6000).then(() => "")]).catch(() => "") : "";
    if (start) lines.push(pressed ? `Pressed "${pressed}".` : "No start button to press.");
    await sleep(Math.min(Math.max(Number(wait) || 2500, 500), 15000));
    if (!(await alive(p.b)) && !(await alive(p.b))) {
      lines.push(`FROZEN: the page stopped answering${pressed ? ` after "${pressed}"` : ""} for over 10 s: a loop that never ends (a Set or array growing while it is walked, a while loop that never exits).`);
      return { frozen: true, lines };
    }
    at.step = "pressing the keys";
    for (const k of String(keys || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 12)) {
      const [code, ms] = k.split(":");
      const key = code.replace(/^Key/, "").replace(/^Digit/, "").toLowerCase();
      if ((await within(p.b.send("Input.dispatchKeyEvent", { type: "keyDown", code, key: code === "Space" ? " " : key }).then(() => true), 6000, false)) === false) { lines.push(`FROZEN: the page stopped answering when ${code} was pressed.`); return { frozen: true, lines }; }
      await sleep(Math.min(Number(ms) || 150, 5000));
      if ((await within(p.b.send("Input.dispatchKeyEvent", { type: "keyUp", code, key: code === "Space" ? " " : key }).then(() => true), 6000, false)) === false) { lines.push(`FROZEN: the page stopped answering after ${code}.`); return { frozen: true, lines }; }
    }
    if (keys) { lines.push(`Held: ${keys}.`); if (!(await alive(p.b))) { lines.push("FROZEN after the keys."); return { frozen: true, lines }; } }
    const fps = await Promise.race([B.evaluate(p.b, `new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); })`), sleep(4000).then(() => 0)]);
    at.step = "reading the page";
    const info = await within(B.evaluate(p.b, `(() => ({ title: document.title, text: document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 300), buttons: [...document.querySelectorAll("button, [role=button]")].filter((b) => b.offsetParent).map((b) => b.textContent.trim()).filter(Boolean).slice(0, 10), canvas: [...document.querySelectorAll("canvas")].map((c) => c.width + "x" + c.height).slice(0, 3) }))()`), 8000, null);
    lines.push(`Frame rate: about ${fps} fps (a headless browser without a graphics card, so a real one is faster).`);
    if (info?.canvas?.length) lines.push(`Canvas: ${info.canvas.join(", ")}.`);
    if (info?.buttons?.length) lines.push(`Buttons on screen: ${info.buttons.join(" · ")}.`);
    if (info?.text) lines.push(`Text on the page: ${info.text}`);
    lines.push(p.errors.length ? `Errors in the browser (${p.errors.length}):\n${[...new Set(p.errors)].slice(0, 8).map((e) => `- ${e}`).join("\n")}` : "No errors in the browser.");
    at.step = "taking the screenshot";
    const img = await within(B.screenshot(p.b, { quality: 60 }), 15000, null);
    if (!img) { lines.push("The screenshot timed out: the page stopped drawing."); return { frozen: true, lines }; }
    if (saveTo) { try { require("fs").mkdirSync(path.dirname(saveTo), { recursive: true }); require("fs").writeFileSync(saveTo, img); lines.push(`Screenshot saved: ${saveTo}`); } catch {} }
    at.step = "describing the screenshot";
    // 25 s: when the image model is down it fails slowly, and a check an agent runs often must stay quick
    if (describe) { const seen = await within(describe(img, lookFor), 25000, ""); lines.push(seen ? `On screen (described by a model that can see it):\n${seen}` : "(No description of the screen this time: the image model didn't answer. Judge by the errors, frame rate and text above.)"); }
    return { frozen: false, lines };
  }
}

module.exports = { mobile, performance, accessibility, playtest, pageCheck };
