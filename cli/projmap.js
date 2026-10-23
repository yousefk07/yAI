// The project map (2026-10-22): what each file of a /team project defines and uses, and the names that don't line up,
// worked out by yAI itself (no model, so it costs nothing). The roles that must see the whole project (merger,
// integration, reviewer, fixer, spec) start from it instead of reading every file whole: on a ~5,000-line Minecraft
// clone they kept losing the first files while reading the last, and were stopped before doing their job.
//
// It reads plain JavaScript and HTML the way the team writes them: dotted globals (MC.world.getBlock = …, or the keys
// of MC.world = { … }), top-level functions, classes and variables, element ids, and <script> tags. It is a heuristic,
// so the mismatches are "possible": each agent is told to check one before acting on it.
const fs = require("fs");
const path = require("path");

const JS = /\.(m?js|cjs|jsx|ts|tsx)$/i, HTML = /\.html?$/i;
const BUILTIN = new Set(["window", "document", "console", "Math", "JSON", "Object", "Array", "Number", "String", "Promise", "Date", "localStorage", "sessionStorage", "navigator", "location", "performance", "this", "module", "exports", "require", "process", "Symbol", "Reflect", "Intl", "Error", "Map", "Set", "WeakMap", "URL", "THREE", "e", "event", "self", "globalThis"]);

