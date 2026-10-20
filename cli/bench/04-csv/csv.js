// Turns CSV text into rows (arrays of strings).
// It should follow the usual CSV rules: fields in double quotes can contain commas, line breaks
// and "" (an escaped quote); lines end in \n or \r\n; a trailing line break doesn't add an empty row.

function parseCSV(text) {
  return text.split("\n").map((line) => line.split(","));
}

// Rows -> array of objects keyed by the first row (the header).
function toObjects(rows) {
  const [header, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

module.exports = { parseCSV, toObjects };
