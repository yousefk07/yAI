// Is a model's reply stuck repeating itself? (2026-10-23) Used while a reply streams, in yAI Code (cli/index.js) and on
// the site (lib/handlers.js, where native tool calls are written), and on each file yAI writes (cli/filecheck.js).
// Two signs, either is enough:
//   lines: of the last 120 lines that have some substance (12+ characters), 80% are exact copies of lines already
//          written. Code and data almost never do that; a loop does (741 copies of 15 recipe lines in a 1,049-line file).
//   squash: one huge run with no line breaks (300,000 characters of "oak_leaves_1829, spruce_leaves_1829, …"): see
//          squashed() below.
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

// Numbers count as the same (a loop often counts up: "oak_leaves_1829, oak_leaves_1830, …"). With them evened out, the
// last 8,000 characters of a loop compress to about 1% of their size; a real data table (block names, ids, hardness) to
// 5 or 6%, an SVG to 6%, code and prose to 24-40% (measured 2026-10-23). So past 12,000 characters, under 3% is a loop:
// caught at 12-16K instead of 60K (a 62,103-character loop got through under the old rule).
// But a hand-placed level (400 objects with x/y) compresses just as well, so the numbers must be predictable too: in a
// loop 70%+ of them repeat or count on from one of the 6 before (1829, 1829, 1830, …); real positions and sizes don't.
function squashed(text) {
  if (text.length < 12000) return false;
  const raw = text.slice(-8000), tail = raw.replace(/\d+/g, "#");
  if (zlib.deflateRawSync(Buffer.from(tail)).length >= tail.length * 0.03) return false;
  const nums = (raw.match(/\d+/g) || []).slice(1).map(Number);
  if (nums.length < 20) return true;
  let steady = 0;
  for (let i = 6; i < nums.length; i++) if (nums.slice(i - 6, i).some((p) => Math.abs(nums[i] - p) <= 2)) steady++;
  return steady >= (nums.length - 6) * 0.7;
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