// What one JavaScript file defines and uses.
function readJs(text) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")); // /* … */ and JSDoc aren't code
  const lines = text.split(/\r?\n/);
  const defs = [], uses = [], ids = [], calls = [];
  // a file's own names (var Input = …, function build …) and the members of its private object literals, so that
  // `MC.Input = Input` publishes Input's members (2026-10-22: a Minecraft clone built every module as a private
  // object published this way, and the map called all of their members missing)
  const declared = new Set(), localObjs = new Map();
  for (const m of text.matchAll(/\b(?:var|let|const|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  let obj = null; // the object literal being read: { name, indent, local }
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "");
    const at = i + 1;
    const indent = raw.match(/^\s*/)[0].replace(/\t/g, "    ").length;
    let m;
    if (obj && indent <= obj.indent && /^\s*}/.test(raw)) obj = null;
    // MC.world.getBlock = …, window.MC = … (a capitalised root: player.position.x = … is a local's field, not a name the
    // files share). An object literal opened at the end of the line is read key by key, so its members are known
    // ("closed"); anything else (= {}, = new World(), = { a: 1 } on one line) may get members later.
    const opens = (rhs) => /^\{\s*$/.test(rhs.trim());
    if ((m = /^\s*(?:window\.)?([A-Z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*=(?!=)\s*(.*)$/.exec(line)) && !BUILTIN.has(m[1].split(".")[0])) {
      const alias = (/^([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(m[2].trim()) || [])[1];
      const parts = m[1].split(".");
      // Raycaster.cast = function …: a member added to a private object after it was made
      if (parts.length === 2 && localObjs.has(parts[0])) localObjs.get(parts[0]).push({ key: parts[1], line: at });
      else defs.push({ name: m[1], line: at, closed: opens(m[2]), alias, member: new RegExp(`^${m[1].replace(/[.$]/g, "\\$&")}\\s*\\|\\|`).test(m[2].trim()) || undefined });
      if (opens(m[2])) obj = { name: m[1], indent };
    } else if ((m = /^\s*window\.([A-Za-z_$][\w$]*)\s*=(?!=)\s*(.*)$/.exec(line))) {
      defs.push({ name: m[1], line: at, closed: opens(m[2]) });
      if (opens(m[2])) obj = { name: m[1], indent };
    } else if ((m = /^\s{0,4}(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(line)) && indent <= 4) {
      defs.push({ name: m[1], line: at, closed: opens(m[2]) && indent === 0, local: indent > 0 });
      if (opens(m[2])) { obj = { name: m[1], indent, local: indent > 0 }; if (indent > 0) localObjs.set(m[1], []); }
    }
    // a key of the object literal being read: getBlock: function, getBlock(x) {, VERSION: 3
    if (obj && indent > obj.indent && indent <= obj.indent + 4 && (m = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::|\([^)]*\)\s*\{)/.exec(line)) && !/^(if|for|while|switch|return|case)$/.test(m[1])) {
      if (obj.local) localObjs.get(obj.name).push({ key: m[1], line: at });
      else defs.push({ name: `${obj.name}.${m[1]}`, line: at, closed: false });
    }
    // this.inv = … inside one of the object's methods: a member too
    if (obj && indent >= obj.indent + 4) for (const t of line.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
      if (obj.local) localObjs.get(obj.name).push({ key: t[1], line: at });
      else defs.push({ name: `${obj.name}.${t[1]}`, line: at, closed: false });
    }
    if ((m = /^\s{0,4}(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line))) defs.push({ name: m[1], line: at, closed: false, local: indent > 0 });
    if ((m = /^\s{0,4}(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) defs.push({ name: m[1], line: at, closed: false, local: indent > 0 });
    // what it uses: dotted names (MC.world.getBlock), and element ids
    for (const u of line.matchAll(/(?<![\w$.'"`])([A-Z][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/g)) if (!BUILTIN.has(u[1].split(".")[0])) uses.push({ name: u[1], line: at });
    // lowercase dotted names (game.update) count only when the root is a global some file defines (window.game = …)
    for (const u of line.matchAll(/(?<![\w$.'"`])([a-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/g)) if (!BUILTIN.has(u[1].split(".")[0])) uses.push({ name: u[1], line: at, lower: true });
    // plain calls (drawHUD()), checked against the functions other files define
    for (const u of line.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) calls.push({ name: u[1], line: at });
    for (const u of line.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)|querySelector(?:All)?\(\s*['"]#([\w-]+)['"]/g)) ids.push({ id: u[1] || u[2], line: at });
  });
  // MC.Input = Input: the published name gets the private object's members, and its own members are now known
  for (const d of defs.slice()) {
    const members = d.alias && localObjs.get(d.alias);
    if (!members) continue;
    d.closed = true;
    for (const x of members) defs.push({ name: `${d.name}.${x.key}`, line: x.line, closed: false, member: true });
  }
  return { defs, uses, ids, calls, declared, lines: lines.length, module: /^\s*(import|export)\s/m.test(text) };
}

// What one HTML page has: element ids and the scripts it loads, in order.
function readHtml(text) {
  const ids = new Set([...text.matchAll(/\sid\s*=\s*["']([\w-]+)["']/g)].map((m) => m[1]));
  const scripts = [...text.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  return { ids, scripts, lines: text.split(/\r?\n/).length };
}

// The map for `files` (paths relative to root): { text, mismatches }. `text` is ready to put in a brief.
function projectMap(root, files) {
  const read = [];
  for (const f of [...new Set(files)].sort()) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), "utf8"); } catch { continue; }
    if (text.length > 400000) continue;
    if (JS.test(f)) read.push({ f, kind: "js", ...readJs(text) });
    else if (HTML.test(f)) read.push({ f, kind: "html", ...readHtml(text) });
    else read.push({ f, kind: "other", lines: text.split(/\r?\n/).length });
  }
  const js = read.filter((r) => r.kind === "js"), html = read.filter((r) => r.kind === "html");
  // every name defined anywhere (globals only: a function's own locals don't count across files)
  const defined = new Map();
  for (const r of js) for (const d of r.defs) if (!d.local) (defined.get(d.name) || defined.set(d.name, []).get(d.name)).push({ f: r.f, ...d });
  const roots = new Set([...defined.keys()].filter((n) => n.includes(".")).map((n) => n.split(".")[0]).concat([...defined.keys()].filter((n) => !n.includes("."))));
  // is `name` defined? Exactly, or under a parent we can't see inside (MC.world = new World(): its members are unknown).
  // A parent whose members the files assign one by one (window.MC = window.MC || {}, then MC.world = …) counts as seen
  // inside: its members are the ones assigned.
  const filled = new Set([...defined.keys()].filter((n) => n.includes(".")).map((n) => n.split(".").slice(0, -1).join(".")));
  const known = (name) => {
    if (defined.has(name)) return true;
    const parts = name.split(".");
    for (let i = parts.length - 1; i >= 1; i--) {
      const parent = parts.slice(0, i).join(".");
      const d = defined.get(parent);
      if (d) return !filled.has(parent) && d.some((x) => !x.closed);
    }
    return false;
  };
  // the part of a used name that's missing: MC.world.getBlok when MC.world is a known object literal, or the first
  // missing parent (MC.wrold.getBlock → MC.wrold)
  const missing = (name) => {
    if (known(name)) return null;
    const parent = name.split(".").slice(0, -1).join(".");
    if (!parent || defined.has(parent)) return name;
    return missing(parent) || name;
  };
  const mismatches = [];
  for (const r of js) {
    const seen = new Set();
    for (const u of r.uses) {
      const root = u.name.split(".")[0];
      if (u.lower && !defined.has(root)) continue; // a local's field (player.x), not a shared name
      if (!roots.has(root)) {
        const near = root.length >= 3 && /^[A-Z]/.test(root) && !r.declared.has(root) && [...roots].find((x) => x !== root && (x.toLowerCase() === root.toLowerCase() || (x.length >= 4 && dist(x.toLowerCase(), root.toLowerCase()) <= 1)));
        if (near && !seen.has(root)) { seen.add(root); mismatches.push(`\`${r.f}:${u.line}\` uses \`${root}\`, which no file defines (did it mean \`${near}\`?)`); }
        continue;
      }
      if (r.declared.has(root) && !defined.has(root)) continue; // the file's own local (Input inside input.js)
      const name = missing(u.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const alt = similar(name, defined);
      mismatches.push(`\`${r.f}:${u.line}\` uses \`${name}\`, which no file defines${alt ? ` (did it mean \`${alt}\`?)` : ""}`);
    }
  }
  // misspelt calls: drawHUD() when another file defines drawHud (only when a defined name is that close)
  const fnNames = [...defined.keys()].filter((n) => !n.includes("."));
  for (const r of js) {
    const seen = new Set();
    for (const u of r.calls) {
      if (seen.has(u.name) || defined.has(u.name) || r.declared.has(u.name) || BUILTIN.has(u.name) || u.name.length < 4 || /^(if|for|while|switch|return|function|catch|typeof|new|await|super|import)$/.test(u.name)) continue;
      const near = fnNames.find((x) => x.toLowerCase() === u.name.toLowerCase() || (x.length >= 5 && dist(x, u.name) === 1));
      if (near) { seen.add(u.name); mismatches.push(`\`${r.f}:${u.line}\` calls \`${u.name}()\`, which no file defines (did it mean \`${near}\`?)`); }
    }
  }
  for (const [name, list] of defined) {
    // a member of a published object that another file sets (MC.Furnace.list = saved.list when loading) isn't a
    // second definition: only two files each defining it themselves is
    const files = [...new Set(list.filter((x) => !x.member).map((x) => x.f))];
    if (files.length > 1 && !list.some((x) => x.member) && name.includes(".")) mismatches.push(`\`${name}\` is defined in ${files.length} files: ${list.map((x) => `\`${x.f}:${x.line}\``).join(", ")}`);
  }
  const allIds = new Set(html.flatMap((h) => [...h.ids]));
  const jsText = js.map((r) => { try { return fs.readFileSync(path.join(root, r.f), "utf8").replace(/getElementById\([^)]*\)|querySelector(All)?\([^)]*\)/g, ""); } catch { return ""; } }).join("\n");
  if (html.length) for (const r of js) for (const u of r.ids) if (!allIds.has(u.id) && !new RegExp(`['"\`]${u.id}['"\`]`).test(jsText)) mismatches.push(`\`${r.f}:${u.line}\` looks up #${u.id}, which no HTML file has`);
  for (const h of html) for (const s of h.scripts) if (!/^(https?:)?\/\//.test(s) && !fs.existsSync(path.join(root, path.dirname(h.f), s))) mismatches.push(`\`${h.f}\` loads ${s}, which doesn't exist`);
  // the map itself: each file's size and what it defines
  const lines = read.map((r) => {
    if (r.kind === "html") return `- ${r.f} (${r.lines} lines): ${r.ids.size} element ids${r.scripts.length ? `; loads ${r.scripts.join(", ")} in that order` : ""}`;
    if (r.kind !== "js") return `- ${r.f} (${r.lines} lines)`;
    const first = new Map();
    for (const d of r.defs) if (!d.local && !first.has(d.name)) first.set(d.name, d.line); // a name set again later is listed once
    const names = [...first].map(([n, l]) => `${n}:${l}`);
    return `- ${r.f} (${r.lines} lines)${names.length ? `: ${names.slice(0, 40).join(", ")}${names.length > 40 ? `, … ${names.length - 40} more` : ""}` : ""}`;
  });
  let text = lines.join("\n");
  if (text.length > 9000) text = text.slice(0, text.lastIndexOf("\n", 9000)) + "\n- … (the rest left out)";
  return { text, mismatches: mismatches.slice(0, 40), total: read.reduce((s, r) => s + r.lines, 0), modules: js.some((r) => r.module) };
}

// The closest defined name with the same parent, when it differs by a little (getBlok → getBlock)
function similar(name, defined) {
  const parent = name.split(".").slice(0, -1).join(".");
  const last = name.split(".").pop().toLowerCase();
  let best = null, bestD = 3;
  for (const n of defined.keys()) {
    if (n.split(".").slice(0, -1).join(".") !== parent || n === name) continue;
    const d = dist(last, n.split(".").pop().toLowerCase());
    if (d < bestD) { best = n; bestD = d; }
  }
  return best;
}
function dist(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}

module.exports = { projectMap };
