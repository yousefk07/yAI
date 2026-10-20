const test = require("node:test");
const assert = require("node:assert/strict");
const { LRUCache } = require("./lru");

test("stores and reads values", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("missing"), undefined);
  assert.equal(c.size, 1);
});

test("evicts the least recently used key when full", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.has("a"), false);
  assert.deepEqual(c.keys(), ["b", "c"]);
});

test("get counts as using a key", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.has("b"), false);
  assert.deepEqual(c.keys(), ["a", "c"]);
});

test("updating a key refreshes it and doesn't grow the cache", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 10);
  c.set("c", 3);
  assert.equal(c.get("a"), 10);
  assert.equal(c.has("b"), false);
  assert.equal(c.size, 2);
});

test("has does not count as using a key", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.has("a");
  c.set("c", 3);
  assert.equal(c.has("a"), false);
});

test("stored falsy values are still found", () => {
  const c = new LRUCache(3);
  c.set("zero", 0);
  c.set("empty", "");
  assert.equal(c.get("zero"), 0);
  assert.equal(c.has("empty"), true);
});

test("capacity must be a positive integer", () => {
  assert.throws(() => new LRUCache(0), RangeError);
  assert.throws(() => new LRUCache(1.5), RangeError);
});
