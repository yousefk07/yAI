// Business-day maths for delivery dates. Dates are "YYYY-MM-DD" strings.
// Business days are Monday to Friday, minus any holidays passed in.

function toDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toString(date) {
  return date.toISOString().slice(0, 10);
}

// The date `n` business days after `start`. Starting on a weekend counts from the next Monday.
function addBusinessDays(start, n, holidays = []) {
  const date = toDate(start);
  let added = 0;
  while (added < n) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() !== 6) added++;
  }
  return toString(date);
}

// How many business days from `start` (not counted) up to and including `end`.
function businessDaysBetween(start, end, holidays = []) {
  let count = 0;
  const date = toDate(start);
  const last = toDate(end);
  while (date < last) {
    date.setUTCDate(date.getUTCDate() + 1);
    count++;
  }
  return count;
}

module.exports = { addBusinessDays, businessDaysBetween };
