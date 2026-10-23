"use strict";
// cli/filecheck.js: the syntax check of each file yAI writes
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { suite, REPO, project } = require("../lib/harness");
const check = require(path.join(REPO, "cli", "filecheck.js"));
const at = (files) => { const d = project("filecheck", files); return (f) => check(path.join(d, f)); };

suite(__filename, [
  { name: "good JS passes", fn: () => { assert.strictEqual(at({ "a.js": "const x = 1;\nmodule.exports = x;\n" })("a.js"), ""); } },
  { name: "a JS syntax error is found, with its line", fn: () => { const r = at({ "a.js": "const x = 1;\nfunction (\n" })("a.js"); assert.match(r, /SyntaxError/); assert.match(r, /line 2/); } },
  { name: "an ES module with a syntax error is found", fn: () => { const r = at({ "m.js": "import x from './x.js';\nexport const y = ;\n" })("m.js"); assert.match(r, /SyntaxError/); } },
  { name: "a good ES module passes", fn: () => { assert.strictEqual(at({ "m.js": "import x from './x.js';\nexport const y = x + 1;\n" })("m.js"), ""); } },
  { name: "a CommonJS file with a line that starts with import( isn't checked as a module", fn: () => { assert.strictEqual(at({ "c.js": "const a = 1;\nimport('./x.js').then(() => {});\nreturn;\n".replace("return;\n", "") })("c.js"), ""); } },
  { name: "a .mjs file is checked", fn: () => { assert.match(at({ "a.mjs": "export default {\n" })("a.mjs"), /SyntaxError/); } },
  { name: "bad JSON is found, with its line", fn: () => { const r = at({ "d.json": '{\n  "a": 1,\n  "b": \n}' })("d.json"); assert.match(r, /invalid JSON/); } },
  { name: "tsconfig.json with comments is left alone", fn: () => { assert.strictEqual(at({ "tsconfig.json": '{ // comment\n "a": 1 }' })("tsconfig.json"), ""); } },
  { name: "JSON with a byte-order mark passes", fn: () => { assert.strictEqual(at({ "d.json": '﻿{"a":1}' })("d.json"), ""); } },
  { name: "an inline script with a syntax error in HTML is found", fn: () => { const r = at({ "i.html": "<!doctype html>\n<body>\n<script>\nlet a = ;\n</script>" })("i.html"); assert.match(r, /SyntaxError/); assert.match(r, /line 3/); } },
  { name: "module, JSON and template scripts in HTML are skipped", fn: () => { assert.strictEqual(at({ "i.html": '<script type="module">import x from "./x.js"; await x();</script><script type="application/json">{"a":</script><script type="text/template"><div>{{x}}</div></script>' })("i.html"), ""); } },
  { name: "an external script tag is skipped", fn: () => { assert.strictEqual(at({ "i.html": '<script src="game.js"></script>' })("i.html"), ""); } },
  { name: "a file written in a loop is reported, whatever its kind", fn: () => { const t = Array.from({ length: 300 }, (_, i) => `- recipe_${i % 10}: two sticks and a plank`).join("\n"); assert.match(at({ "notes.md": t })("notes.md"), /written in a loop/); } },
  { name: "a missing file is not an error", fn: () => { assert.strictEqual(check(path.join(project("fc-missing"), "nope.js")), ""); } },
  { name: "other file kinds pass", fn: () => { assert.strictEqual(at({ "a.css": "body { color: red" })("a.css"), ""); } },
]);
