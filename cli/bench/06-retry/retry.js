// Calls an async function again when it fails, waiting longer each time.
//
// retry(fn, options) calls fn(attempt) with attempt = 1, 2, 3...
//   retries  how many extra tries after the first one (default 3)
//   delayMs  wait before the first retry (default 100)
//   factor   each wait is this many times the last one (default 2)
//   onRetry  optional; called as onRetry(error, attempt) before each retry
//   retryIf  optional; return false for an error that shouldn't be retried
// It resolves with fn's result, or rejects with the last error.
//
// Not written yet. Make retry.test.js pass.

async function retry(fn, options = {}) {
  throw new Error("not implemented");
}

module.exports = { retry };
