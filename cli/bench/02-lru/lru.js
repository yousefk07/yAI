// A least-recently-used cache: it holds at most `capacity` entries, and when it's full,
// adding a new key removes the entry that was used longest ago. Reading or updating a key counts as using it.
//
// Not written yet. Make lru.test.js pass.

class LRUCache {
  constructor(capacity) {
    throw new Error("not implemented");
  }

  // Returns the value, or undefined if the key isn't there.
  get(key) {
    throw new Error("not implemented");
  }

  // Adds or updates a key.
  set(key, value) {
    throw new Error("not implemented");
  }

  // True if the key is there (doesn't count as using it).
  has(key) {
    throw new Error("not implemented");
  }

  // Number of entries.
  get size() {
    throw new Error("not implemented");
  }

  // Keys from least to most recently used.
  keys() {
    throw new Error("not implemented");
  }
}

module.exports = { LRUCache };
