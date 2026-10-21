'use strict';

// Harness: runs the inline <script> from calculator.html against a stub DOM
// so the UI's own re-implemented operations can be exercised without a browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'calculator.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.strictEqual(scripts.length, 1, 'expected exactly one inline <script>');

// --- minimal DOM stub ---
const display = { value: '0' };
const listeners = { button: [], document: [] };

function makeButton(attrs) {
  const btn = {
    dataset: attrs,
    addEventListener(type, fn) {
      listeners.button.push({ btn, type, fn });
    },
  };
  return btn;
}

const buttons = [...html.matchAll(/<button([^>]*)>/g)].map((m) => {
  const attrs = {};
  for (const a of m[1].matchAll(/data-([a-z]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return makeButton(attrs);
});

const documentStub = {
  getElementById: (id) => (id === 'display' ? display : null),
  // Honour the attribute selector, e.g. 'button[data-digit]'.
  querySelectorAll: (sel) => {
    const m = /^button\[data-([a-z]+)\]$/.exec(sel);
    if (!m) return [];
    return buttons.filter((b) => Object.prototype.hasOwnProperty.call(b.dataset, m[1]));
  },
  addEventListener: (type, fn) => listeners.document.push({ type, fn }),
};

// --- run the page script ---
vm.runInNewContext(scripts[0], { document: documentStub, console });

function click(attrs) {
  const key = Object.keys(attrs)[0];
  const hit = listeners.button.filter((l) => l.btn.dataset[key] === attrs[key]);
  assert.ok(hit.length > 0, 'no handler for ' + JSON.stringify(attrs));
  hit[0].fn();
}

function press(keys) {
  for (const k of keys) {
    if (k >= '0' && k <= '9') click({ digit: k });
    else if (k === '.') click({ action: 'decimal' });
    else if (k === '=') click({ action: 'equals' });
    else if (k === 'C') click({ action: 'clear' });
    else click({ op: k });
  }
  return display.value;
}

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

test('display starts at 0', () => {
  press(['C']);
  assert.strictEqual(display.value, '0');
});

test('2 + 3 = 5', () => {
  press(['C', '2', '+', '3', '=']);
  assert.strictEqual(display.value, '5');
});

test('10 - 4 = 6', () => {
  press(['C', '1', '0', '-', '4', '=']);
  assert.strictEqual(display.value, '6');
});

test('3 × 7 = 21', () => {
  press(['C', '3', '×', '7', '=']);
  assert.strictEqual(display.value, '21');
});

test('20 ÷ 5 = 4', () => {
  press(['C', '2', '0', '÷', '5', '=']);
  assert.strictEqual(display.value, '4');
});

test('1 ÷ 0 shows Error', () => {
  press(['C', '1', '÷', '0', '=']);
  assert.strictEqual(display.value, 'Error');
});

test('chained 2 + 3 + 4 = 9', () => {
  press(['C', '2', '+', '3', '+', '4', '=']);
  assert.strictEqual(display.value, '9');
});

test('decimal 1.5 + 2.25 = 3.75', () => {
  press(['C', '1', '.', '5', '+', '2', '.', '2', '5', '=']);
  assert.strictEqual(display.value, '3.75');
});

test('C resets after an operation', () => {
  press(['C', '9', '×', '9', '=']);
  assert.strictEqual(display.value, '81');
  press(['C']);
  assert.strictEqual(display.value, '0');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);