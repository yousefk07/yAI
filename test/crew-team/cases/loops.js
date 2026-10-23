"use strict";
// lib/loops.js: is a reply (or a written file) stuck repeating itself?
const assert = require("assert");
const path = require("path");
const { suite, REPO } = require("../lib/harness");
const L = require(path.join(REPO, "lib", "loops.js"));

const counting = (n) => { let s = "const LEAVES = ["; for (let i = 0; s.length < n; i++) s += `"oak_leaves_${1800 + i}", "spruce_leaves_${1800 + i}", `; return s; };
const sameLines = (n) => Array.from({ length: n }, (_, i) => `  { item: "recipe_${i % 15}", needs: ["stick", "plank"], makes: 4 },`).join("\n");
const realCode = () => { let s = ""; for (let i = 0; s.length < 40000; i++) s += `function update${i}(dt) {\n  const v${i} = state.items[${i}] * dt + Math.sin(${i} * 0.37);\n  if (v${i} > limit${i % 7}) state.flags.push("over_${i}");\n  return render${i % 13}(v${i}, ctx, ${i * 17 % 101});\n}\n`; return s; };
const level = () => { let s = "const LEVEL = ["; let x = 13; for (let i = 0; s.length < 30000; i++) { x = (x * 7919 + 104729) % 100003; s += `{type:"block",x:${x % 4000},y:${(x >> 3) % 600},w:${32 + (x % 5) * 16},h:32},`; } return s + "];"; };
const svg = () => { let s = "<svg>"; let x = 5; for (let i = 0; s.length < 30000; i++) { x = (x * 1103 + 12345) % 9973; s += `<path d="M${x % 300} ${x % 211} L${(x * 3) % 300} ${(x * 7) % 211} Q${x % 97} ${x % 89} ${x % 53} ${x % 41}" fill="#${(x * 4567).toString(16).slice(0, 6).padStart(6, "0")}"/>\n`; } return s + "</svg>"; };
const prose = () => { const w = "the quick brown fox jumps over lazy dogs while players build houses craft tools explore caves fight mobs and trade with villagers in a blocky world".split(" "); let s = "", x = 7; const rnd = () => { x = (x + 0x6d2b79f5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; while (s.length < 30000) { s += w[Math.floor(rnd() * w.length)] + (rnd() < 0.08 ? ".\n" : " "); } return s; };

suite(__filename, [
  { name: "a counting-up loop is caught past 12,000 characters", fn: () => { assert.ok(L.looping(counting(14000)), "not caught"); } },
  { name: "under 10,000 characters nothing is called a loop", fn: () => { assert.strictEqual(L.looping(counting(9000)), null); } },
  { name: "the same lines over and over are caught", fn: () => { const r = L.looping(sameLines(400)); assert.ok(r); assert.match(r.why, /lines/); } },
  { name: "real code is not a loop", fn: () => { assert.strictEqual(L.looping(realCode()), null); } },
  { name: "a hand-placed level (numbers that don't count on) is not a loop", fn: () => { assert.strictEqual(L.looping(level()), null); } },
  { name: "an SVG is not a loop", fn: () => { assert.strictEqual(L.looping(svg()), null); } },
  { name: "prose is not a loop", fn: () => { assert.strictEqual(L.looping(prose()), null); } },
  { name: "lines written with \\n escapes (a JSON string) count as lines", fn: () => { const t = JSON.stringify(sameLines(400)); assert.ok(L.looping(t)); } },
  { name: "a file written in a loop is flagged by fileRepeats", fn: () => { const r = L.fileRepeats(sameLines(300)); assert.ok(r && r.copies > 50 && r.times >= 5); } },
  { name: "a normal file is not flagged by fileRepeats", fn: () => { assert.strictEqual(L.fileRepeats(realCode()), null); } },
  { name: "short repeated lines (closing braces) don't count", fn: () => { assert.strictEqual(L.fileRepeats(Array.from({ length: 400 }, (_, i) => (i % 2 ? "  }" : `  x${i}();`)).join("\n")), null); } },
  { name: "the sample says what it was writing", fn: () => { const r = L.looping(counting(20000)); assert.ok(/leaves/.test(r.sample)); } },
  { name: "an empty or odd input doesn't throw", fn: () => { for (const x of ["", null, undefined, 42, "\n".repeat(20000)]) { L.looping(String(x ?? "")); L.fileRepeats(String(x ?? "")); } } },
]);
