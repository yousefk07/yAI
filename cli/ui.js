"use strict";
// Terminal output in the look of the 2026-10-20 "yAI Code" design (Claude Design), the same type, neutrals and
// purple accent as the web app: a purple ● for yAI's words, your messages on a soft band behind a purple ›,
// "• Read  file  142 lines" step rows, numbered diffs on soft green and red, arrow-key choice boxes for approvals
// and /model, and a status line over the prompt. Themes (/theme): yAI Dark (default) and yAI Light from the design,
// plus the older Midnight, Classic Blue, Paper and Amber. Colours are 24-bit; with NO_COLOR or no terminal
// everything is plain text.

const { Writable } = require("stream");

const color = (process.stdout.isTTY || !!process.env.YAI_FORCE_COLOR) && !process.env.NO_COLOR;

// ---------- themes ----------
// The design's palettes, with its oklch colours converted to hex. `box` is the border style, `bg` and
// `text` set the terminal's own background and text colour (where the terminal supports it).
const ROUND = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
const SQUARE = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
const DOUBLE = { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" };
const THEMES = {
  // The design's dark and light terminals: bg = its panel, panel = its message band, accent = its purple ink.
  dark: {
    name: "yAI Dark", note: "the yAI design: warm near-black, purple accent", box: ROUND,
    bg: "#1b1b1a", panel: "#282826", fg: "#ecebe7", dim: "#a4a39d", faint: "#7a7974", line: "#383834",
    accent: "#c3aeff", user: "#c3aeff", warn: "#e0a64a", ok: "#47aa62", err: "#f69b94",
    addbg: "#15301b", addfg: "#83d494", delbg: "#3e1e1c", delfg: "#f69b94", code: "#c3aeff", soft: "#31254d", chip: "#252523",
  },
  light: {
    name: "yAI Light", note: "the yAI design: warm off-white, purple accent", box: ROUND,
    bg: "#ffffff", panel: "#ecebe7", fg: "#1c1c1a", dim: "#5c5c57", faint: "#86857f", line: "#d6d5d0",
    accent: "#693abb", user: "#693abb", warn: "#a8660b", ok: "#2e8a4e", err: "#a83634",
    addbg: "#dcf7e1", addfg: "#09672e", delbg: "#ffe7e4", delfg: "#a83634", code: "#693abb", soft: "#f0eaff", chip: "#efeeea",
  },
  midnight: {
    name: "Midnight", note: "neutral dark, violet accent, soft rounded panels", box: ROUND,
    bg: "#101217", panel: "#181b22", fg: "#d9dce2", dim: "#8a909b", faint: "#535863", line: "#2b303a",
    accent: "#c3a5f9", user: "#4ac9ec", warn: "#edbb64", ok: "#7ccd8e", err: "#f07f77",
    addbg: "#1a2a24", addfg: "#b6e3bf", delbg: "#2d1b1e", delfg: "#e8b3ad", code: "#e6d3a3",
  },
  blue: {
    name: "Classic Blue", note: "PowerShell's own console colours, square edges", box: SQUARE,
    bg: "#012456", panel: "#0b336d", fg: "#eeedf0", dim: "#a3b6d6", faint: "#6884b0", line: "#2a5591",
    accent: "#f9f1a5", user: "#61d6d6", warn: "#f9f1a5", ok: "#16c60c", err: "#ff7b7b",
    addbg: "#05434f", addfg: "#b8f5b2", delbg: "#353054", delfg: "#ffc4c4", code: "#f9f1a5",
  },
  paper: {
    name: "Paper", note: "light, for daytime and screen-sharing", box: ROUND,
    bg: "#f7f5f0", panel: "#ece9e1", fg: "#24262b", dim: "#62666f", faint: "#9a9da4", line: "#d8d4ca",
    accent: "#714ca6", user: "#006ca2", warn: "#a0600b", ok: "#21763c", err: "#b33736",
    addbg: "#d5f5da", addfg: "#085023", delbg: "#ffe2de", delfg: "#862726", code: "#7a4a12",
  },
  amber: {
    name: "Amber", note: "monochrome phosphor, double-line boxes", box: DOUBLE,
    bg: "#0d0b07", panel: "#1d170d", fg: "#ffc061", dim: "#b07f36", faint: "#6e5022", line: "#5a4119",
    accent: "#ffd894", user: "#ffe2b0", warn: "#ffd894", ok: "#ffc061", err: "#ff7a4d",
    addbg: "#352816", addfg: "#ffe2b0", delbg: "#2f1a10", delfg: "#ff9d7a", code: "#ffe2b0",
  },
};
// Older themes: the choice band and chips use their panel colour.
for (const t of Object.values(THEMES)) { t.soft ||= t.panel; t.chip ||= t.panel; }
let theme = THEMES.dark;
let themeKey = "dark";

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
const fg = (key) => (s) => (color ? `\x1b[38;2;${rgb(theme[key])}m${s}\x1b[39m` : String(s));
const bg = (key) => (s) => (color ? `\x1b[48;2;${rgb(theme[key])}m${s}\x1b[49m` : String(s));
const sgr = (open, close) => (s) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

const c = {
  bold: sgr(1, 22),
  italic: sgr(3, 23),
  ink: fg("fg"),
  dim: fg("dim"),
  faint: fg("faint"),
  line: fg("line"),
  accent: fg("accent"),
  user: fg("user"),
  green: fg("ok"),
  red: fg("err"),
  yellow: fg("warn"),
  link: fg("user"),
  code: fg("code"),
  addfg: fg("addfg"),
  delfg: fg("delfg"),
  panel: bg("panel"),
  soft: bg("soft"),
  chip: bg("chip"),
  addbg: bg("addbg"),
  delbg: bg("delbg"),
};
// Older call sites.
c.cyan = c.accent;
c.blue = c.link;
c.gray = c.dim;

// Switches theme and paints the terminal's own background and text in it (OSC 11 / 10; terminals
// that don't support it ignore it). resetTerminal() puts the user's colours back on exit.
function setTheme(key, { paint = true } = {}) {
  if (!THEMES[key]) return false;
  theme = THEMES[key];
  themeKey = key;
  if (color && paint) process.stdout.write(`\x1b]11;${theme.bg}\x07\x1b]10;${theme.fg}\x07`);
  return true;
}
function resetTerminal() {
  if (color) process.stdout.write("\x1b]110\x07\x1b]111\x07");
}

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const vis = (s) => stripAnsi(s).length;
const pad = (s, n) => s + " ".repeat(Math.max(0, n - vis(s)));
const columns = () => process.stdout.columns || Number(process.env.YAI_COLUMNS) || 100;
// The width everything is drawn to: the terminal's, less a margin, up to 120 columns on a full-screen window.
const width = () => Math.max(40, Math.min(columns() - 2, 120));

// Cut from the middle, so both ends stay readable: a command's name and a path's file name.
function middle(s, n) {
  s = String(s);
  if (s.length <= n) return s;
  if (n < 4) return s.slice(0, n);
  const head = Math.ceil((n - 1) * 0.4);
  return s.slice(0, head) + "…" + s.slice(s.length - (n - 1 - head));
}
function clip(s, n) {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
}

// readline writes through this stream so it can be silenced while the agent works:
// what the user types meanwhile is kept and shown at the next prompt.
const rlOutput = new Writable({
  write(chunk, enc, cb) {
    if (!rlOutput.muted) process.stdout.write(chunk);
    cb();
  },
});
rlOutput.muted = false;
rlOutput.isTTY = process.stdout.isTTY;
Object.defineProperty(rlOutput, "columns", { get: () => process.stdout.columns });
Object.defineProperty(rlOutput, "rows", { get: () => process.stdout.rows });
process.stdout.on("resize", () => rlOutput.emit("resize"));

// ---------- the working line: "◐ writing · 12s · 214 tokens   esc to interrupt" ----------
const FRAMES = ["◐", "◓", "◑", "◒"];
const tok = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n));
let spin = null;
// The live area (2026-10-21, yAI Code v2): lines kept at the bottom while yAI works (the plan card), with the
// working line under them. It is wiped before anything is printed and drawn again after, so it stays in place.
let liveAbove = null; // () => string[]
let liveRows = 0;     // rows the live area takes on screen now (the working line included)
const setLive = (fn) => { liveAbove = fn; };
function clearLive() {
  if (!liveRows) return;
  process.stdout.write((liveRows > 1 ? `\x1b[${liveRows - 1}A` : "") + "\r\x1b[J");
  liveRows = 0;
}

