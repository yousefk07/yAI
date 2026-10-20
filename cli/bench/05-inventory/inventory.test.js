// Tests for store.js and report.js. Some of these need new features in both files.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Store } = require("./store");
const { stockValue, lowStock } = require("./report");

const make = () =>
  new Store([
    { name: "pen", qty: 40, price: 1.25 },
    { name: "notebook", qty: 3, price: 4.5 },
    { name: "backpack", qty: 1, price: 39.99 },
  ]);

test("stock value", () => {
  assert.equal(stockValue(make()), 103.49);
});

test("selling lowers the quantity", () => {
  const s = make();
  assert.equal(s.sell("pen", 5), 35);
});

test("selling an unknown item throws", () => {
  assert.throws(() => make().sell("stapler", 1), /unknown item: stapler/);
});

test("selling more than is in stock throws and changes nothing", () => {
  const s = make();
  assert.throws(() => s.sell("notebook", 4), /not enough notebook/);
  assert.equal(s.list().find((i) => i.name === "notebook").qty, 3);
});

test("restock adds units and returns the new quantity", () => {
  const s = make();
  assert.equal(s.restock("backpack", 4), 5);
  assert.throws(() => s.restock("stapler", 1), /unknown item: stapler/);
});

test("quantities must be positive whole numbers", () => {
  const s = make();
  assert.throws(() => s.sell("pen", 0), RangeError);
  assert.throws(() => s.restock("pen", -2), RangeError);
  assert.throws(() => s.restock("pen", 1.5), RangeError);
});

test("lowStock lists items at or below the threshold, lowest first", () => {
  assert.deepEqual(lowStock(make(), 3), ["backpack", "notebook"]);
  assert.deepEqual(lowStock(make(), 0), []);
});
