"use strict";
// Terminal output: colours, the spinner, Markdown rendering and diffs.

const { Writable } = require("stream");

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (open, close) => (s) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const c = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
  accent: sgr("38;5;209", 39), // the yAI orange
  code: sgr("38;5;153", 39),
  delBg: sgr("48;5;52", 49),
  addBg: sgr("48;5;22", 49),
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const columns = () => process.stdout.columns || 100;

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

// ---------- spinner ----------
const VERBS = [
  "Thinking", "Pondering", "Tinkering", "Noodling", "Brewing", "Percolating", "Conjuring", "Scampering",
  "Mulling", "Cooking", "Whirring", "Untangling", "Crafting", "Simmering", "Puzzling", "Churning",
];
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
let spin = null;

function drawSpinner() {
  if (!spin) return;
  const secs = Math.round((Date.now() - spin.start) / 1000);
  const tokens = spin.tokens ? ` · ↓ ${spin.tokens.toLocaleString()} tokens` : "";
  const line = `${c.accent(FRAMES[spin.frame++ % FRAMES.length])} ${c.accent(spin.text + "…")} ${c.dim(`(${secs}s${tokens} · esc to interrupt)`)}`;
  process.stdout.write("\r\x1b[K" + line);
}

const spinner = {
  start(text) {
    if (!process.stdout.isTTY) return;
    if (spin) return void (spin.text = text || spin.text);
    spin = { text: text || VERBS[Math.floor(Math.random() * VERBS.length)], start: Date.now(), frame: 0, tokens: 0 };
    drawSpinner();
    spin.timer = setInterval(drawSpinner, 120);
  },
  text(t) {
    if (spin) spin.text = t;
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

// Print lines above the spinner without breaking it.
function print(text = "") {
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

// Renders a streamed assistant reply: the first line gets a "●" bullet, the rest are indented.
function markdownWriter() {
  let inCode = false, first = true;
  return (line) => {
    let out;
    let m;
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      out = c.dim(line);
    } else if (inCode) out = c.code(line);
    else if ((m = line.match(/^(#{1,6})\s+(.*)/))) out = c.bold(inline(m[2]));
    else if ((m = line.match(/^(\s*)[-*+]\s+(.*)/))) out = `${m[1]}• ${inline(m[2])}`;
    else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) out = c.dim("─".repeat(Math.min(60, columns() - 4)));
    else out = inline(line);
    if (first && !line.trim()) return;
    print((first ? "● " : "  ") + out);
    first = false;
  };
}

// ---------- tool display ----------
function toolHeader(name, arg) {
  print("");
  print(`${c.green("●")} ${c.bold(name)}${arg ? `(${arg})` : ""}`);
}
function toolResult(text, { color: col } = {}) {
  const lines = String(text).split("\n");
  lines.forEach((l, i) => print(`${i === 0 ? "  ⎿  " : "     "}${col ? col(l) : c.dim(l)}`));
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
    if (skipped && out.length) out.push(c.dim("     ..."));
    skipped = false;
    printed++;
    const num = String(o.t === "+" ? o.bn : o.an).padStart(width);
    const text = clip(o.text.replace(/\t/g, "  "));
    if (o.t === "-") out.push(c.delBg(`${num} - ${text}`));
    else if (o.t === "+") out.push(c.addBg(`${num} + ${text}`));
    else out.push(c.dim(`${num}   `) + text);
  });
  const hidden = ops.filter((o, i) => show[i]).length - printed;
  if (hidden > 0) out.push(c.dim(`     … ${hidden} more lines`));
  return { lines: out, added, removed };
}

function box(lines) {
  const width = Math.min(columns() - 2, Math.max(...lines.map((l) => stripAnsi(l).length)) + 4);
  const pad = (l) => l + " ".repeat(Math.max(0, width - 4 - stripAnsi(l).length));
  print(c.accent("╭" + "─".repeat(width - 2) + "╮"));
  for (const l of lines) print(c.accent("│ ") + pad(l) + c.accent(" │"));
  print(c.accent("╰" + "─".repeat(width - 2) + "╯"));
}

module.exports = { c, print, spinner, markdownWriter, toolHeader, toolResult, renderDiff, box, rlOutput, stripAnsi, columns };
