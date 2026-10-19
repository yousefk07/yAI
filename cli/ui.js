"use strict";
// Terminal output in yAI's own look ("Ink"): the website's monochrome ink on paper, the y. mark,
// one quiet row per step (a coloured verb, no marker), short │ gutters for output and diffs that
// never wrap, and a quiet dot pulse while it works.
// Colour is only used for meaning: green = added / done, rose = removed / failed, amber = careful.

const { Writable } = require("stream");

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (open, close) => (s) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const c = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  ink: sgr("38;5;255", 39), // the website's --ink on dark (#ecebe7)
  green: sgr("38;5;78", 39), // --ok #5cc27f
  red: sgr("38;5;174", 39), // a muted rose, never alarm red
  yellow: sgr("38;5;179", 39), // --warn #e0a64a
  link: sgr("38;5;111", 39), // --link #8fb0ff
  code: sgr("38;5;187", 39), // warm paper tone for `code`
};
// Older call sites: emphasis is plain bright ink, never a brand colour.
c.accent = (s) => c.bold(c.ink(s));
c.cyan = c.accent;
c.blue = c.link;
c.gray = c.dim;

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const columns = () => process.stdout.columns || 100;
// The logo: the website's ink tile with "y." on it. Without colour it's just "y.".
const MARK = () => (color ? "[48;5;255m[38;5;233m[1m y. [22m[39m[49m" : "y.");

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

// ---------- the working indicator: a dot pulse and a plain word for what it's doing ----------
const FRAMES = ["·  ", "·· ", "···", " ··", "  ·", "   "];
const tok = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n));
let spin = null;

function drawSpinner() {
  if (!spin) return;
  const secs = Math.round((Date.now() - spin.start) / 1000);
  const meta = [`${secs}s`, spin.tokens ? `${tok(spin.tokens)} tok` : "", "esc stops"].filter(Boolean).join(" · ");
  const line = ` ${c.ink(FRAMES[spin.frame++ % FRAMES.length])} ${c.ink(spin.text)}  ${c.dim(meta)}`;
  process.stdout.write("\r\x1b[K" + line);
}
const word = (t) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : "thinking");

const spinner = {
  start(text) {
    if (!process.stdout.isTTY) return;
    if (spin) return void (spin.text = text ? word(text) : spin.text);
    spin = { text: word(text), start: Date.now(), frame: 0, tokens: 0 };
    drawSpinner();
    spin.timer = setInterval(drawSpinner, 140);
  },
  text(t) {
    if (spin) spin.text = word(t);
  },
  tokens(n) {
    if (spin) spin.tokens = n;
  },
  stop() {
    if (!spin) return;
    clearInterval(spin.timer);
    spin = null;
    process.stdout.write("\r\x1b[K");
  },
  get running() {
    return !!spin;
  },
};

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
let indented = false; // the last line was a step's output (│ gutter, "✓ saved" …), not a step row
function rawPrint(text) {
  indented = /^ {3}/.test(stripAnsi(text));
  if (spin) process.stdout.write("\r\x1b[K");
  process.stdout.write(text + "\n");
  if (spin) drawSpinner();
}

// ---------- Markdown, one line at a time ----------
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, x) => c.code(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x))
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, (_, p, x) => p + c.italic(x));
}

