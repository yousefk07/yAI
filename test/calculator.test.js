'use strict';

// Minimal test runner using Node's built-in assert module. No external deps.
const assert = require('assert');
const Calculator = require('./calculator.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL: ' + name);
    console.log('      ' + (err && err.message ? err.message : String(err)));
  }
}

// --- basic arithmetic ---
test('add(2, 3) === 5', () => {
  const c = new Calculator();
  assert.strictEqual(c.add(2, 3), 5);
});

test('subtract(10, 4) === 6', () => {
  const c = new Calculator();
  assert.strictEqual(c.subtract(10, 4), 6);
});

test('multiply(3, 7) === 21', () => {
  const c = new Calculator();
  assert.strictEqual(c.multiply(3, 7), 21);
});

test('divide(20, 5) === 4', () => {
  const c = new Calculator();
  assert.strictEqual(c.divide(20, 5), 4);
});

// --- division by zero ---
test("divide(1, 0) throws 'Division by zero'", () => {
  const c = new Calculator();
  assert.throws(() => c.divide(1, 0), (err) => {
    assert.ok(err instanceof Error, 'expected an Error instance');
    assert.strictEqual(err.message, 'Division by zero');
    return true;
  });
});

// --- history ---
test('history length increments after each operation', () => {
  const c = new Calculator();
  assert.strictEqual(c.history.length, 0);
  c.add(1, 2);
  assert.strictEqual(c.history.length, 1);
  c.subtract(5, 3);
  assert.strictEqual(c.history.length, 2);
  c.multiply(2, 2);
  assert.strictEqual(c.history.length, 3);
  c.divide(8, 4);
  assert.strictEqual(c.history.length, 4);
});

test('history entries record {op, a, b, result}', () => {
  const c = new Calculator();
  c.add(2, 3);
  assert.deepStrictEqual(c.history[0], { op: 'add', a: 2, b: 3, result: 5 });
});

test('clearHistory() empties history', () => {
  const c = new Calculator();
  c.add(1, 1);
  c.multiply(3, 3);
  assert.strictEqual(c.history.length, 2);
  c.clearHistory();
  assert.strictEqual(c.history.length, 0);
  assert.deepStrictEqual(c.history, []);
});

// --- summary ---
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  process.exit(1);
}