function drawSpinner() {
  if (!spin) return;
  const secs = Math.round((Date.now() - spin.start) / 1000);
  const meta = [`${secs}s`, spin.tokens ? `↓ ${tok(spin.tokens)} tokens` : "", spin.extra || ""].filter(Boolean).join(" · ");
  const line = ` ${c.accent(FRAMES[spin.frame++ % FRAMES.length])} ${c.ink(spin.text)}${c.faint(" · " + meta)}   ${c.faint("esc to pause")}`;
  const above = (liveAbove && liveAbove()) || [];
  clearLive();
  process.stdout.write([...above, line].join("\n"));
  liveRows = above.length + 1;
}
// one word ("Reading") reads better lower-cased after the spinner; a sentence (a plan step) stays as written
const word = (t) => (!t ? "thinking" : /\s/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));

const spinner = {
  hook: null, // (state) => void: { text, tokens, extra } while working, null when stopped (yai --stdio, yai remote)
  start(text) {
    if (spinner.hook) spinner.hook({ text: word(text) });
    if (!process.stdout.isTTY) return;
    if (spin) return void (spin.text = text ? word(text) : spin.text);
    spin = { text: word(text), start: Date.now(), frame: 0, tokens: 0 };
    drawSpinner();
    spin.timer = setInterval(drawSpinner, 160);
  },
  text(t) {
    if (spinner.hook) spinner.hook({ text: word(t) });
    if (spin) spin.text = word(t);
  },
  // A short note after the token count, e.g. "~$0.004" while yAI Ultra writes.
  extra(s) {
    if (spinner.hook) spinner.hook({ extra: s });
    if (spin) spin.extra = s;
  },
  tokens(n) {
    if (spinner.hook) spinner.hook({ tokens: n });
    if (spin) {
      spin.tokens = n;
      if (spin.text === "thinking") spin.text = "writing";
    }
  },
  stop() {
    if (spinner.hook) spinner.hook(null);
    if (!spin) return;
    clearInterval(spin.timer);
    spin = null;
    clearLive();
  },
  get running() {
    return !!spin;
  },
};

