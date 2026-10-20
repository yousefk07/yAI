const test = require("node:test");
const assert = require("node:assert/strict");
const { retry } = require("./retry");

// Fails `times` times, then returns "ok".
const flaky = (times) => {
  let calls = 0;
  const fn = async (attempt) => {
    calls++;
    if (calls <= times) throw new Error(`fail ${attempt}`);
    return "ok";
  };
  fn.calls = () => calls;
  return fn;
};

test("returns straight away when the first try works", async () => {
  const fn = flaky(0);
  assert.equal(await retry(fn, { delayMs: 1 }), "ok");
  assert.equal(fn.calls(), 1);
});

test("retries until it works", async () => {
  const fn = flaky(2);
  assert.equal(await retry(fn, { retries: 3, delayMs: 1 }), "ok");
  assert.equal(fn.calls(), 3);
});

test("rejects with the last error after the last retry", async () => {
  const fn = flaky(10);
  await assert.rejects(retry(fn, { retries: 2, delayMs: 1 }), /fail 3/);
  assert.equal(fn.calls(), 3);
});

test("passes the attempt number and calls onRetry", async () => {
  const seen = [];
  await retry(flaky(2), { delayMs: 1, onRetry: (err, attempt) => seen.push([err.message, attempt]) });
  assert.deepEqual(seen, [["fail 1", 1], ["fail 2", 2]]);
});

test("retryIf can stop retrying", async () => {
  const fn = flaky(10);
  await assert.rejects(retry(fn, { delayMs: 1, retryIf: () => false }), /fail 1/);
  assert.equal(fn.calls(), 1);
});

test("waits longer each time", async () => {
  const fn = flaky(3);
  const started = Date.now();
  await retry(fn, { retries: 3, delayMs: 20, factor: 2 }); // 20 + 40 + 80 = 140 ms
  const took = Date.now() - started;
  assert.ok(took >= 130, `took ${took} ms, expected about 140`);
  assert.ok(took < 600, `took ${took} ms, expected about 140`);
});

test("retries: 0 means a single try", async () => {
  const fn = flaky(1);
  await assert.rejects(retry(fn, { retries: 0, delayMs: 1 }), /fail 1/);
  assert.equal(fn.calls(), 1);
});
