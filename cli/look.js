"use strict";
// yAI Code v2 (2026-10-21, Claude Design "yAI Code v2"): a friendlier terminal where you always know what it's
// doing, what it needs and what you can press. This file draws the pieces; index.js decides when.
//   - a status pill: Ready · Working (step 2 of 4) · Waiting for you · Finished in 41 s · Needs attention
//   - a key bar under the input listing the keys that work right now, the mode, the model and "memory 14% used"
//   - the start screen: a greeting, what yAI saw in the project, four numbered starters and "pick up where you left off"
//   - suggestions with descriptions while you type a /command
//   - the plan card that stays at the bottom while yAI works (the model writes the plan; see PLAN_RULES)
//   - approvals that say what a command does and how risky it is, answered with one key
//   - a summary when a task is done (tests, files changed, time) and failures explained before the stack trace

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

module.exports = function create({ ui }) {
  const { c } = ui;
  const W = () => ui.width();

  // ---------- the pill ----------
  // states: ready · working · waiting · finished · attention
  function pill(st, label) {
    const text = ` ● ${label} `;
    if (st === "working") return c.soft(c.accent(text));
    if (st === "waiting") return c.soft(c.bold(c.accent(text)));
    if (st === "finished") return c.addbg(c.addfg(text));
    if (st === "attention") return c.delbg(c.delfg(text));
    return c.chip(c.dim(text));
  }
  // " yAI• Code │ pihole-dash on main ··················· ● Ready "
  function statusRow({ project, branch, st, label }) {
    const left = ` ${c.ink("y")}${c.bold(c.ink("AI"))}${c.accent("•")} ${c.dim("Code")} ${c.line("│")} ${c.ink(project)}${branch ? c.faint(" on ") + c.dim(branch) : ""}`;
    const right = pill(st, label);
    const room = W() - ui.vis(right);
    return ui.vis(left) <= room - 2 ? ui.pad(left, room) + right : right;
  }
  // The keys that work now on the left; the mode, the model and the memory on the right.
  const keyChip = (k) => c.chip(` ${c.dim(k)} `);
  function keysRow(keys, { mode, model, memory }, width = W()) {
    const left = " " + keys.map(([k, l]) => `${keyChip(k)} ${c.faint(l)}`).join("  ");
    const right = [`${keyChip("shift+tab")} ${mode}`, `${c.green("●")} ${c.dim(model)}`, c.faint(`memory ${memory}% used`)];
    for (let n = right.length; n >= 0; n--) {
      const r = right.slice(0, n).join("   ");
      if (ui.vis(left) + ui.vis(r) + 3 <= width) return ui.pad(left, width - ui.vis(r) - 1) + r;
    }
    return left;
  }
  // The full-window header: the same row, across the whole window.
  function headerRow(cols, { project, branch, st, label }) {
    const left = ` ${c.ink("y")}${c.bold(c.ink("AI"))}${c.accent("•")} ${c.dim("Code")}  ${c.line("│")}  ${c.ink(project)}${branch ? c.faint(" on ") + c.dim(branch) : ""}`;
    const right = pill(st, label) + " ";
    return ui.pad(left, Math.max(ui.vis(left) + 1, cols - ui.vis(right))) + right;
  }
  // The plan panel on the right of the full-window app: progress, the steps, what was read, the files changed.
  function panelLines(plan, task, w) {
    const total = plan.steps.length, done = Math.min(plan.done, total);
    const head = `${c.bold(c.ink("Plan"))}`, prog = c.faint(`${done} of ${total} done`);
    const out = ["", ui.pad(head, w - ui.vis(prog)) + prog];
    const fill = Math.round((done / Math.max(1, total)) * w);
    out.push(c.accent("━".repeat(fill)) + c.line("━".repeat(Math.max(0, w - fill))), "");
    plan.steps.forEach((t, i) => {
      const st = i < done ? "done" : i === done ? "now" : "todo";
      const mark = st === "done" ? c.chip(c.faint(` ${i + 1} `)) : st === "now" ? c.soft(c.bold(c.accent(` ${i + 1} `))) : c.faint(` ${i + 1} `);
      const words = wrap(t, w - 5);
      words.forEach((l, k) => out.push(`${k ? "    " : mark + " "}${st === "now" ? c.bold(c.ink(l)) : st === "done" ? c.faint(l) : c.dim(l)}`));
    });
    out.push("", c.line("─".repeat(w)));
    const seen = [task.reads ? `Read ${task.reads} file${task.reads === 1 ? "" : "s"}` : "", task.searches ? `${task.searches} search${task.searches === 1 ? "" : "es"}` : ""].filter(Boolean).join(" · ");
    out.push(c.dim(seen || "Nothing read yet"));
    if (task.files.size) {
      out.push(c.line("─".repeat(w)), c.faint("Files changed"));
      for (const [f, n] of task.files) {
        const counts = `${c.addfg("+" + n.a)}${n.d ? " " + c.delfg("−" + n.d) : ""}`;
        out.push(ui.pad(c.ink(ui.clip(f, w - ui.vis(counts) - 2)), w - ui.vis(counts)) + counts);
      }
    }
    return out;
  }
  const KEYS = {
    working: [["esc", "pause"], ["type", "to add a note"]],
    waiting: [["y", "yes"], ["a", "always"], ["n", "no"], ["esc", "pause"]],
    welcome: [["1–4", "pick"], ["/", "commands"], ["@", "add a file"], ["?", "help"]],
    ready: [["/", "commands"], ["@", "add a file"], ["?", "help"]],
    finished: [["r", "review"], ["u", "undo all"], ["c", "commit"], ["/", "commands"]],
    attention: [["f", "fix it"], ["e", "full output"], ["/", "commands"]],
    commands: [["↑↓", "move"], ["tab", "complete"], ["enter", "run"], ["esc", "close"]],
  };

  // ---------- the start screen ----------
  // What yAI can tell about the project without asking the model: its kind, how many files and tests.
  function projectSummary(root) {
    let files = [];
    try {
      files = execSync("git ls-files", { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 3000, maxBuffer: 20e6 }).toString().split("\n").filter(Boolean);
    } catch {}
    if (!files.length) {
      const skip = /^(node_modules|\.git|dist|build|\.next|venv|\.venv|__pycache__|yai-media)$/;
      const walk = (dir, depth) => {
        if (files.length > 3000 || depth > 6) return;
        let list = [];
        try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of list) {
          if (skip.test(e.name)) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else files.push(path.relative(root, p).replace(/\\/g, "/"));
        }
      };
      walk(root, 0);
    }
    const has = (f) => fs.existsSync(path.join(root, f));
    const read = (f) => { try { return fs.readFileSync(path.join(root, f), "utf8"); } catch { return ""; } };
    let kind = "";
    if (has("package.json")) {
      const pkg = read("package.json");
      kind = /"next"/.test(pkg) ? "a Next.js app" : /"react"/.test(pkg) ? "a React app" : /"vue"/.test(pkg) ? "a Vue app" : /"express"/.test(pkg) ? "an Express app" : "a Node.js project";
    } else if (has("pyproject.toml") || has("requirements.txt") || files.some((f) => f.endsWith(".py"))) {
      const req = read("requirements.txt") + read("pyproject.toml");
      kind = /flask/i.test(req) ? "a Flask app" : /django/i.test(req) ? "a Django app" : /fastapi/i.test(req) ? "a FastAPI app" : "a Python project";
    } else if (has("go.mod")) kind = "a Go project";
    else if (has("Cargo.toml")) kind = "a Rust project";
    else if (files.some((f) => /\.(html|css)$/.test(f))) kind = "a website";
    const tests = files.filter((f) => /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/i.test(f)).length;
    return { kind, files: files.length, tests };
  }
  function changedSinceCommit(root) {
    try {
      return execSync("git status --porcelain", { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }
  const STARTERS = (changed) => [
    ["1", "Fix something", "Paste an error or describe what's broken"],
    ["2", "Add a feature", "I'll plan it, then ask before changing files"],
    ["3", "Explain this project", "A tour of how the code fits together"],
    ["4", "Review my changes", changed ? `${changed} file${changed === 1 ? "" : "s"} edited since your last commit` : "Look over what changed before you commit"],
  ];
  // Two cards a row: "1  Fix something / Paste an error or describe what's broken".
  function starters(changed) {
    const list = STARTERS(changed);
    const gap = 2, cols = W() >= 80 ? 2 : 1;
    const cw = Math.floor((W() - 3 - gap * (cols - 1)) / cols);
    const card = ([k, t, d], first) => {
      const inner = cw - 2;
      const top = c.line("╭" + "─".repeat(inner) + "╮"), bot = c.line("╰" + "─".repeat(inner) + "╯");
      // The first card is highlighted; the key chip has its own background, so the band is painted around it.
      const fill = first ? c.soft : (s) => s;
      const chip = keyChip(k);
      const l1 = fill(" ") + chip + fill(ui.pad(` ${c.bold(c.ink(t))}`, inner - 1 - ui.vis(chip)));
      const l2 = fill(ui.pad(`     ${c.dim(ui.clip(d, inner - 6))}`, inner));
      return [top, c.line("│") + l1 + c.line("│"), c.line("│") + l2 + c.line("│"), bot];
    };
    const out = [];
    for (let i = 0; i < list.length; i += cols) {
      const row = list.slice(i, i + cols).map((x, j) => card(x, i + j === 0));
      for (let r = 0; r < 4; r++) out.push("  " + row.map((cardLines) => cardLines[r]).join(" ".repeat(gap)));
    }
    return out;
  }
  function welcome({ user, projectName, root, version, recent, logo = true }) {
    const s = projectSummary(root);
    const what = [s.kind || "a project", s.files ? `with ${s.files} file${s.files === 1 ? "" : "s"}` : "", s.tests ? `and ${s.tests} test file${s.tests === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ");
    const lines = [
      ...(logo ? ["",
        `  ${c.ink("█ █")} ${c.bold(c.ink("▄▀▄ █"))}`,
        `  ${c.ink("▀▄█")} ${c.bold(c.ink("█▀█ █"))}${c.accent("▄")}  ${c.dim("Code")}   ${c.faint("v" + version)}`,
        `  ${c.ink("▄▄▀")}`] : []),
      "",
      `  ${c.bold(c.ink(`Hi ${user ? user.charAt(0).toUpperCase() + user.slice(1) : "there"}. What should we do in ${projectName}?`))}`,
      ...wrap(s.files ? `I've looked at the project: ${what}. Type anything, or press a number.` : "This folder is empty. Describe what to build, or press a number.", W() - 4).map((l) => `  ${c.dim(l)}`),
      "",
      ...starters(changedSinceCommit(root)),
    ];
    // the last conversation's title, without any tags or pasted context the first message carried
    const title = recent ? String(recent.title).replace(/<[^>]*>[\s\S]*$/, "").replace(/\s+/g, " ").trim() || "your last conversation" : "";
    if (recent) lines.push("", `  ${c.panel(` ${keyChip("R")} ${c.bold(c.ink("Pick up where you left off:"))} ${c.dim(`“${ui.clip(title, Math.max(10, W() - 60))}”, ${recent.when}`)} `)}`);
    return lines;
  }

  // ---------- / suggestions ----------
  // [name, title, description]; descriptions can say what's on now.
  function suggestionLines(matches, sel, typed) {
    const inner = Math.min(W() - 4, 96);
    const out = [` ${c.line("╭" + "─".repeat(inner) + "╮")}`];
    const row = (s, fill) => ` ${c.line("│")}${(fill || ((x) => x))(ui.pad(s, inner))}${c.line("│")}`;
    out.push(row(` ${c.faint(typed.length > 1 ? `Matching “${typed.slice(1)}” · or just describe what you want in words` : "Commands · or just describe what you want in words")}`));
    if (!matches.length) out.push(row(`  ${c.dim("No command matches. Press enter to send it as a message.")}`));
    matches.forEach(([name, title, desc], i) => {
      const on = i === sel;
      const left = `  ${on ? c.bold(c.accent(name.padEnd(12))) : c.bold(c.ink(name.padEnd(12)))} ${c.ink(title)}`;
      const tail = on ? c.accent("enter ↵") : "";
      const room = inner - ui.vis(left) - ui.vis(tail) - 5;
      const d = desc && room > 8 ? c.faint(" · " + ui.clip(desc, room)) : "";
      out.push(row(ui.pad(left + d, inner - ui.vis(tail) - 2) + tail, on ? c.soft : null));
    });
    out.push(row(` ${c.faint("↑↓ move · tab complete · enter run · ? every command")}`));
    out.push(` ${c.line("╰" + "─".repeat(inner) + "╯")}`);
    return out;
  }

  // ---------- the plan card (live, while working) ----------
  function planLines(plan, { files }) {
    if (!plan || !plan.steps.length) return [];
    const total = plan.steps.length, done = Math.min(plan.done, total);
    const bar = Math.max(10, Math.min(30, W() - 40));
    const fill = Math.round((done / total) * bar);
    const out = ["", `   ${c.bold(c.ink("Plan"))}  ${c.accent("━".repeat(fill))}${c.line("━".repeat(bar - fill))}  ${c.faint(`${done} of ${total} done`)}`];
    plan.steps.forEach((t, i) => {
      const st = i < done ? "done" : i === done ? "now" : "todo";
      const mark = st === "done" ? c.green("✓") : st === "now" ? c.accent("●") : c.faint("○");
      const text = ui.clip(t, W() - 12);
      out.push(`   ${mark} ${st === "now" ? c.bold(c.ink(text)) : st === "done" ? c.faint(text) : c.dim(text)}`);
    });
    if (files.size) {
      const list = [...files].map(([f, n]) => `${f} ${c.addfg("+" + n.a)}${n.d ? " " + c.delfg("−" + n.d) : ""}`);
      out.push(`   ${c.faint("Files changed")}  ${ui.clip(list.join(c.faint(" · ")), W() + 40)}`);
    }
    out.push("");
    return out;
  }
  // Pulls <plan>…</plan> and <done>N</done> out of the model's words.
  const PLAN_RULES =
    "\n\n# Plan\nFor a task that takes more than two steps, start your first reply with a short plan in plain words, like this:\n" +
    "<plan>\n1. Read server.py and the tests\n2. Add the /health route\n3. Write and run a test\n4. Summarise what changed\n</plan>\n" +
    "Use 2 to 6 steps; a step usually takes several tool calls. When a whole step of the plan is finished (not after every tool call), " +
    "start your next reply with <done>N</done>, where N is the number of plan steps finished so far: 1 after the first step, and never more " +
    "than the number of steps in the plan. Don't count tool calls. " +
    "Skip the plan for questions and one-step tasks.\n\n# When something fails\nWhen a command or test fails and you can't simply fix it with one more try, " +
    "stop and explain it in one or two plain sentences first (what went wrong, without jargon), then say what you'd change and how big the change is, " +
    "and end that reply with <offer-fix/> on its own line. Don't make the fix until the user says so.";

  // ---------- approvals ----------
  // What a command is likely to do, in plain words.
  function riskOf(cmd) {
    const s = cmd.toLowerCase();
    if (/\brm\s+-r|\bdel\s+\/s|remove-item\b.*-recurse|\bsudo\b|--force\b|\bpush\s+(-f|--force)|reset\s+--hard|\bformat\b|\bmkfs\b|drop\s+table/.test(s))
      return { tag: "risky", fill: "del", explain: "This deletes or overwrites things, and it can't be undone." };
    if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add|update|publish)\b|\bpip3?\s+install\b|\bcurl\b|\bwget\b|invoke-webrequest|\bgit\s+(push|pull|fetch|clone)\b|\bdocker\s+(pull|push)\b/.test(s))
      return { tag: "network", fill: "soft", explain: "This uses the network, and it may change files in the project (packages, lock files)." };
    if (/\b(test|tests|pytest|jest|vitest|mocha|--test|unittest|go test|cargo test|py_compile|compileall|lint|eslint|tsc\b|mypy|ruff)\b/.test(s) || /(^|\s)--(check|test)\b/.test(s) || /^(git (status|diff|log|show|branch)|ls|dir|cat|type|pwd|get-childitem|get-content)\b/.test(s))
      return { tag: "read-only", fill: "chip", explain: "This only reads your code and runs it. It doesn't change files or touch the network." };
    return { tag: "changes files", fill: "soft", explain: "This may change files in the project." };
  }
  function approveTitle(cmd) {
    const s = cmd.toLowerCase();
    if (/^(rm|del|rmdir|rd|remove-item)\b/.test(s)) return "Can I delete these files?";
    if (/\b(test|tests|pytest|jest|vitest|mocha|--test|unittest)\b/.test(s)) return "Can I run the tests?";
    if (/\b(install|add)\b/.test(s) && /\b(npm|pnpm|yarn|bun|pip3?)\b/.test(s)) return "Can I install packages?";
    if (/\bbuild\b/.test(s)) return "Can I build the project?";
    const g = /^git\s+(\w+)/.exec(s);
    if (g) return `Can I run git ${g[1]}?`;
    return "Can I run this command?";
  }
  // The approval card: title, plain words, the command (or file) on a chip with its risk tag, single-key buttons.
  function approveLines({ title, explain, detail, tag, tagFill, options, selected }) {
    const inner = Math.min(W() - 7, 100);
    const edge = (s) => c.accent(s);
    const row = (s, fill) => `     ${edge("│")}${(fill || ((x) => x))(ui.pad(s, inner))}${edge("│")}`;
    const lines = [`     ${edge("╭" + "─".repeat(inner) + "╮")}`, row(` ${c.bold(c.ink(title))}`)];
    if (explain) for (const l of wrap(explain, inner - 2)) lines.push(row(` ${c.dim(l)}`));
    if (detail) {
      const t = tag ? (tagFill === "del" ? c.delbg(c.delfg(` ${tag} `)) : c.panel(c.dim(` ${tag} `))) : "";
      const shown = ui.clip(detail, inner - 6 - (tag ? tag.length + 3 : 0));
      lines.push(row(""), row(` ${c.chip(` ${c.faint("$")} ${c.ink(shown)} `)}${t ? "  " + t : ""}`));
    }
    lines.push(row(""));
    const btns = options.map(([k, l], i) => (i === selected ? c.soft(` ${c.bold(c.accent(`[${k}]`))} ${c.bold(c.accent(l))} `) : ` ${c.dim(`[${k}]`)} ${c.ink(l)} `));
    // Buttons on one line when they fit, else one per line.
    if (ui.vis(btns.join("  ")) + 2 <= inner) lines.push(row(" " + btns.join("  ")));
    else btns.forEach((b) => lines.push(row(" " + b)));
    lines.push(row(` ${c.faint("press a key · ←→ and enter work too · esc pause")}`));
    lines.push(`     ${edge("╰" + "─".repeat(inner) + "╯")}`);
    return lines;
  }
  function wrap(text, n) {
    const out = [];
    let line = "";
    for (const w of String(text).split(/\s+/)) {
      if (line && (line + " " + w).length > n) { out.push(line); line = w; } else line = line ? line + " " + w : w;
    }
    if (line) out.push(line);
    return out;
  }

  // ---------- the summary when a task is done ----------
  // Three cards side by side (stacked on a narrow screen): tests, files changed, time and tokens.
  function cards(list) {
    const cols = W() >= 90 ? list.length : 1;
    const gap = 2;
    const cw = Math.floor((W() - 3 - gap * (cols - 1)) / cols);
    const card = ({ label, value, sub, dot }) => {
      const inner = cw - 2;
      return [
        c.line("╭" + "─".repeat(inner) + "╮"),
        c.line("│") + ui.pad(` ${c.faint(label)}`, inner) + c.line("│"),
        c.line("│") + ui.pad(` ${dot ? c.green("● ") : ""}${c.bold(c.ink(ui.clip(value, inner - 4)))}`, inner) + c.line("│"),
        c.line("│") + ui.pad(` ${c.dim(ui.clip(sub || "", inner - 2))}`, inner) + c.line("│"),
        c.line("╰" + "─".repeat(inner) + "╯"),
      ];
    };
    const out = [];
    for (let i = 0; i < list.length; i += cols) {
      const row = list.slice(i, i + cols).map(card);
      for (let r = 0; r < 5; r++) out.push("  " + row.map((x) => x[r]).join(" ".repeat(gap)));
    }
    return out;
  }
  const buttons = (list) => "  " + list.map(([k, l], i) => (i === 0 ? c.soft(` ${c.bold(c.accent(`[${k}]`))} ${c.bold(c.accent(l))} `) : ` ${c.dim(`[${k}]`)} ${c.ink(l)} `)).join("  ");
  // Tests seen in a command's output: "4 passed", "1 failed" (pytest, jest/vitest, node --test, mocha, go, cargo).
  function testCounts(output) {
    const s = String(output);
    let passed = 0, failed = 0, m;
    if ((m = /(\d+) passed/.exec(s))) passed = +m[1];
    if ((m = /(\d+) failed/.exec(s))) failed = +m[1];
    if ((m = /(?:#|ℹ) pass (\d+)/.exec(s))) passed = +m[1];
    if ((m = /(?:#|ℹ) fail (\d+)/.exec(s))) failed = +m[1];
    if ((m = /Tests:\s+(?:(\d+) failed, )?(\d+) passed/.exec(s))) { failed = +(m[1] || 0); passed = +m[2]; }
    if ((m = /(\d+) passing/.exec(s))) passed = +m[1];
    if ((m = /(\d+) failing/.exec(s))) failed = +m[1];
    if ((m = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(s))) { passed = +m[1]; failed = +m[2]; }
    return passed || failed ? { passed, failed } : null;
  }
  // The red card for a failure: a header ("1 test failed" / "The command failed"), then the last lines of its output.
  function failureLines({ header, lines }) {
    const inner = Math.min(W() - 4, 100);
    const out = [` ${c.line("╭" + "─".repeat(inner) + "╮")}`, ` ${c.line("│")}${c.delbg(c.delfg(ui.pad(` ● ${header}`, inner)))}${c.line("│")}`];
    for (const l of lines) out.push(` ${c.line("│")}${ui.pad(` ${c.dim(ui.clip(l, inner - 2))}`, inner)}${c.line("│")}`);
    out.push(` ${c.line("│")}${ui.pad(` ${c.faint("e  show the full output")}`, inner)}${c.line("│")}`);
    out.push(` ${c.line("╰" + "─".repeat(inner) + "╯")}`);
    return out;
  }

  // ---------- the question form (the ask_user tool) ----------
  //  ← ☒ Address  ☐ Role  ☐ Since  ✓ Submit →
  //  Role: a fixed list or free text?
  //  ❯ 1. Fixed list
  //       Physician, Nurse injector, Clinic owner
  //    2. Free text
  //    3. Type something.
  //  ───────────────
  //    4. Chat about this
  //  Enter to select · Tab/Arrow keys to navigate · Esc to cancel
  function formLines({ questions, tab, sel, answers, typing, draft }) {
    const w = Math.min(W() - 2, 110);
    const rule = c.line("─".repeat(w));
    const tabs = questions.map((q, i) => {
      const box = answers[i] ? "☒" : "☐";
      const t = ` ${box} ${q.header} `;
      return i === tab ? c.soft(c.bold(c.accent(t))) : answers[i] ? c.ink(t) : c.dim(t);
    });
    const submit = tab === questions.length ? c.soft(c.bold(c.accent(" ✓ Submit "))) : c.ink(" ✓ Submit ");
    const out = [rule, ` ${c.faint("←")} ${[...tabs, submit].join(" ")} ${c.faint("→")}`, ""];
    if (tab < questions.length) {
      const q = questions[tab];
      for (const l of wrap(q.question, w - 2)) out.push(` ${c.bold(c.ink(l))}`);
      out.push("");
      const n = q.options.length;
      q.options.forEach((o, i) => {
        const on = i === sel;
        const picked = answers[tab] && answers[tab].label === o.label;
        out.push(` ${on ? c.accent("❯") : " "} ${(on ? (s) => c.bold(c.accent(s)) : c.ink)(`${i + 1}. ${o.label}`)}${picked ? " " + c.green("✓") : ""}`);
        if (o.description) for (const l of wrap(o.description, w - 8)) out.push(`      ${c.dim(l)}`);
      });
      const own = sel === n;
      const text = typing ? c.ink(draft) + c.accent("▏") : answers[tab] && answers[tab].own ? c.ink(answers[tab].label) + " " + c.green("✓") : c.dim("Type something.");
      out.push(` ${own ? c.accent("❯") : " "} ${(own ? (s) => c.bold(c.accent(s)) : c.ink)(`${n + 1}.`)} ${text}`);
      out.push(rule);
      const chat = sel === n + 1;
      out.push(` ${chat ? c.accent("❯") : " "} ${(chat ? (s) => c.bold(c.accent(s)) : c.ink)(`${n + 2}. Chat about this`)}`);
    } else {
      out.push(` ${c.bold(c.ink("Review your answers"))}`, "");
      questions.forEach((q, i) => out.push(`   ${c.faint(ui.pad(q.header, 14))} ${answers[i] ? c.ink(answers[i].label) : c.yellow("not answered")}`));
      out.push("");
      ["Submit answers", "Cancel"].forEach((l, i) => out.push(` ${sel === i ? c.accent("❯") : " "} ${(sel === i ? (s) => c.bold(c.accent(s)) : c.ink)(`${i + 1}. ${l}`)}`));
    }
    out.push("", ` ${c.faint(typing ? "Enter to keep it · Esc to stop typing" : "Enter to select · Tab/Arrow keys to navigate · Esc to cancel")}`);
    return out;
  }

  return { pill, statusRow, headerRow, panelLines, formLines, keysRow, KEYS, welcome, projectSummary, suggestionLines, planLines, PLAN_RULES, riskOf, approveTitle, approveLines, cards, buttons, testCounts, failureLines, keyChip };
};
