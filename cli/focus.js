"use strict";
// Focus packs (2026-10-22): a knowledge file yAI Code keeps in front of the model for a whole session, so it works
// as if it already knew the company or project: its people, systems, folders and standing rules. Packs live on this
// PC only, in ~/.yai/packs/<name>.md, never in the yAI repo (they hold private details).
//
//   /focus                    the packs here, and which one is on
//   /focus <name> | off       turn one on (remembered for this folder) or off
//   /<name>                   shortcut for a pack that exists, e.g. /acme
//   yai <name>                start yAI Code in the pack's own folder (its `root:`) with the pack on
//
// A pack starts with a small header, then plain Markdown:
//   ---
//   title: Acme
//   root: C:\Users\you\Desktop\Acme           (optional: where `yai <name>` starts, and where it turns on by itself)
//   auto: true                                (optional: turn on whenever yAI Code starts inside root)
//   ---

const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = path.join(os.homedir(), ".yai", "packs");

function read(name) {
  const file = path.join(DIR, `${String(name).toLowerCase().replace(/[^a-z0-9_-]/g, "")}.md`);
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) { const kv = /^(\w+):\s*(.*)$/.exec(line.trim()); if (kv) meta[kv[1].toLowerCase()] = kv[2].trim(); }
  return { name: path.basename(file, ".md"), file, title: meta.title || path.basename(file, ".md"), root: meta.root ? path.resolve(meta.root) : "", auto: /^(true|yes|1)$/i.test(meta.auto || ""), text: (m ? raw.slice(m[0].length) : raw).trim() };
}
function list() {
  try { return fs.readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => read(f.slice(0, -3))).filter(Boolean); } catch { return []; }
}
const inside = (dir, root) => { const r = path.relative(root, dir); return !r.startsWith("..") && !path.isAbsolute(r); };

// Before index.js fixes its folder: `yai acme` / `yai focus acme` moves into the pack's root.
function startup(argv) {
  const a = argv[2], b = argv[3];
  const name = a === "focus" && b ? b : a && !a.startsWith("-") && read(a) ? a : null;
  if (!name) return null;
  const pack = read(name);
  if (!pack) return null;
  argv.splice(2, a === "focus" ? 2 : 1);
  if (pack.root && fs.existsSync(pack.root) && !inside(process.cwd(), pack.root)) process.chdir(pack.root);
  return pack.name;
}

module.exports = function create(d) {
  const { state, root, api, ui } = d;
  const { c, print } = ui;
  const projectCfg = () => d.project();

  function on(name, { quiet = false, remember = true } = {}) {
    const pack = read(name);
    if (!pack) { print(c.yellow(`   No pack called ${name}. Packs live in ${DIR}.`)); return false; }
    state.focus = pack;
    if (remember) { projectCfg().focus = pack.name; api.save(); }
    if (!quiet) {
      ui.note(`${c.accent("◆")} ${c.ink(`${pack.title} focus on`)} ${c.dim(`· ${pack.text.length < 1000 ? "under 1k" : `${Math.round(pack.text.length / 1000)}k`} characters of ${pack.title} knowledge in every message · /focus off to stop`)}`);
      if (pack.root && !inside(root, pack.root)) print(c.dim(`   yAI Code is in ${root}; ${pack.title}'s projects are in ${pack.root}. To work on them, start it there: yai ${pack.name}`));
    }
    return true;
  }
  function off() {
    if (!state.focus) return print(c.dim("   No focus is on."));
    const t = state.focus.title;
    state.focus = null;
    projectCfg().focus = "off";
    api.save();
    ui.note(c.dim(`${t} focus off`));
  }
  // At start: `yai <name>`, then what this folder remembers, then a pack whose root holds this folder and says auto.
  function boot(fromArgs, { quiet = false } = {}) {
    const saved = projectCfg().focus;
    if (fromArgs) return on(fromArgs, { quiet });
    if (saved === "off") return false;
    if (saved && read(saved)) return on(saved, { quiet, remember: false });
    const auto = list().find((p) => p.auto && p.root && inside(root, p.root));
    return auto ? on(auto.name, { quiet, remember: false }) : false;
  }
  function command(arg) {
    const a = String(arg || "").trim();
    if (/^off$/i.test(a)) return off();
    if (a) return on(a);
    const packs = list();
    if (!packs.length) return print(c.dim(`   No packs yet. A pack is a Markdown file in ${DIR}; /focus <name> turns it on.`));
    print("");
    for (const p of packs) print(`   ${state.focus?.name === p.name ? c.green("●") : c.faint("○")} ${c.ink(p.title.padEnd(16))} ${c.dim(`/focus ${p.name}${p.root ? ` · ${p.root}` : ""}`)}`);
    print(c.dim("   /focus <name> turns one on (remembered for this folder) · /focus off"));
  }
  // The section of the system prompt: the pack, as standing knowledge.
  function block() {
    const p = state.focus;
    if (!p) return "";
    return `\n\n# ${p.title} focus\nThe user turned on their ${p.title} focus: everything in this session is about ${p.title}. ` +
      `Treat the notes below as what you already know about it (its people, systems, folders and standing rules) and follow ` +
      `the rules in them over your own defaults. When a task touches one of the projects below, work in that project's folder ` +
      `and read its own docs (CONTEXT.md, CLAUDE.md, SOPs) before changing it. If something here looks out of date compared ` +
      `with the code, trust the code and say what differs.\n\n${p.text}`;
  }
  return { on, off, boot, command, block, list, read };
};
module.exports.startup = startup;
module.exports.read = read;
