// A quick check of a file right after yAI writes it (2026-10-23): a syntax error is reported in that step's result,
// so it's fixed at once instead of turning up later in a QA pass or a blank page.
//   .js .mjs .cjs   node --check (modules too: Node detects import/export)
//   .json           JSON.parse (not tsconfig/jsconfig or .vscode files, which allow comments)
//   .html .htm      each inline classic <script> compiled (not modules, JSON or templates)
// Returns "" when the file is fine or can't be checked, else a short description of the first error.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function checkJs(abs, text) {
  // a .js file with import/export goes in as a module on stdin: node --check on the file itself passes a module with a
  // syntax error (Node 24's module detection, tried 2026-10-23)
  const esm = path.extname(abs).toLowerCase() === ".js" && /^\s*(import|export)\b/m.test(text);
  const r = esm
    ? spawnSync(process.execPath, ["--input-type=module", "--check"], { input: text, encoding: "utf8", timeout: 8000, windowsHide: true })
    : spawnSync(process.execPath, ["--check", abs], { encoding: "utf8", timeout: 8000, windowsHide: true });
  if (r.status === 0 || r.error || r.signal) return "";
  // node prints:  file:line \n code \n   ^^^ \n\n SyntaxError: message
  const err = String(r.stderr || "");
  const where = (/:(\d+)\r?\n/.exec(err) || [])[1];
  const msg = (/^\s*(\w*Error: .*)$/m.exec(err) || [])[1] || err.trim().split("\n").pop();
  const code = err.split(/\r?\n/)[1] || "";
  return `${msg}${where ? ` at line ${where}` : ""}${code.trim() ? `: ${clip(code.trim(), 120)}` : ""}`;
}

function checkJson(abs, text) {
  const base = path.basename(abs).toLowerCase();
  if (/^(ts|js)config.*\.json$/.test(base) || abs.split(path.sep).includes(".vscode")) return "";
  try { JSON.parse(text.replace(/^﻿/, "")); return ""; } catch (e) {
    const pos = Number((/position (\d+)/.exec(e.message) || [])[1]);
    const line = Number.isFinite(pos) ? text.slice(0, pos).split("\n").length : 0;
    return `invalid JSON${line ? ` at line ${line}` : ""}: ${clip(e.message, 140)}`;
  }
}

function checkHtml(text) {
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1], code = m[2];
    if (/\bsrc\s*=/i.test(attrs) || !code.trim()) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1];
    if (type && !/^(text|application)\/(javascript|ecmascript)$/i.test(type)) continue; // module, json, importmap, templates
    try { new vm.Script(code); } catch (e) {
      const line = text.slice(0, m.index).split("\n").length;
      return `${e.name}: ${clip(e.message, 140)} (in the <script> starting at line ${line})`;
    }
  }
  return "";
}

module.exports = function checkFile(abs) {
  const ext = path.extname(abs).toLowerCase();
  if (![".js", ".mjs", ".cjs", ".json", ".html", ".htm"].includes(ext)) return "";
  let text;
  try { if (fs.statSync(abs).size > 3_000_000) return ""; text = fs.readFileSync(abs, "utf8"); } catch { return ""; }
  try {
    if (ext === ".json") return checkJson(abs, text);
    if (ext === ".html" || ext === ".htm") return checkHtml(text);
    return checkJs(abs, text);
  } catch { return ""; }
};
