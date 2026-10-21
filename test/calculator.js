'use strict';

/**
 * A simple calculator that records every operation in a history list.
 */
class Calculator {
  constructor() {
    this.history = [];
  }

  /**
   * Record an operation in the history.
   * @param {string} op
   * @param {number} a
   * @param {number} b
   * @param {number} result
   * @returns {number} the result
   */
  _record(op, a, b, result) {
    this.history.push({ op, a, b, result });
    return result;
  }

  add(a, b) {
    return this._record('add', a, b, a + b);
  }

  subtract(a, b) {
    return this._record('subtract', a, b, a - b);
  }

  multiply(a, b) {
    return this._record('multiply', a, b, a * b);
  }

  // NOTE: these four operations are duplicated inline in test/calculator.html
  // (which must stay self-contained); keep the divide-by-zero guard in sync.
  divide(a, b) {
    if (b === 0) {
      throw new Error('Division by zero');
    }
    return this._record('divide', a, b, a / b);
  }

  clearHistory() {
    this.history = [];
  }
}

module.exports = Calculator;