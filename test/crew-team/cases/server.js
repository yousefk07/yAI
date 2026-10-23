"use strict";
// The site's side (lib/handlers.js): a native tool call turned back into yAI's own block, whole or cut off
const assert = require("assert");
const path = require("path");
const { suite, REPO } = require("../lib/harness");
const { toolBlock, bodyFor } = require(path.join(REPO, "lib", "handlers.js"));

const content = Array.from({ length: 40 }, (_, i) => `const line${i} = "value ${i}";\tdone();`).join("\n");

// thinking (bodyFor): what DeepSeek and the other hosts are sent
const DS = { host: { deepseek: true, native: true, name: "DeepSeek" } }, ZAI = { host: { zai: true, native: true } }, GEM = { host: { gemini: true } };
const NATIVE = { tools: [{ name: "read_file", description: "read", params: ["path"] }], toolFormat: "" };
const history = () => ({ model: "x", stream: true, chat_template_kwargs: { enable_thinking: false }, messages: [
  { role: "system", content: "sys" },
  { role: "user", content: "go" },
  { role: "assistant", content: 'Reading.\n<tool name="read_file">\n<path>\na.js\n</path>\n</tool>', reasoning: "I should read a.js first." },
  { role: "user", content: '<tool_result name="read_file">\nhello\n</tool_result>' },
  { role: "assistant", content: "An old step with no reasoning kept." },
  { role: "user", content: "next" },
] });

suite(__filename, [
  { name: "thinking on DeepSeek with tools: enabled, its effort, and every step's reasoning sent back", fn: () => {
    const b = bodyFor(DS, { ...history(), think: "low" }, NATIVE);
    assert.deepStrictEqual(b.thinking, { type: "enabled" });
    assert.strictEqual(b.reasoning_effort, "low");
    assert.ok(!("think" in b));
    const asst = b.messages.filter((m) => m.role === "assistant");
    assert.strictEqual(asst[0].reasoning_content, "I should read a.js first.");
    assert.ok(asst[0].tool_calls?.length, "the step is still a native tool call");
    assert.strictEqual(asst[1].reasoning_content, "", "a step with none gets an empty one");
    assert.ok(b.messages.every((m) => !("reasoning" in m)), "yAI's own field never goes out");
  } },
  { name: "thinking not asked for: disabled, and no reasoning goes out", fn: () => {
    const b = bodyFor(DS, history(), NATIVE);
    assert.deepStrictEqual(b.thinking, { type: "disabled" });
    assert.ok(!("reasoning_effort" in b));
    assert.ok(b.messages.every((m) => !("reasoning" in m) && !("reasoning_content" in m)));
  } },
  { name: "thinking with no tools (the planning calls): enabled, reasoning not sent back", fn: () => {
    const b = bodyFor(DS, { ...history(), think: "high" }, null);
    assert.deepStrictEqual(b.thinking, { type: "enabled" });
    assert.strictEqual(b.reasoning_effort, "high");
    assert.ok(b.messages.every((m) => !("reasoning" in m) && !("reasoning_content" in m)));
  } },
  { name: "other hosts never get thinking or the reasoning field", fn: () => {
    for (const h of [ZAI, GEM]) {
      const b = bodyFor(h, { ...history(), think: "low" }, h === ZAI ? NATIVE : null);
      assert.ok(!("think" in b) && b.reasoning_effort === undefined);
      if (h === ZAI) assert.deepStrictEqual(b.thinking, { type: "disabled" });
      assert.ok(b.messages.every((m) => !("reasoning" in m) && !("reasoning_content" in m)), JSON.stringify(b.messages));
    }
  } },
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