// ---------- printing ----------
// Print lines above the spinner without breaking it. A step row waiting for its result is
// printed first (see toolHeader).
function print(text = "") {
  flushRow();
  rawPrint(text);
}
// What was printed last ("text" or "step"), so a switch between the two gets a blank line.
let last = "";
function section(kind) {
  if (last && last !== kind) rawPrint("");
  last = kind;
}
let output = false; // the last line was a step's output (the │ gutter), not a step row
// The VS Code panel (yai --stdio) draws its own chat: with a sink set, yAI's words, steps, diffs and notes go to it
// as events instead of being drawn as terminal text. Anything else printed still arrives, as plain "out" text.
let sink = null;
const setSink = (fn) => (sink = fn);

function rawPrint(text) {
  if (sink) return sink({ type: "out", text: String(text) + "\n" });
  output = /^ {5}/.test(stripAnsi(text));
  if (spin) clearLive();
  process.stdout.write(text + "\n");
  if (spin) drawSpinner();
}

// A box in the theme's border style. `rows` are already-coloured strings; `fill` is an optional
// background per row ("panel" / "add" / "del").
function frame(rows, { indent = 1, inner = width() - indent - 2 } = {}) {
  const b = theme.box;
  const sp = " ".repeat(indent);
  print(sp + c.line(b.tl + b.h.repeat(inner) + b.tr));
  for (const r of rows) {
    const text = typeof r === "string" ? r : r.text;
    const fill = typeof r === "string" ? null : r.fill;
    const body = pad(text, inner);
    const painted = fill === "panel" ? c.panel(body) : fill === "add" ? c.addbg(body) : fill === "del" ? c.delbg(body) : body;
    print(sp + c.line(b.v) + painted + c.line(b.v));
  }
  print(sp + c.line(b.bl + b.h.repeat(inner) + b.br));
}