// A streamed reply: plain text on a one-space margin, no bullets or badges. Runs of blank lines
// collapse to one, and trailing blank lines are dropped, so a step never follows a gap of three.
function markdownWriter() {
  let inCode = false, first = true, blank = false;
  return (line) => {
    let out;
    let m;
    if (!inCode && !line.trim()) return void (blank = !first);
    if (blank) print("");
    blank = false;
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      const lang = line.replace(/```/, "").trim();
      if (!lang) return;
      out = c.dim(lang);
    } else if (inCode) out = c.dim("│ ") + c.code(line);
    else if ((m = line.match(/^(#{1,6})\s+(.*)/))) out = c.bold(c.ink(inline(m[2])));
    else if ((m = line.match(/^(\s*)[-*+]\s+(.*)/))) out = `${m[1]}${c.dim("–")} ${inline(m[2])}`;
    else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) out = c.dim("─".repeat(Math.min(48, columns() - 4)));
    else out = inline(line);
    if (first && !line.trim()) return;
    if (first) section("text");
    print(" " + out);
    first = false;
  };
}

// ---------- steps: one row each ("read    src/app.js · 42 lines") ----------
// Looking around (read, list, find, search) is quiet; changing things (edit, create, run) stands out.
const VERB = { Read: "read", List: "list", Find: "find", Search: "search", Update: "edit", Edit: "edit", Write: "create", Create: "create", PowerShell: "run", Bash: "run", Shell: "run", Image: "image", Video: "video" };
const LOOKS = new Set(["read", "list", "find", "search"]);
let pending = null;

// Cut from the middle, so both ends stay readable: a command's name and a path's file name.
function middle(s, n) {
  if (s.length <= n) return s;
  const head = Math.ceil((n - 1) * 0.4);
  return s.slice(0, head) + "…" + s.slice(s.length - (n - 1 - head));
}
// One gutter line, cut to the terminal width so it never wraps under the │.
function clipLine(s, indent = 6) {
  const room = Math.max(20, columns() - indent);
  return s.length > room ? s.slice(0, room - 1) + "…" : s;
}

function rowText(verb, arg, result, col) {
  const res = result ? stripAnsi(result) : "";
  const a = middle(arg, Math.max(16, columns() - 12 - (res ? res.length + 3 : 0)));
  const quiet = LOOKS.has(verb);
  const head = " " + (quiet ? c.dim(verb.padEnd(7)) : c.bold(c.ink(verb.padEnd(7)))) + " " + (quiet ? c.ink(a) : c.bold(c.ink(a)));
  return head + (result ? c.dim(" · ") + (col ? col(result) : c.dim(result)) : "");
}
function flushRow() {
  if (!pending) return;
  const p = pending;
  pending = null;
  rawPrint(rowText(p.verb, p.arg, ""));
}

// The row is held back a moment so a one-line result can sit on the same line.
function toolHeader(name, arg) {
  flushRow();
  // A step that showed output gets a blank line after it, so the next step doesn't sit on top of it.
  if (last === "step" && indented) rawPrint("");
  section("step");
  pending = { verb: VERB[name] || String(name).toLowerCase(), arg: String(arg || "") };
}
function toolResult(text, { color: col } = {}) {
  const lines = String(text).split("\n");
  if (pending && lines.length === 1 && stripAnsi(lines[0]).length < 60) {
    const p = pending;
    pending = null;
    const short = lines[0].replace(/^(Read|Found|Listed|Wrote|Updated)\s+/, "");
    return rawPrint(rowText(p.verb, p.arg, short, col));
  }
  flushRow();
  lines.forEach((l) => rawPrint("   " + c.dim("│ ") + (col ? col(clipLine(l)) : c.dim(clipLine(l)))));
}
// A short note under a step, on the same margin.
function note(text) {
  print("   " + text);
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

// Diff lines for the │ gutter: "19 + added" in green, "18 − removed" in rose, context dimmed.
function renderDiff(before, after, { context = 3, maxLines = 60 } = {}) {
  const ops = lineDiff(splitLines(before), splitLines(after));
  const show = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t !== " ") for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) show[k] = true;
  });
  const width = String(ops.length ? Math.max(...ops.map((o) => o.an || o.bn || 0)) : 1).length;
  const avail = Math.max(20, columns() - width - 12);
  const clip = (t) => (t.length > avail ? t.slice(0, avail - 1) + "…" : t);
  const out = [];
  let skipped = false, printed = 0, added = 0, removed = 0;
  ops.forEach((o, i) => {
    if (o.t === "+") added++;
    if (o.t === "-") removed++;
    if (!show[i]) return void (skipped = true);
    if (printed >= maxLines) return;
    if (skipped && out.length) out.push(c.dim("…"));
    skipped = false;
    printed++;
    const num = String(o.t === "-" ? o.an : o.bn).padStart(width);
    const text = clip(o.text.replace(/\t/g, "  "));
    if (o.t === "-") out.push(c.red(`${num} − ${text}`));
    else if (o.t === "+") out.push(c.green(`${num} + ${text}`));
    else out.push(c.dim(`${num}   ${text}`));
  });
  const hidden = ops.filter((o, i) => show[i]).length - printed;
  if (hidden > 0) out.push(c.dim(`… ${hidden} more lines`));
  return { lines: out, added, removed };
}

// ---------- the header and the status rule ----------
// " y.  yAI Code  ·  ~/projects/shop  ·  qwen-3.8-27b", a rule, then quiet details.
function banner({ version, cwd, model, user, details = [] }) {
  const sep = c.dim("  ·  ");
  print("");
  print(` ${MARK()}  ${c.bold(c.ink("yAI Code"))}${sep}${c.ink(cwd)}${sep}${c.ink(model)}`);
  print(c.dim(" " + "─".repeat(Math.min(columns() - 2, 64))));
  print(c.dim(` v${version} · signed in as ${user} · /help for commands`));
  for (const d of details) print(c.dim(" " + d));
}
// The line above the prompt: a rule with the mode on the right ("──────── ask · ⇧⇥ mode").
function rule(label) {
  const width = Math.min(columns() - 1, 120);
  const tail = ` ${label}`;
  return c.dim(" " + "─".repeat(Math.max(4, width - stripAnsi(tail).length - 1))) + tail;
}

// Kept for anything that still draws a framed block.
function box(lines) {
  for (const l of lines) print(" " + l);
}

// Called at each new request so the first line isn't preceded by a stray blank line.
function resetSections() {
  last = "";
}

module.exports = { resetSections, c, print, spinner, markdownWriter, toolHeader, toolResult, note, renderDiff, box, banner, rule, MARK, rlOutput, stripAnsi, columns, middle };
