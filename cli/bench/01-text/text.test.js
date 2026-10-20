const test = require("node:test");
const assert = require("node:assert/strict");
const { slugify, truncate, countWords, titleCase } = require("./text");

test("slugify drops punctuation", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
});

test("slugify collapses spaces and trims dashes", () => {
  assert.equal(slugify("  Many   spaces here  "), "many-spaces-here");
  assert.equal(slugify("Rock & Roll -- 2026"), "rock-roll-2026");
});

test("truncate counts the ellipsis in the length", () => {
  assert.equal(truncate("abcdefghij", 6), "abc...");
  assert.equal(truncate("abcdefghij", 6).length, 6);
});

test("truncate leaves short text alone", () => {
  assert.equal(truncate("abc", 6), "abc");
  assert.equal(truncate("abcdef", 6), "abcdef");
});

test("countWords ignores extra whitespace", () => {
  assert.equal(countWords("  one  two\tthree\nfour "), 4);
});

test("countWords of an empty or blank string is 0", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   "), 0);
});

test("titleCase still works", () => {
  assert.equal(titleCase("hello world"), "Hello World");
});
