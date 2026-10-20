const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCSV, toObjects } = require("./csv");

test("simple rows", () => {
  assert.deepEqual(parseCSV("a,b,c\n1,2,3"), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("a trailing line break doesn't add a row", () => {
  assert.deepEqual(parseCSV("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("Windows line endings", () => {
  assert.deepEqual(parseCSV("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("quoted fields can contain commas", () => {
  assert.deepEqual(parseCSV('name,city\n"Kamel, Yousef",Waterloo'), [["name", "city"], ["Kamel, Yousef", "Waterloo"]]);
});

test("escaped quotes inside a quoted field", () => {
  assert.deepEqual(parseCSV('quote\n"She said ""hi"""'), [["quote"], ['She said "hi"']]);
});

test("quoted fields can contain line breaks", () => {
  assert.deepEqual(parseCSV('note,n\n"line one\nline two",2'), [["note", "n"], ["line one\nline two", "2"]]);
});

test("empty fields are kept", () => {
  assert.deepEqual(parseCSV("a,,c\n,,"), [["a", "", "c"], ["", "", ""]]);
});

test("toObjects uses the header row", () => {
  assert.deepEqual(toObjects(parseCSV("name,qty\npen,4\n")), [{ name: "pen", qty: "4" }]);
});
