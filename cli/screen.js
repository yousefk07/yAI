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
//
// Copying (2026-10-21): the app takes the mouse (for the wheel), so the terminal can't select text itself; dragging
// selects here instead, like Claude Code: the text is highlighted, and copied to the clipboard when you let go.

module.exports = function create({ ui }) {
  const { c } = ui;
  const out = (s) => process.stdout.write(s);
  const lines = []; // { text, wrapped: { w, rows } }
  let scroll = 0; // rows scrolled back from the bottom
  let live = []; // the working line (and the plan card on a narrow screen)
  let extra = []; // approval cards, /team's board, suggestions: drawn after the conversation
  let on = false, pending = false, centerUpTo = -1;
  let sel = null; // a drag selection: { a: [row, col], b: [row, col], pane: [firstCol, lastCol], moved }
  let toast = null, toastTimer = null;
  let rowInfo = []; // per screen row: { soft: it continues the row above (a wrapped line), pane: [firstCol, lastCol] }
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
    const all = [], soft = [];
    const push = (rs) => rs.forEach((r, k) => { all.push(r); soft.push(k > 0); });
    lines.forEach((e) => push(rowsOf(e, tw)));
    [...extra, ...live].forEach((t) => push(wrap(t, tw)));
    scroll = Math.max(0, Math.min(scroll, Math.max(0, all.length - midH)));
    let view = all.slice(Math.max(0, all.length - midH - scroll), all.length - scroll);
    let viewSoft = soft.slice(Math.max(0, all.length - midH - scroll), all.length - scroll);
    if (view.length < midH) {
      // the start screen sits in the middle; a conversation sits just above the input
      const gap = midH - view.length;
      const top = centerUpTo >= 0 && lines.length <= centerUpTo ? Math.floor(gap / 2) : gap;
      view = [...Array(top).fill(""), ...view, ...Array(gap - top).fill("")];
      viewSoft = [...Array(top).fill(false), ...viewSoft, ...Array(gap - top).fill(false)];
    }
    // where each row's text sits, for selecting: the conversation, the plan panel, or the whole row
    rowInfo = screen.map(() => ({ soft: false, pane: [1, cols] }));
    for (let r = 0; r < midH; r++) rowInfo.push({ soft: !!viewSoft[r], pane: [2, tw + 1], panel: panel ? [tw + 5, tw + 4 + pw - 2] : null });
    const panelRows = panel ? panel(pw - 2) : [];
    for (let r = 0; r < midH; r++) {
      let row = " " + fit(view[r] || "", tw) + " ";
      if (panel) row += c.line("│") + " " + fit(panelRows[r] || "", pw - 2) + " ";
      screen.push(fit(row, cols));
    }
    if (scroll > 0) screen[screen.length - 1] = fit(` ${c.chip(c.dim(` ↓ ${scroll} more lines below · PgDn or the wheel to go back down `))}`, cols);
    if (toast) screen[screen.length - 1] = fit(` ${c.chip(c.ink(` ${toast} `))}`, cols);
    screen.push(...bottom);
    while (rowInfo.length < screen.length) rowInfo.push({ soft: false, pane: [1, cols] });
    // the cursor goes where you type
    const caretRow = screen.length - bottom.length + 1 + Math.min(box.length - 1, Math.floor((inp.cursor || 0) / room) - first);
    const caretCol = 1 + 1 + 2 + ((inp.cursor || 0) % room) + 1;
    // Only the rows that changed are written, each at its own place (so one that wraps can't shift the rest), inside
    // a synchronized update so the terminal shows the whole frame at once.
    const frame = screen.slice(0, rows);
    while (frame.length < rows) frame.push("");
    for (const [i, s, e] of selSpans()) {
      if (!frame[i - 1]) continue;
      const plain = ui.stripAnsi(frame[i - 1]);
      frame[i - 1] = plain.slice(0, s - 1) + "\x1b[7m" + plain.slice(s - 1, e) + "\x1b[27m" + plain.slice(e);
    }
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

  // ---------- selecting and copying ----------
  // The pane a column falls in on a row: the conversation, the plan panel, or the whole row.
  function paneAt(row, col) {
    const info = rowInfo[row - 1];
    if (!info) return [1, (process.stdout.columns || 100) - 1];
    return info.panel && col >= info.panel[0] - 1 ? info.panel : info.pane;
  }
  // The selected stretch of each row, as [row, firstCol, lastCol] (1-based, inclusive), kept inside the pane the
  // drag started in, so a selection in the conversation doesn't pick up the plan panel beside it.
  function selSpans() {
    if (!sel || !sel.moved) return [];
    let [a, b] = [sel.a, sel.b];
    if (b[0] < a[0] || (b[0] === a[0] && b[1] < a[1])) [a, b] = [b, a];
    const [p0, p1] = sel.pane;
    const spans = [];
    for (let r = a[0]; r <= b[0]; r++) {
      const s = Math.max(p0, r === a[0] ? a[1] : p0), e = Math.min(p1, r === b[0] ? b[1] : p1);
      if (e >= s) spans.push([r, s, e]);
    }
    return spans;
  }
  function selectedText() {
    const spans = selSpans();
    let text = "";
    spans.forEach(([r, s, e], k) => {
      const plain = ui.stripAnsi(shown_.lines[r - 1] || "");
      const next = spans[k + 1];
      const joins = next && rowInfo[next[0] - 1]?.soft; // a wrapped line goes back together
      const part = plain.slice(s - 1, e);
      text += joins ? part : part.replace(/\s+$/, "") + (next ? "\n" : "");
    });
    return text.replace(/\s+$/, "");
  }
  // The clipboard: the system's own copy command, and OSC 52 for terminals that take it (over SSH too).
  function copy(text) {
    const { spawnSync, spawn } = require("child_process");
    const run = (cmd, args, input) => { try { return spawnSync(cmd, args, { input, timeout: 3000, windowsHide: true }).status === 0; } catch { return false; } };
    if (process.platform === "win32") {
      // PowerShell keeps any character (clip.exe mangles them); it runs in the background, so the screen doesn't wait
      try {
        const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
        p.on("error", () => {});
        p.stdin.end(text, "utf8");
      } catch {}
    }
    else if (process.platform === "darwin") run("pbcopy", [], text);
    else run("wl-copy", [], text) || run("xclip", ["-selection", "clipboard"], text);
    out(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
  }
  function showToast(t) {
    toast = t;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; soon(); }, 1800);
    soon();
  }
  const soon = () => { if (on && !pending) { pending = true; setImmediate(render); } };

  return {
    get on() { return on; },
    parts,
    enter() {
      if (on) return;
      on = true;
      // the alternate screen, the mouse wheel (SGR reports), and the window's own colours
      out("\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[2J");
      process.stdout.on("resize", soon);
      const restore = () => this.exit();
      process.on("exit", restore);
      soon();
    },
    exit() {
      if (!on) return;
      on = false;
      out("\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[?1049l");
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
    scrollBy(n) { scroll = Math.max(0, scroll + n); sel = null; soon(); },
    // A mouse report (SGR): the left button down starts a selection, moving with it held extends it, letting go copies.
    mouse(btn, col, row, release) {
      if (btn === 0 && !release) { sel = { a: [row, col], b: [row, col], pane: paneAt(row, col), moved: false }; return soon(); }
      if (btn === 32 && sel) { sel.b = [row, col]; sel.moved = sel.moved || sel.a[0] !== row || sel.a[1] !== col; return soon(); }
      if (btn === 0 && release && sel) {
        if (!sel.moved) { sel = null; return soon(); }
        render(); // the highlight and the text come from the same frame
        const text = selectedText();
        if (text) { copy(text); showToast(`Copied ${text.length} character${text.length === 1 ? "" : "s"}`); }
      }
    },
    clearSelection() { if (sel) { sel = null; soon(); } },
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
