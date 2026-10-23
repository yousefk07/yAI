"use strict";
// The site's side (lib/handlers.js): a native tool call turned back into yAI's own block, whole or cut off
const assert = require("assert");
const path = require("path");
const { suite, REPO } = require("../lib/harness");
const { toolBlock } = require(path.join(REPO, "lib", "handlers.js"));

const content = Array.from({ length: 40 }, (_, i) => `const line${i} = "value ${i}";\tdone();`).join("\n");

suite(__filename, [
  { name: "a whole call becomes a closed block", fn: () => {
    const b = toolBlock({ name: "write_file", arguments: JSON.stringify({ path: "a.js", content }) });
    assert.match(b, /^<tool name="write_file">\n<path>\na\.js\n<\/path>\n<content>\n/);
    assert.ok(b.endsWith("</tool>"));
    assert.ok(b.includes('const line39 = "value 39";\tdone();'));
  } },
  { name: "arguments given as an object", fn: () => {
    const b = toolBlock({ name: "read_file", arguments: { path: "x.js" } });
    assert.match(b, /<path>\nx\.js\n<\/path>\n<\/tool>$/);
  } },
  { name: "a call cut off inside its content: the path is kept and the content left open", fn: () => {
    const raw = JSON.stringify({ path: "big.js", content }).slice(0, -30);
    const b = toolBlock({ name: "write_file", arguments: raw });
    assert.match(b, /<path>\nbig\.js\n<\/path>/);
    assert.match(b, /<content>\nconst line0 = "value 0";\tdone\(\);\n/);
    assert.ok(!b.includes("</tool>"), "left unclosed, so yAI Code sees it cut off");
  } },
  { name: "cut off in the middle of an escape: the text is still decoded", fn: () => {
    const full = JSON.stringify({ path: "u.js", content: content + "\n// \u0001 done" }); // \u0001 is written as an escape
    const raw = full.slice(0, full.indexOf("\\u0001") + 4); // ends inside it: ...\u00
    assert.match(raw, /\\u00$/);
    const b = toolBlock({ name: "write_file", arguments: raw });
    assert.ok(!/\\n/.test(b.split("<content>")[1] || ""), "no literal \\n left in the content");
    assert.ok(b.includes("const line1 = \"value 1\";"));
  } },
  { name: "cut off before any argument: still an open tag", fn: () => {
    const b = toolBlock({ name: "write_file", arguments: '{"pa' });
    assert.ok(!b.includes("</tool>"));
    assert.match(b, /<content>$/);
  } },
  { name: "empty arguments are a closed call with none", fn: () => {
    assert.strictEqual(toolBlock({ name: "list_files", arguments: "" }), '<tool name="list_files">\n\n</tool>');
  } },
]);