// ---------- Markdown, one line at a time ----------
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, x) => c.code(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x))
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, (_, p, x) => p + c.italic(x));
}

// A streamed reply: "◆ " on its first line, the rest indented under it. Runs of blank lines collapse
// to one and trailing blank lines are dropped.
function markdownWriter() {
  let inCode = false, first = true, blank = false;
  if (sink) {
    sink({ type: "text-start" });
    return (line) => sink({ type: "text", line: String(line) });
  }
  return (line) => {
    if (!inCode && !line.trim()) return void (blank = !first);
    if (blank) rawPrint("");
    blank = false;
    let out, m;
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      const lang = line.replace(/```/, "").trim();
      if (!lang) return;
      out = c.faint(lang);
    } else if (inCode) out = c.line("│ ") + c.code(line);
    else if ((m = line.match(/^(#{1,6})\s+(.*)/))) out = c.bold(c.ink(inline(m[2])));
    else if ((m = line.match(/^(\s*)[-*+]\s+(.*)/))) out = `${m[1]}${c.faint("–")} ${inline(m[2])}`;
    else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) out = c.line(theme.box.h.repeat(Math.min(48, columns() - 6)));
    else out = c.ink(inline(line));
    if (first) {
      section("text");
      print(` ${c.accent("●")} ${out}`);
      first = false;
    } else print(`   ${out}`);
  };
}
// The width replies are wrapped at, so the indent under ● still fits.
const textWidth = () => Math.max(36, width() - 4);

// The user's message, on the panel background: "› fix the billing tests".
function userLine(text) {
  if (sink) return sink({ type: "user", text: String(text) });
  const lines = String(text).split("\n");
  const first = clip(lines[0], width() - 6) + (lines.length > 1 ? c.faint(`  (+${lines.length - 1} lines)`) : "");
  rawPrint(c.panel(pad(` ${c.user("›")} ${c.ink(first)}`, width())));
}

// ---------- steps: "   • Read    api/_bizdays.js  41 lines                 0.2s" ----------
const VERB = { Read: "Read", List: "List", Find: "Find", Search: "Search", Update: "Edit", Edit: "Edit", Write: "Create", Create: "Create", PowerShell: "Run", Bash: "Run", Shell: "Run", Image: "Image", Video: "Video" };
let pending = null;

function rowText(p, result, col) {
  const icon = col === c.red ? c.red("●") : col === c.yellow ? c.yellow("!") : c.faint("•");
  const name = middle(p.verb, 24);
  const secs = (Date.now() - p.t) / 1000;
  const dur = secs < 0.1 ? "" : secs < 10 ? secs.toFixed(1) + "s" : Math.round(secs) + "s";
  const res = result ? (col ? col(result) : c.faint(result)) : "";
  const right = dur ? c.faint(dur.padStart(5)) : "";
  const label = c.bold(c.ink(name.padEnd(7)));
  const room = Math.max(10, width() - 8 - Math.max(7, name.length) - (res ? vis(res) + 2 : 0) - (right ? vis(right) + 3 : 0));
  const left = `   ${icon} ${label} ${c.ink(middle(p.arg, room))}${res ? "  " + res : ""}`;
  return right ? pad(left, width() - vis(right)) + right : left;
}
function flushRow() {
  if (!pending) return;
  const p = pending;
  pending = null;
  rawPrint(rowText(p, ""));
}

// The row is held back until its result is known, so the result, the ✓ / ✕ and the time sit on it.
function toolHeader(name, arg) {
  if (sink) return sink({ type: "step", verb: VERB[name] || String(name).charAt(0).toUpperCase() + String(name).slice(1), arg: String(arg || "") });
  flushRow();
  if (last === "step" && output) rawPrint(""); // a step that showed output gets room after it
  section("step");
  const verb = VERB[name] || String(name).charAt(0).toUpperCase() + String(name).slice(1);
  pending = { verb, arg: String(arg || ""), t: Date.now() };
}
// Drops the waiting row (used before asking to run a command, which shows the command instead).
function cancelRow() {
  if (sink) return sink({ type: "step-cancel" });
  const p = pending;
  pending = null;
  return p;
}
// A step's result. A short one-line result sits on the row; anything longer goes under it in the
// │ gutter, cut to the terminal width. `summary` puts a short label on the row as well, and `quiet`
// keeps the lines under it dim even when the row is red (a failed command shows ✕, not a red wall).
function toolResult(text, { color: col, summary, quiet } = {}) {
  if (sink) return sink({ type: "step-result", text: stripAnsi(String(text || "")), summary: summary ? stripAnsi(summary) : "", tone: col === c.red ? "error" : col === c.yellow ? "warn" : "" });
  const lines = text ? String(text).split("\n") : [];
  if (pending && summary === undefined && lines.length === 1 && vis(lines[0]) < 60) {
    const p = pending;
    pending = null;
    return rawPrint(rowText(p, lines[0].replace(/^(Read|Found|Listed|Wrote|Updated)\s+/, ""), col));
  }
  if (pending) {
    const p = pending;
    pending = null;
    rawPrint(rowText(p, summary || "", col));
  }
  const paint = col === c.red && !quiet ? c.red : c.dim;
  lines.forEach((l) => rawPrint("     " + c.line("│ ") + paint(clip(l, Math.max(20, width() - 8)))));
}
// A short note under a step, at the step's indent: "   ✓ applied · 1 file changed".
function note(text) {
  if (sink) return sink({ type: "note", text: stripAnsi(String(text)) });
  print("   " + text);
  if (last) last = "step";
}

// ---------- diffs ----------
// Line diff: trims the shared start and end, then runs an LCS on what's left.
function lineDiff(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: " ", text: a[i], an: i + 1, bn: i + 1 });
  const A = a.slice(start, endA), B = b.slice(start, endB);
  if (A.length * B.length > 4_000_000) {
    A.forEach((t, i) => ops.push({ t: "-", text: t, an: start + i + 1 }));
    B.forEach((t, i) => ops.push({ t: "+", text: t, bn: start + i + 1 }));
  } else {
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) ops.push({ t: " ", text: A[i], an: start + ++i, bn: start + ++j });
      else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push({ t: "-", text: A[i], an: start + ++i });
      else ops.push({ t: "+", text: B[j], bn: start + ++j });
    }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ t: " ", text: a[endA + k], an: endA + k + 1, bn: endB + k + 1 });
  return ops;
}

const splitLines = (s) => (s === "" ? [] : s.replace(/\r\n/g, "\n").split("\n"));

// A proposed change: a "• Edit  file  +9 −1" row, then the changed lines in a box with three lines of context,
// numbered as the file will be, removed lines on red and added lines on green. A new file shows its first lines.
function diffBox(title, before, after, { created = false, maxLines = 40 } = {}) {
  const ops = lineDiff(splitLines(before), splitLines(after));
  let added = 0, removed = 0;
  for (const o of ops) o.t === "+" ? added++ : o.t === "-" ? removed++ : 0;
  if (sink) {
    // The changed lines with three lines around them, as [kind, line number, text] (kind: " ", "+", "-", "…").
    const keep = ops.map((o, i) => ops.slice(Math.max(0, i - 3), i + 4).some((x) => x.t !== " "));
    const lines = [];
    let gap = false;
    ops.forEach((o, i) => {
      if (!keep[i]) return void (gap = true);
      if (gap && lines.length) lines.push(["…", "", ""]);
      gap = false;
      if (lines.length < 200) lines.push([o.t, o.t === "-" ? o.an : o.bn, o.text]);
    });
    sink({ type: "diff", path: title, created, added, removed, lines });
    return { added, removed };
  }
  const show = ops.map(() => false);
  ops.forEach((o, i) => {
    if (o.t !== " ") for (let k = Math.max(0, i - 3); k <= Math.min(ops.length - 1, i + 3); k++) show[k] = true;
  });
  const inner = width() - 7;
  const num = String(ops.length ? Math.max(...ops.map((o) => o.an || o.bn || 0)) : 1).length;
  const room = Math.max(10, inner - num - 5);
  const counts = created ? c.faint(`new · ${added} line${added === 1 ? "" : "s"}`) : `${c.addfg("+" + added)} ${c.delfg("−" + removed)}`;
  flushRow();
  section("step");
  rawPrint(`   ${c.faint("•")} ${c.bold(c.ink((created ? "Create" : "Edit").padEnd(7)))} ${c.ink(middle(title, inner - 20))}  ${counts}`);
  const rows = [];
  let skipped = false, printed = 0;
  ops.forEach((o, i) => {
    if (!show[i]) return void (skipped = true);
    if (printed >= maxLines) return;
    if (skipped && printed) rows.push(c.faint(" " + " ".repeat(num) + "   …"));
    skipped = false;
    printed++;
    const n = String(o.t === "-" ? o.an : o.bn).padStart(num);
    const text = clip(o.text.replace(/\t/g, "  "), room);
    if (o.t === "-") rows.push({ text: c.delfg(` ${n}  − ${text}`), fill: "del" });
    else if (o.t === "+") rows.push({ text: c.addfg(` ${n}  + ${text}`), fill: "add" });
    else rows.push(` ${c.faint(n)}    ${c.dim(text)}`);
  });
  const hidden = ops.filter((o, i) => show[i]).length - printed;
  if (hidden > 0) rows.push(c.faint(` … ${hidden} more line${hidden === 1 ? "" : "s"}`));
  frame(rows, { indent: 5, inner });
  last = "step"; // so yAI's next words get a blank line before them
  return { added, removed };
}

// ---------- choices: "[Y] Yes  [A] Yes to All  [N] No  (default is "Y"): " ----------
function choices(list, def) {
  const parts = list.map(([key, label]) => {
    const t = `${c.bold(`[${key}]`)} ${label}`;
    return key === def ? c.yellow(t) : c.ink(t);
  });
  return `   ${parts.join("  ")}  ${c.dim(`(default is "${def}"):`)} `;
}

// ---------- the welcome box ----------
// The design's start screen: "yAI• Code" and the version on the left, a rule, then label / value rows
// (model, project, context …); under the box the tips and recent sessions are printed by index.js.
function welcome({ version, rows }) {
  const inner = width() - 3;
  // A narrower window gets a narrower left column, and each row (value + grey note) is cut to fit the box.
  const leftW = inner >= 100 ? 41 : 24;
  // The wordmark drawn big in block characters (2026-10-21, like the site's videos): "yAI" two rows tall with the
  // y's tail below, the purple dot on the baseline and "Code" beside it, then the version and tagline on one line.
  const left = [
    "",
    `${c.ink("█ █")} ${c.bold(c.ink("▄▀▄ █"))}`,
    `${c.ink("▀▄█")} ${c.bold(c.ink("█▀█ █"))}${c.accent("▄")}  ${c.dim("Code")}`,
    c.ink("▄▄▀"),
    c.faint(leftW >= 41 ? `v${version} · your models, your terminal` : `v${version}`),
    "",
  ];
  const labelW = 9;
  const total = Math.max(8, inner - leftW - 5 - labelW);
  const right = rows.map(([label, value, extra]) => {
    const v = String(value);
    let e = extra ? stripAnsi(extra) : "";
    if (e && vis(v) + 1 + e.length > total) e = clip(e, Math.max(0, total - Math.min(vis(v), Math.ceil(total * 0.55)) - 1));
    if (e.length < 3) e = "";
    return `${c.faint(label.padEnd(labelW))}${c.ink(middle(v, Math.max(4, total - (e ? e.length + 1 : 0))))}${e ? " " + c.faint(e) : ""}`;
  });
  const n = Math.max(left.length, right.length + 2);
  const top = Math.floor((n - right.length) / 2);
  const body = [];
  for (let i = 0; i < n; i++) {
    const r = right[i - top] || "";
    body.push(`  ${pad(left[i] || "", leftW - 2)}${c.line(theme.box.v)}  ${r}`);
  }
  print("");
  frame(body, { indent: 1, inner });
}

// ---------- choice boxes: approvals, /model, the folder trust question ----------
// A box with an accent border: a title (and a note on its right), an optional detail on a chip, optional column
// headings, the options with a › on the chosen one (on the soft purple band), and a hint at the bottom.
// Returns the lines; index.js prints them and redraws them in place as the arrow keys move.
function selectLines({ title, note: titleNote = "", detail, header, options, selected, hint }) {
  const inner = width() - 7;
  const b = theme.box;
  const edge = (s) => c.accent(s);
  const row = (s, fill) => {
    const body = pad(s, inner);
    return `     ${edge(b.v)}${fill ? fill(body) : body}${edge(b.v)}`;
  };
  const lines = [`     ${edge(b.tl + b.h.repeat(inner) + b.tr)}`];
  const head = ` ${c.bold(c.ink(title))}`;
  lines.push(row(titleNote ? pad(head, inner - vis(titleNote) - 1) + c.faint(titleNote) : head));
  if (detail) lines.push(row(` ${c.chip(` ${c.ink(clip(detail, inner - 4))} `)}`));
  lines.push(row(""));
  if (header) lines.push(row(`   ${c.faint(header)}`));
  options.forEach((o, i) => {
    const on = i === selected;
    const text = `${on ? c.accent("›") : " "} ${on ? c.bold(c.accent(o)) : c.dim(o)}`;
    lines.push(row(` ${text}`, on ? c.soft : null));
  });
  lines.push(row(""));
  lines.push(row(` ${c.faint(hint || "↑↓ choose · enter confirm · esc cancel")}`));
  lines.push(`     ${edge(b.bl + b.h.repeat(inner) + b.br)}`);
  return lines;
}

// The line above the prompt: status on the left, keys on the right, all quiet.
function footer(left, right) {
  const l = " " + left.join(c.faint("   "));
  const r = right.join(c.faint("   "));
  return vis(l) + vis(r) + 3 <= width() ? pad(l, width() - vis(r)) + r : l;
}

// Called at each new request so the first line isn't preceded by a stray blank line.
function resetSections() {
  last = "";
}

module.exports = {
  c, print, spinner, setSink, markdownWriter, textWidth, userLine, toolHeader, toolResult, cancelRow, note, diffBox, choices, lineDiff,
  welcome, footer, frame, setLive, clearLive, pad, vis, clip, resetSections, rlOutput, stripAnsi, columns, middle, THEMES, setTheme, resetTerminal, selectLines, rawPrint, width,
  get themeKey() { return themeKey; },
};
