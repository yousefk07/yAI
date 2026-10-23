// The team report (2026-10-22): one self-contained page, TEAM_REPORT.html, written into the project when a /team run
// ends, to open in a browser or put on a website. It shows what was asked, the spec checker's requirement-by-requirement
// score, yAI's own re-check, every agent (model, time, cost, verdict, what it did), the live feed, screenshots the
// playtester took, the files built, and a replay of the board as it ran (recorded by team.js, played back here with
// the terminal's colours). Nothing is fetched: fonts fall back to the system's when offline.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// data: { task, date, folder, stats: [[value, label]], score: [done, of] | null, requirements: [{ item, state }],
//   recheck: [{ name, ok, detail }], agents: [{ n, name, stage, model, time, cost, st, verdict, summary }],
//   feed: [{ t, who, tone, what, quote }], shots: [{ src, label }], files: [{ path, lines }], recording }
function build(data) {
  const ST = { done: ["✓", "muted"], pass: ["✓", "ok"], fail: ["✕", "bad"], work: ["◐", "acc"], stuck: ["‖", "warn"], wait: ["○", "muted"], skip: ["–", "muted"], stopped: ["■", "warn"] };
  const glyph = (st) => { const [g, c] = ST[st] || ["·", "muted"]; return `<span class="g ${c}">${g}</span>`; };
  const REQ = { DONE: ["✓", "ok"], PARTLY: ["◐", "warn"], MISSING: ["✕", "bad"] };
  const rec = data.recording && data.recording.frames.length > 1 ? JSON.stringify(data.recording).replace(/</g, "\\u003c") : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>yAI /team · ${esc(data.task.slice(0, 60))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root { --bg:#141413; --panel:#1b1b1a; --side:#101010; --fg:#ecebe7; --fg2:#a4a39d; --fg3:#7a7974; --line:#2a2a27; --line2:#383834; --chip:#252523; --acc:#c3aeff; --acc-soft:#31254d; --ok:#83d494; --bad:#f69b94; --warn:#e0a64a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 Geist, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 1180px; margin: 0 auto; padding: 48px 24px 80px; display: flex; flex-direction: column; gap: 40px; }
h1 { margin: 0; font-size: 34px; letter-spacing: -0.03em; line-height: 1.2; }
h2 { margin: 0 0 14px; font-size: 13px; letter-spacing: 0.08em; color: var(--fg3); font-weight: 600; font-family: "Geist Mono", ui-monospace, monospace; }
.brand { display: flex; align-items: center; gap: 8px; font-size: 18px; letter-spacing: -0.03em; color: var(--fg2); }
.brand b { color: var(--fg); } .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--acc); display: inline-block; }
.muted { color: var(--fg3); } .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); } .acc { color: var(--acc); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.stat b { display: block; font-size: 22px; letter-spacing: -0.02em; } .stat span { color: var(--fg3); font-size: 13px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; }
.score { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; } .score b { font-size: 30px; }
.bar { height: 6px; border-radius: 3px; background: var(--chip); overflow: hidden; margin-bottom: 14px; } .bar i { display: block; height: 100%; background: var(--ok); }
.list { display: flex; flex-direction: column; gap: 6px; } .list div { display: flex; gap: 10px; }
.g { width: 16px; flex: none; text-align: center; font-weight: 700; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; color: var(--fg3); font-weight: 500; font-size: 12px; letter-spacing: 0.04em; padding: 6px 10px; border-bottom: 1px solid var(--line2); }
td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.mono { white-space: nowrap; }
td.mono, .mono { font-family: "Geist Mono", ui-monospace, monospace; font-size: 13px; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--chip); font-size: 12px; color: var(--fg2); white-space: nowrap; }
.feed { display: flex; flex-direction: column; gap: 10px; max-height: 520px; overflow: auto; }
.fe { display: grid; grid-template-columns: 48px 1fr; gap: 10px; font-size: 14px; } .fe .t { font-family: "Geist Mono", monospace; color: var(--fg3); font-size: 12px; padding-top: 2px; }
.fe q { display: block; quotes: none; margin-top: 4px; padding: 6px 10px; border-left: 2px solid var(--line2); color: var(--fg2); background: var(--side); border-radius: 0 8px 8px 0; }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; } .shots figure { margin: 0; } .shots img { width: 100%; border-radius: 10px; border: 1px solid var(--line); display: block; } .shots figcaption { color: var(--fg3); font-size: 13px; margin-top: 6px; }
.player { background: #1b1b1a; border: 1px solid var(--line2); border-radius: 14px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,0.35); }
.player .top { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--side); border-bottom: 1px solid var(--line); }
.player .top i { width: 11px; height: 11px; border-radius: 50%; background: var(--line2); display: inline-block; }
.screen { margin: 0; padding: 14px 16px; font: 12.5px/1.45 "Geist Mono", ui-monospace, Consolas, monospace; white-space: pre; overflow-x: auto; min-height: 320px; color: #ecebe7; }
.controls { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--line); background: var(--side); font-size: 13px; color: var(--fg2); }
.controls button { background: var(--acc); color: #160d24; border: 0; border-radius: 8px; padding: 5px 14px; font: 600 13px Geist, sans-serif; cursor: pointer; }
.controls select { background: var(--chip); color: var(--fg); border: 1px solid var(--line2); border-radius: 6px; font: inherit; padding: 2px 6px; }
.controls input[type=range] { flex: 1; accent-color: var(--acc); }
footer { color: var(--fg3); font-size: 13px; }
@media (max-width: 640px) { main { padding: 28px 16px 60px; gap: 28px; } h1 { font-size: 26px; } td:nth-child(n+5), th:nth-child(n+5) { display: none; } }
</style></head><body><main>
<header style="display:flex;flex-direction:column;gap:14px">
  <div class="brand"><span><span style="font-weight:400">y</span><b>AI</b></span><span class="dot"></span><span>Code /team · run report</span></div>
  <h1>${esc(data.task)}</h1>
  <div class="muted">${esc(data.date)}${data.folder ? ` · built in <span class="mono">${esc(data.folder)}</span>` : ""}</div>
</header>
<section class="stats">${data.stats.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("")}</section>
${rec ? `<section><h2>THE TEAM AT WORK · A REPLAY OF THE BOARD</h2><div class="player"><div class="top"><i></i><i></i><i></i><span class="muted mono" style="margin-left:8px">yai /team</span></div><pre class="screen" id="screen"></pre>
<div class="controls"><button id="play" type="button">▶ Play</button><select id="speed"><option value="4">4×</option><option value="10" selected>10×</option><option value="30">30×</option><option value="60">60×</option></select><input type="range" id="scrub" min="0" value="0"><span id="clock" class="mono">0:00</span></div></div></section>` : ""}
${data.requirements.length || data.score ? `<section><h2>WHAT WAS ASKED FOR · CHECKED ITEM BY ITEM</h2><div class="card">${data.score ? `<div class="score"><b>${data.score[0]} of ${data.score[1]}</b><span class="muted">requirements done, according to the spec checker</span></div><div class="bar"><i style="width:${Math.round((100 * data.score[0]) / Math.max(1, data.score[1]))}%"></i></div>` : ""}<div class="list">${data.requirements.map((r) => { const [g, c] = REQ[r.state] || ["·", "muted"]; return `<div><span class="g ${c}">${g}</span><span>${esc(r.item)}</span></div>`; }).join("")}</div></div></section>` : ""}
${data.recheck.length ? `<section><h2>YAI'S OWN RE-CHECK · AFTER THE FIX</h2><div class="card list">${data.recheck.map((r) => `<div><span class="g ${r.ok ? "ok" : "bad"}">${r.ok ? "✓" : "✕"}</span><span>${esc(r.name)}${r.detail ? ` <span class="muted">· ${esc(r.detail)}</span>` : ""}</span></div>`).join("")}</div></section>` : ""}
<section><h2>THE TEAM · ${data.agents.length} AGENTS</h2><div class="card" style="padding:6px 8px;overflow-x:auto"><table><thead><tr><th></th><th>AGENT</th><th>STAGE</th><th>WHAT IT DID</th><th>MODEL</th><th>TIME</th><th>COST</th></tr></thead><tbody>
${data.agents.map((a) => `<tr><td>${glyph(a.st)}</td><td><b>${esc(a.name)}</b></td><td><span class="chip">${esc(a.stage)}</span></td><td>${esc(a.summary)}</td><td class="mono">${esc(a.model)}</td><td class="mono">${esc(a.time)}</td><td class="mono">${esc(a.cost)}</td></tr>`).join("")}
</tbody></table></div></section>
${(data.efficiency || []).length ? `<section><h2>WHERE THE TIME WENT · EACH AGENT'S STEPS</h2><div class="card" style="padding:6px 8px;overflow-x:auto"><table><thead><tr><th>AGENT</th><th>TIME</th><th>COST</th><th>STEPS</th><th>READ</th><th>EDIT</th><th>RUN</th><th>PAGE CHECKS</th><th>REPEATS REFUSED</th><th>WATCHER NOTES</th><th>TOKENS</th><th>CACHED</th><th>LOOK AT</th></tr></thead><tbody>${data.efficiency.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td class="mono">${esc(x.time)}</td><td class="mono">${esc(x.cost)}</td><td class="mono">${x.steps}</td><td class="mono">${x.read}</td><td class="mono">${x.edit}</td><td class="mono">${x.run}</td><td class="mono">${x.check}</td><td class="mono">${x.refused}</td><td class="mono">${x.notes}</td><td class="mono">${esc(x.tokens)}</td><td class="mono">${esc(x.cached)}</td><td class="bad">${esc(x.warn)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
${data.shots.length ? `<section><h2>WHAT IT LOOKED LIKE · SCREENSHOTS FROM YAI'S PLAYTEST</h2><div class="shots">${data.shots.map((s) => `<figure><img src="${esc(s.src)}" alt="${esc(s.label)}"><figcaption>${esc(s.label)}</figcaption></figure>`).join("")}</div></section>` : ""}
${data.feed.length ? `<section><h2>THE LIVE FEED · HAND-OFFS AND FINDINGS</h2><div class="card feed">${data.feed.map((f) => `<div class="fe"><span class="t">${esc(f.t)}</span><div><b class="${f.tone === "bad" ? "bad" : f.tone === "ok" ? "ok" : f.tone === "warn" ? "warn" : f.tone === "acc" ? "acc" : f.tone === "you" ? "muted" : ""}">${esc(f.who)}</b> ${esc(f.what)}${f.quote ? `<q>${esc(f.quote)}</q>` : ""}</div></div>`).join("")}</div></section>` : ""}
${data.files.length ? `<section><h2>WHAT WAS BUILT · ${data.files.length} FILES</h2><div class="card" style="padding:6px 8px"><table><tbody>${data.files.map((f) => `<tr><td class="mono">${esc(f.path)}</td><td class="mono muted" style="text-align:right">${f.lines} lines</td></tr>`).join("")}</tbody></table></div></section>` : ""}
<footer>Made by <b>yAI Code</b>'s /team: a lead splits the task, an architect plans how the pieces fit, builders work at the same time, then yAI's own browser checks, AI checkers, a fixer and yAI's re-check make sure it works.</footer>
</main>
${rec ? `<script type="application/json" id="rec">${rec}</script>
<script>
(function () {
  // the board's frames: each a list of indexes into a dictionary of lines, with ANSI colours
  const R = JSON.parse(document.getElementById("rec").textContent);
  const screen = document.getElementById("screen"), play = document.getElementById("play"), speed = document.getElementById("speed"), scrub = document.getElementById("scrub"), clock = document.getElementById("clock");
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  function ansi(line) {
    let out = "", st = { fg: "", bg: "", b: false, i: false }, open = false;
    const flush = () => { if (open) out += "</span>"; const css = (st.fg ? "color:" + st.fg + ";" : "") + (st.bg ? "background:" + st.bg + ";" : "") + (st.b ? "font-weight:600;" : "") + (st.i ? "font-style:italic;" : ""); open = !!css; if (css) out += '<span style="' + css + '">'; };
    for (const part of line.split(/(\\x1b\\[[0-9;]*m)/)) {
      const m = /^\\x1b\\[([0-9;]*)m$/.exec(part);
      if (!m) { out += esc(part); continue; }
      const c = m[1].split(";").map(Number);
      for (let k = 0; k < c.length; k++) {
        const n = c[k];
        if (n === 0) st = { fg: "", bg: "", b: false, i: false };
        else if (n === 1) st.b = true; else if (n === 22) st.b = false; else if (n === 3) st.i = true; else if (n === 23) st.i = false;
        else if (n === 39) st.fg = ""; else if (n === 49) st.bg = "";
        else if ((n === 38 || n === 48) && c[k + 1] === 2) { const v = "rgb(" + c[k + 2] + "," + c[k + 3] + "," + c[k + 4] + ")"; if (n === 38) st.fg = v; else st.bg = v; k += 4; }
      }
      flush();
    }
    return out + (open ? "</span>" : "");
  }
  const html = R.dict.map(ansi);
  const total = R.frames[R.frames.length - 1].t;
  scrub.max = String(total);
  let t = 0, playing = false, last = 0, shown = -1;
  const fmt = (ms) => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  function show(ms) {
    let i = 0;
    while (i + 1 < R.frames.length && R.frames[i + 1].t <= ms) i++;
    if (i !== shown) { shown = i; screen.innerHTML = R.frames[i].f.map((k) => html[k]).join("\\n"); }
    scrub.value = String(ms); clock.textContent = fmt(ms) + " / " + fmt(total);
  }
  function tick(now) {
    if (!playing) return;
    t = Math.min(total, t + (now - last) * Number(speed.value)); last = now; show(t);
    if (t >= total) { playing = false; play.textContent = "↺ Replay"; return; }
    requestAnimationFrame(tick);
  }
  play.onclick = () => { if (t >= total) t = 0; playing = !playing; play.textContent = playing ? "❚❚ Pause" : "▶ Play"; last = performance.now(); if (playing) requestAnimationFrame(tick); };
  scrub.oninput = () => { t = Number(scrub.value); show(t); };
  show(0);
})();
</script>` : ""}
</body></html>
`;
}

module.exports = { build };
