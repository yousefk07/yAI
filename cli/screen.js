"use strict";
// yAI Code as a full-window app (2026-10-21, Claude Design "yAI Code v2"): the terminal's alternate screen, drawn
// whole on every change:
//
//   yAI• Code │ shop-cart on main ·································· ● Working · step 2 of 4
//   ──────────────────────────────────────────────────────────────────────────────────────────
//   the conversation (everything yAI Code prints), scrolled to the     │ Plan        1 of 4 done
//   bottom unless you scroll back (PgUp/PgDn, the mouse wheel);        │ ━━━━━──────────────────
//   the working line, approval cards and /command suggestions sit      │ ✓ Read server.py
//   at its end                                                         │ ● Add the /health route
//   ╭──────────────────────────────────────────────────────────────────────────────────────╮
//   │ › Add a note while I work…                              I'll read it after this step │
//   ╰──────────────────────────────────────────────────────────────────────────────────────╯
//    esc pause   d hide changes                       shift+tab asks before changes · model · memory
//
// index.js supplies what goes in each part (header, panel, input, keys); ui.js sends printed lines here.

module.exports = function create({ ui }) {
  const { c } = ui;
  const out = (s) => process.stdout.write(s);
  const lines = []; // { text, wrapped: { w, rows } }
  let scroll = 0; // rows scrolled back from the bottom
  let live = []; // the working line (and the plan card on a narrow screen)
  let extra = []; // approval cards, /team's board, suggestions: drawn after the conversation
  let on = false, pending = false, centerUpTo = -1;
  const parts = { header: () => "", panel: () => null, input: () => ({ text: "", cursor: 0 }), keys: () => "" };

  // ---------- ANSI-aware wrapping ----------
  const ESC = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/y;
  function wrap(text, w) {
    if (ui.vis(text) <= w) return [text];
    const rows = [];
    let cur = "", n = 0, sgr = "", i = 0;
    while (i < text.length) {
      ESC.lastIndex = i;
      const m = ESC.exec(text);
      if (m) {
        cur += m[0];
        if (m[0].endsWith("m")) sgr = /\x1b\[0?m$/.test(m[0]) ? "" : sgr + m[0];
        i += m[0].length;
        continue;
      }
      const ch = String.fromCodePoint(text.codePointAt(i));
      if (n >= w) { rows.push(cur + "\x1b[0m"); cur = sgr; n = 0; }
      cur += ch;
      n++;
      i += ch.length;
    }
    rows.push(cur);
    return rows;
  }
  // Words wrap; drawn lines (boxes, cards, bands with a background) are cut instead, so a box printed when the window
  // was wider doesn't fall apart when the plan panel opens.
  // (rows laid out in columns, with a gap of spaces before something pushed to the right, count as drawn too)
  const drawn = (t) => /[│╭╰╮╯─━]|\x1b\[48;/.test(t) || /\S {4,}\S/.test(ui.stripAnsi(t).trim());
  const rowsOf = (entry, w) => {
    if (!entry.wrapped || entry.wrapped.w !== w) entry.wrapped = { w, rows: drawn(entry.text) && ui.vis(entry.text) > w ? [wrap(entry.text, w)[0] + "\x1b[0m"] : wrap(entry.text, w) };
    return entry.wrapped.rows;
  };
  const fit = (s, w) => {
    const v = ui.vis(s);
    if (v === w) return s;
    if (v < w) return s + " ".repeat(w - v);
    return wrap(s, w)[0] + "\x1b[0m";
  };

  // ---------- drawing ----------
  function render() {
    pending = false;
    if (!on) return;
    // One column is left empty: a symbol some fonts draw two cells wide (◆, ●) can't push a row past the edge, and
    // nothing is ever written in the bottom-right corner (which makes some consoles scroll).
    const cols = (process.stdout.columns || 100) - 1, rows = process.stdout.rows || 30;
    const screen = [];
    // header and its rule
    screen.push(fit(parts.header(cols), cols));
    screen.push(c.line("─".repeat(cols)));
    // the input box and the key bar at the bottom
    const inp = parts.input();
    const inner = cols - 4;
    const hint = inp.hint ? c.faint(inp.hint) : "";
    const room = Math.max(10, inner - 3 - (hint ? ui.vis(hint) + 2 : 0));
    const shown = inp.text ? inp.text : "";
    const textRows = [];
    for (let k = 0; k === 0 || k < shown.length; k += room) textRows.push(shown.slice(k, k + room));
    const box = textRows.slice(-4);
    const first = Math.max(0, textRows.length - 4);
    const boxLines = box.map((t, k) => {
      const lead = k === 0 && first === 0 ? `${c.bold(c.accent(inp.label || "›"))} ` : "  ";
      const body = t ? c.ink(t) : k === 0 && !shown ? c.faint(inp.placeholder || "") : "";
      const left = " " + lead + body;
      const right = k === box.length - 1 && hint ? hint + " " : "";
      return (inp.active ? c.accent("│") : c.line("│")) + fit(ui.pad(left, inner + 2 - ui.vis(right)) + right, inner + 2) + (inp.active ? c.accent("│") : c.line("│"));
    });
    const edge = inp.active ? c.accent : c.line;
    const bottom = [edge("╭" + "─".repeat(cols - 2) + "╮"), ...boxLines, edge("╰" + "─".repeat(cols - 2) + "╯"), fit(parts.keys(cols), cols)];
    // the middle: the conversation, with the plan panel on its right when there is one
    const midH = Math.max(3, rows - screen.length - bottom.length);
    const panel = cols >= 100 ? parts.panel() : null;
    const pw = panel ? Math.min(40, Math.max(32, Math.floor(cols * 0.28))) : 0;
    const tw = cols - (panel ? pw + 3 : 0) - 2;
    const body = [];
    lines.forEach((e) => body.push(...rowsOf(e, tw)));
    const tail = [...extra, ...live].flatMap((t) => wrap(t, tw));
    const all = [...body, ...tail];
    scroll = Math.max(0, Math.min(scroll, Math.max(0, all.length - midH)));
    let view = all.slice(Math.max(0, all.length - midH - scroll), all.length - scroll);
    if (view.length < midH) {
      // the start screen sits in the middle; a conversation sits just above the input
      const gap = midH - view.length;
      const top = centerUpTo >= 0 && lines.length <= centerUpTo ? Math.floor(gap / 2) : gap;
      view = [...Array(top).fill(""), ...view, ...Array(gap - top).fill("")];
    }
    const panelRows = panel ? panel(pw - 2) : [];
    for (let r = 0; r < midH; r++) {
      let row = " " + fit(view[r] || "", tw) + " ";
      if (panel) row += c.line("│") + " " + fit(panelRows[r] || "", pw - 2) + " ";
      screen.push(fit(row, cols));
    }
    if (scroll > 0) screen[screen.length - 1] = fit(` ${c.chip(c.dim(` ↓ ${scroll} more lines below · PgDn or the wheel to go back down `))}`, cols);
    screen.push(...bottom);
    // the cursor goes where you type
    const caretRow = screen.length - bottom.length + 1 + Math.min(box.length - 1, Math.floor((inp.cursor || 0) / room) - first);
    const caretCol = 1 + 1 + 2 + ((inp.cursor || 0) % room) + 1;
    // Only the rows that changed are written, each at its own place (so one that wraps can't shift the rest), inside
    // a synchronized update so the terminal shows the whole frame at once.
    const frame = screen.slice(0, rows);
    while (frame.length < rows) frame.push("");
    if (shown_.cols !== cols || shown_.rows !== rows) { shown_ = { cols, rows, lines: [] }; out("\x1b[2J"); }
    let w = "";
    frame.forEach((l, i) => {
      if (shown_.lines[i] === l) return;
      w += `\x1b[${i + 1};1H\x1b[0m${l}\x1b[0m\x1b[K`;
    });
    shown_.lines = frame;
    const caret = inp.caret === false ? "\x1b[?25l" : `\x1b[${caretRow + 1};${caretCol}H\x1b[?25h`;
    if (w || caret !== shown_.caret) out("\x1b[?2026h\x1b[?25l" + w + caret + "\x1b[?2026l");
    shown_.caret = caret;
  }
  let shown_ = { cols: 0, rows: 0, lines: [] }; // what's on the screen now, row by row
  const soon = () => { if (on && !pending) { pending = true; setImmediate(render); } };

  return {
    get on() { return on; },
    parts,
    enter() {
      if (on) return;
      on = true;
      // the alternate screen, the mouse wheel (SGR reports), and the window's own colours
      out("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J");
      process.stdout.on("resize", soon);
      const restore = () => this.exit();
      process.on("exit", restore);
      soon();
    },
    exit() {
      if (!on) return;
      on = false;
      out("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
    },
    add(text) {
      for (const l of String(text).split("\n")) lines.push({ text: l });
      if (lines.length > 6000) lines.splice(0, lines.length - 5000);
      soon();
    },
    clear() { lines.length = 0; scroll = 0; centerUpTo = -1; soon(); },
    centerFirst(n) { centerUpTo = n; soon(); },
    // The start screen gives way to the conversation (as in the design) when the first message is sent.
    endStart() { if (centerUpTo >= 0 && lines.length <= centerUpTo + 2) lines.length = 0; centerUpTo = -1; soon(); },
    setLive(l) { live = l || []; soon(); },
    setExtra(l) { extra = l || []; soon(); },
    scrollBy(n) { scroll = Math.max(0, scroll + n); soon(); },
    page(dir) { scroll = Math.max(0, scroll + dir * Math.max(3, (process.stdout.rows || 30) - 12)); soon(); },
    toBottom() { scroll = 0; soon(); },
    render: soon,
    now: render,
    // the conversation pane's width, for lines printed into it
    width() {
      const cols = (process.stdout.columns || 100) - 1; // as in render()
      const panel = cols >= 100 && parts.panel();
      return Math.min(140, cols - 4 - (panel ? Math.min(40, Math.max(32, Math.floor(cols * 0.28))) + 3 : 0));
    },
  };
};
