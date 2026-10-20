// Small text helpers. Three of them have bugs; the tests in text.test.js say what they should do.

// "Hello, World!" -> "hello-world": lower case, letters and digits only, words joined by single dashes.
function slugify(str) {
  return str.toLowerCase().replace(/ /g, "-");
}

// Shortens text to at most `max` characters, counting the "..." it adds. Short text is left alone.
function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

// Number of words, ignoring extra spaces, tabs and new lines.
function countWords(str) {
  return str.split(" ").length;
}

// "hello world" -> "Hello World"
function titleCase(str) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = { slugify, truncate, countWords, titleCase };
