const test = require("node:test");
const assert = require("node:assert/strict");
const { addBusinessDays, businessDaysBetween } = require("./days");

// October 2026: the 16th is a Friday, the 17th and 18th are the weekend.

test("adding within a week", () => {
  assert.equal(addBusinessDays("2026-10-12", 3), "2026-10-15");
});

test("adding skips Saturday and Sunday", () => {
  assert.equal(addBusinessDays("2026-10-16", 1), "2026-10-19");
  assert.equal(addBusinessDays("2026-10-15", 5), "2026-10-22");
});

test("starting on a weekend counts from Monday", () => {
  assert.equal(addBusinessDays("2026-10-17", 1), "2026-10-19");
  assert.equal(addBusinessDays("2026-10-18", 2), "2026-10-20");
});

test("adding skips holidays", () => {
  // Thanksgiving Monday, 2026-10-12
  assert.equal(addBusinessDays("2026-10-09", 1, ["2026-10-12"]), "2026-10-13");
});

test("adding across months and years", () => {
  assert.equal(addBusinessDays("2026-12-31", 1, ["2027-01-01"]), "2027-01-04");
});

test("counting between two dates skips weekends", () => {
  assert.equal(businessDaysBetween("2026-10-16", "2026-10-19"), 1);
  assert.equal(businessDaysBetween("2026-10-12", "2026-10-23"), 9);
});

test("counting skips holidays", () => {
  assert.equal(businessDaysBetween("2026-10-09", "2026-10-16", ["2026-10-12"]), 4);
});

test("counting the same day is 0", () => {
  assert.equal(businessDaysBetween("2026-10-14", "2026-10-14"), 0);
});
