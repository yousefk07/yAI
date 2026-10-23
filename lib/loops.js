// Is a model's reply stuck repeating itself? (2026-10-23) Used while a reply streams, in yAI Code (cli/index.js) and on
// the site (lib/handlers.js, where native tool calls are written), and on each file yAI writes (cli/filecheck.js).
// Two signs, either is enough:
//   lines: of the last 120 lines that have some substance (12+ characters), 80% are exact copies of lines already
//          written. Code and data almost never do that; a loop does (741 copies of 15 recipe lines in a 1,049-line file).
//   squash: one huge run with no line breaks (300,000 characters of "oak_leaves_1829, spruce_leaves_1829, …"): past
//          60,000 characters, the last 20,000 compress to under 15% of their size (prose and code: 35 to 50%).
const zlib = require("zlib");

function repeatedLines(text) {
  const lines = String(text).split(/\r?\n|\\n/).map((l) => l.trim()).filter((l) => l.length >= 12);
  if (lines.length < 150) return null;
  const tail = lines.slice(-120), before = new Set(lines.slice(0, -120));
  let copies = 0;
  const seen = new Set();
  for (const l of tail) { if (before.has(l) || seen.has(l)) copies++; seen.add(l); }
  return copies >= tail.length * 0.8 ? { line: tail[tail.length - 1], copies } : null;
}

function squashed(text) {
  if (text.length < 60000) return false;
  const tail = text.slice(-20000);
  return zlib.deflateRawSync(Buffer.from(tail)).length < tail.length * 0.15;
}

// → null, or { why, sample } for the model
function looping(text) {
  const r = repeatedLines(text);
  if (r) return { why: "the same lines over and over", sample: r.line };
  if (squashed(text)) return { why: "the same words over and over", sample: text.slice(-200) };
  return null;
}

// In a written file: lines (12+ characters) that appear 5 or more times, when such copies are over 50 lines and 30% of
// the file. → null, or { copies, line, times }
function fileRepeats(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 12);
  const n = new Map();
  for (const l of lines) n.set(l, (n.get(l) || 0) + 1);
  let copies = 0, top = ["", 0];
  for (const [l, k] of n) if (k >= 5) { copies += k - 1; if (k > top[1]) top = [l, k]; }
  return copies > 50 && copies > lines.length * 0.3 ? { copies, line: top[0], times: top[1] } : null;
}

module.exports = { looping, fileRepeats };
