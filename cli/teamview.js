// The /team screens (2026-10-22, from the "yAI Code Team" design): pick your team, the team at work, and one agent.
// Only drawing lives here: team.js works out what to show (stages, what each agent is doing in plain words, its
// progress, the live feed, the estimates) and hands it over as plain data. Every function returns lines to print.
//
//   pick  — the lead's split as stages (PLAN · BUILD · JOIN · CHECK · FIX) with a rail on the left, a row per agent
//           with its model (‹ › to change it) and an estimate, presets on the right, and a Start box at the bottom.
//   run   — a bar of the stages on top, the agents under their stage with what they're doing, a progress bar, time
//           and cost; on a wide terminal the live feed (hand-offs, problems found, your notes) runs down the right.
//   agent — tabs for every agent, a side panel (its stage and model, time, tokens, cost, its steps, what it may
//           touch, who waits on it) and its transcript on the right.
module.exports = function create({ ui }) {
  const { c } = ui;
  const vis = ui.vis;
  const clip = (s, n) => { s = String(s ?? ""); return n <= 0 ? "" : s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s; };
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - vis(s)));
  const padL = (s, n) => " ".repeat(Math.max(0, n - vis(s))) + s;
  const SPIN = ["◐", "◓", "◑", "◒"];
  // a state's glyph and colour: done grey, passed green, failed red, working accent (turning), stuck yellow, waiting hollow
  const glyph = (st, tick = 0) => ({
    done: c.faint("✓"), pass: c.green("✓"), fail: c.red("✕"), work: c.accent(SPIN[tick % SPIN.length]), stuck: c.yellow("‖"),
    wait: c.faint("○"), skip: c.faint("–"), stopped: c.yellow("■"),
  })[st] || c.faint("·");
  // wraps plain text to n columns
  const wrap = (s, n) => {
    const out = [];
    let line = "";
    for (const w of String(s ?? "").split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + w.length > n) { out.push(line); line = w; }
      else line = line ? `${line} ${w}` : w;
      while (line.length > n) { out.push(line.slice(0, n)); line = line.slice(n); }
    }
    if (line) out.push(line);
    return out;
  };
  // two columns side by side, the left padded to its width
  const columns = (left, right, lw, sep = c.line(" │ ")) => {
    const n = Math.max(left.length, right.length);
    return Array.from({ length: n }, (_, i) => pad(left[i] || "", lw) + sep + (right[i] || ""));
  };
  const keyChip = (k) => c.chip(c.ink(` ${k} `));

  // ---------- pick ----------
  // groups: [{ name, note, rows: [{ n, label, on, model, desc, est, builtIn }] }] (rows in the order ↑↓ moves);
  // sel: the selected row's index across all rows, or rows.length for the Start box
  function pickLines({ title, sub, groups, sel, presets, start, width }) {
    const W = Math.max(70, width);
    const out = [];
    const chips = presets.map((p) => (p.on ? c.soft(c.bold(c.accent(` ${p.label} · ${p.count} `))) : c.dim(` ${p.label} · ${p.count} `))).join(" ");
    out.push(pad(` ${c.bold(c.ink(title))}`, W - vis(chips) - 1) + chips);
    for (const l of wrap(sub, W - 4)) out.push(`  ${c.dim(l)}`);
    out.push("");
    // narrower terminals get tighter columns, and below 100 columns no estimate column
    const narrow = W < 110, railW = narrow ? 12 : 20, estW = W < 100 ? 0 : 13, nameW = narrow ? 14 : 16, modelW = narrow ? 13 : 15;
    const descW = Math.max(8, W - railW - 3 - 2 - 4 - 4 - nameW - modelW - (estW ? estW + 2 : 0) - 5);
    let k = 0;
    for (const g of groups) {
      const on = g.rows.some((r) => r.on);
      g.rows.forEach((r, i) => {
        const label = g.rows.length === 1 ? `${c.bold(c.ink(g.name))} ${c.faint(clip(g.note, railW - g.name.length - 2))}` : i === 0 ? c.bold(c.ink(g.name)) : i === 1 ? c.faint(clip(g.note, railW - 1)) : "";
        const cur = sel === k;
        const box = r.on ? c.accent("[✓]") : c.faint("[ ]");
        const name = r.on ? c.ink(clip(r.label, nameW)) : c.faint(clip(r.label, nameW));
        const model = r.builtIn ? `  ${c.faint("built-in")}` : cur ? `${c.accent("‹")} ${c.ink(clip(r.model, modelW - 4))} ${c.accent("›")}` : `  ${(r.on ? c.ink : c.faint)(clip(r.model, modelW - 4))}`;
        const desc = c.dim(clip(r.desc, descW));
        const est = c.faint(clip(r.est || "", estW));
        let row = `${cur ? c.accent("›") : " "} ${box} ${c.faint(String(r.n).padStart(2))}  ${pad(cur ? c.bold(name) : name, nameW)}  ${pad(model, modelW)}  ${pad(desc, descW)}${estW ? `  ${padL(est, estW)}` : ""}`;
        if (cur) row = c.soft(pad(row, W - railW - 3));
        out.push(` ${pad(label, railW)}${(on ? c.accent : c.line)("│")} ${row}`);
        k++;
      });
      out.push(` ${" ".repeat(railW)}${c.line("│")}`);
    }
    out.pop();
    out.push("");
    // the Start box
    const onStart = sel === k;
    const border = onStart ? c.accent : c.line;
    const button = onStart ? c.soft(c.bold(c.accent(` ▶ Start ${start.n} agent${start.n === 1 ? "" : "s"} `))) : c.bold(c.accent(` ▶ Start ${start.n} agent${start.n === 1 ? "" : "s"} `));
    const factList = [start.time && `${c.bold(c.ink(start.time))} ${c.faint("est.")}`, start.cost && `${c.bold(c.ink(start.cost))} ${c.faint("est.")}`, start.parallel && c.dim(`${start.parallel} at once`), start.rounds > 1 && c.accent(`${start.rounds} rounds`), start.cap && c.faint(`stops at ${start.cap}`), start.short && c.red(`only ${start.short} left today`), c.faint("edits without asking · commands still ask")].filter(Boolean);
    const right = c.faint("c chat about the plan ");
    const inner = W - 4, room = inner - 2; // the text sits one space in from each side
    // on a narrow terminal the least important facts go first
    while (factList.length > 1 && vis(button) + 3 + vis(factList.join("   ")) > room) factList.pop();
    const facts = factList.join(c.faint("   "));
    const body = vis(button) + 3 + vis(facts) + 2 + vis(right) <= room ? pad(`${button}   ${facts}`, room - vis(right)) + right : pad(`${button}   ${facts}`, room);
    out.push(` ${border("╭" + "─".repeat(inner) + "╮")}`, ` ${border("│")} ${pad(body, room)} ${border("│")}`, ` ${border("╰" + "─".repeat(inner) + "╯")}`);
    return out;
  }

  // ---------- run ----------
  // strip: [{ label, total, done, working, current }]; stages: [{ name, note, current, rows: [{ n, st, name, act,
  // actTone, pct, time, cost }] }]; feed: [{ t, who, whoTone, what, quote }] newest first; sel: a row index or -1
  function runLines({ title, stats, strip, stages, feed, sel, width, height, tick }) {
    const W = Math.max(70, width);
    const out = [];
    // the title and the totals on one line, the totals under it when they don't fit
    const facts = stats.filter(Boolean).join(c.faint("   "));
    if (vis(title) + vis(facts) + 4 <= W) out.push(pad(` ${title}`, W - vis(facts) - 1) + facts);
    else out.push(` ${title}`, ` ${facts}`);
    // the stage bar: one segment per stage, sized by how many agents it has
    const barW = W - 2 - (strip.length - 1);
    const weight = strip.reduce((s, x) => s + Math.max(1, x.total), 0);
    let used = 0;
    const segs = strip.map((x, i) => {
      const w = i === strip.length - 1 ? barW - used : Math.max(4, Math.round((barW * Math.max(1, x.total)) / weight));
      used += w;
      const doneW = x.total ? Math.round((w * x.done) / x.total) : x.past ? w : 0;
      const workW = x.total ? Math.min(w - doneW, Math.round((w * x.working) / x.total)) : 0;
      const bar = c.dim("━".repeat(doneW)) + c.accent("━".repeat(workW)) + c.line("━".repeat(w - doneW - workW));
      const lab = clip(x.label, w);
      return { bar, lab: x.current ? c.bold(c.accent(pad(lab, w))) : (x.past ? c.dim : c.faint)(pad(lab, w)) };
    });
    out.push(` ${segs.map((s) => s.bar).join(" ")}`, ` ${segs.map((s) => s.lab).join(" ")}`, "");
    // the agents, under their stages
    // the feed gets a third of a wide window (up to 72 columns), so the space goes to what agents say
    const feedW = W >= 118 ? Math.min(72, Math.floor(W * 0.34)) : 0;
    const LW = feedW ? W - feedW - 3 : W;
    const timeW = 7, costW = LW >= 90 ? 7 : 0, barCol = LW >= 96 ? 10 : 0, nameW = LW >= 120 ? 22 : LW >= 90 ? 16 : 13;
    const actW = Math.max(10, LW - 4 - 2 - nameW - 2 - (barCol ? barCol + 2 : 0) - timeW - (costW ? costW + 1 : 0) - 3);
    const left = [];
    let k = 0;
    for (const g of stages) {
      left.push(` ${(g.current ? (s) => c.bold(c.accent(s)) : (s) => c.bold(c.faint(s)))(g.name)}  ${c.faint(clip(g.note, LW - g.name.length - 4))}`);
      for (const r of g.rows) {
        const cur = sel === k++;
        const tone = { work: c.ink, stuck: c.yellow, fail: c.red, pass: c.dim, done: c.dim, wait: c.faint, skip: c.faint, stopped: c.yellow }[r.st] || c.dim;
        const name = (r.st === "wait" || r.st === "skip" ? c.faint : (s) => c.bold(c.ink(s)))(clip(r.name, nameW));
        let bar = "";
        if (barCol) {
          const fill = Math.round((barCol * Math.max(0, Math.min(100, r.pct))) / 100);
          const col = { work: c.accent, stuck: c.yellow, fail: c.red, pass: c.green }[r.st] || c.dim;
          bar = r.st === "wait" || r.st === "skip" ? " ".repeat(barCol) : col("━".repeat(fill)) + c.line("━".repeat(barCol - fill));
        }
        let row = `${c.faint(String(r.n).padStart(2))} ${glyph(r.st, tick)} ${pad(name, nameW)}  ${pad(tone(clip(r.act, actW)), actW)}  ${barCol ? bar + "  " : ""}${padL(c.dim(r.time || ""), timeW)}${costW ? " " + padL(c.faint(r.cost || ""), costW) : ""}`;
        if (cur) row = c.soft(pad(row, LW - 1));
        left.push(` ${row}`);
      }
    }
    if (!feedW) return [...out, ...left];
    // the live feed, newest first, as tall as the agents (or the screen)
    const rows = Math.max(left.length, Math.min(height || 0, 40));
    const right = [`${c.bold(c.ink("LIVE"))}${" ".repeat(Math.max(1, feedW - 16))}${c.faint("newest first")}`];
    for (const f of feed) {
      if (right.length >= rows) break;
      const whoTone = { ok: c.green, bad: c.red, warn: c.yellow, acc: c.accent, you: c.dim }[f.whoTone] || c.ink;
      const head = wrap(`${f.who} ${f.what}`, feedW - 6);
      head.forEach((l, i) => {
        const shown = i === 0 ? whoTone(c.bold(l.slice(0, f.who.length))) + c.dim(l.slice(f.who.length)) : c.dim(l);
        right.push(`${i === 0 ? c.faint(pad(f.t, 5)) : "     "} ${shown}`);
      });
      if (f.quote) for (const l of wrap(f.quote, feedW - 9).slice(0, 3)) right.push(`      ${c.line("▎")} ${c.dim(l)}`);
    }
    return [...out, ...columns(left, right.slice(0, rows), LW)];
  }

  // ---------- one agent ----------
  // tabs: [{ name, st, on }]; side: { n, name, where, desc, stats: [[value, label]], steps: [{ l, st }], touch: [[what,
  // how]], waiting: [names] }; body: transcript lines (already drawn), shown bottom-up to fit `height`
  function agentLines({ tabs, side, body, width, height, tick }) {
    const W = Math.max(70, width);
    // the tabs, scrolled so the open one shows
    const parts = tabs.map((t) => {
      const s = ` ${glyph(t.st, tick)} ${t.name} `;
      return t.on ? c.soft(c.bold(c.accent(s))) : c.dim(s);
    });
    const head = c.faint("esc ← team  ");
    let from = 0;
    const on = Math.max(0, tabs.findIndex((t) => t.on));
    const fits = (a, b) => vis(head) + parts.slice(a, b + 1).reduce((s, p) => s + vis(p) + 1, 0) <= W - 2;
    while (from < on && !fits(from, on)) from++;
    let to = on;
    while (to + 1 < parts.length && fits(from, to + 1)) to++;
    const out = [` ${head}${from ? c.faint("… ") : ""}${parts.slice(from, to + 1).join(" ")}${to < parts.length - 1 ? c.faint(" …") : ""}`, c.line(" " + "─".repeat(W - 2))];
    // the side panel
    const SW = W >= 100 ? 34 : 0;
    const s = [];
    if (SW) {
      s.push(`${c.soft(c.bold(c.accent(` ${side.n} `)))} ${c.bold(c.ink(clip(side.name, SW - 6)))}`);
      s.push(`     ${c.faint(clip(side.where, SW - 6))}`, "");
      for (const l of wrap(side.desc, SW - 1).slice(0, 4)) s.push(c.dim(l));
      s.push("");
      const cell = Math.floor((SW - 1) / side.stats.length);
      s.push(side.stats.map(([v]) => pad(c.bold(c.ink(clip(v, cell - 1))), cell)).join(""));
      s.push(side.stats.map(([, l]) => pad(c.faint(clip(l, cell - 1)), cell)).join(""));
      const section = (title, lines) => { if (lines.length) s.push("", c.bold(c.faint(title)), ...lines); };
      section("ITS STEPS", side.steps.map((x) => `${x.st === "done" ? c.faint("✓") : x.st === "work" ? c.accent(SPIN[tick % SPIN.length]) : c.faint("○")} ${(x.st === "work" ? (t) => c.bold(c.ink(t)) : x.st === "done" ? c.ink : c.faint)(clip(x.l, SW - 3))}`));
      const touchW = Math.min(18, Math.max(...side.touch.map(([w]) => w.length), 4));
      section("CAN TOUCH", side.touch.map(([what, how]) => `${pad(c.dim(clip(what, touchW)), touchW)}  ${c.faint(clip(how, SW - touchW - 3))}`));
      section("WAITING ON IT", side.waiting.length ? wrap(side.waiting.map((n) => `○ ${n}`).join("  "), SW - 1).map((l) => c.dim(l)) : [c.faint("nobody")]);
    }
    const room = Math.max(8, (height || 30) - out.length);
    const shown = body.length > room ? body.slice(-room) : body;
    const rows = Math.max(s.length, shown.length);
    const right = [...Array(Math.max(0, rows - shown.length)).fill(""), ...shown]; // the transcript sits at the bottom
    return [...out, ...(SW ? columns(s, right, SW) : right).map((l) => ` ${l}`)].slice(0, out.length + room);
  }

  return { pickLines, runLines, agentLines, glyph, wrap, clip, keyChip, SPIN };
};
