"use strict";
// Connections in yAI Code (2026-10-21): the services connected on the website (GitHub, Drive, Spotify, LEARN,
// weather, maps, Wolfram Alpha, arXiv, Semantic Scholar, YouTube, webhooks) reach the model through the service
// tool, and these commands use them:
//
//   /connections        what's connected, and where to connect more
//   /pr [note]          push this branch and open a pull request, with a title and description written from the diff
//   /issues             pick a GitHub issue of this repo and let yAI work on it
//   /deploy [prod]      deploy this folder with the Vercel CLI; print the link, or offer to fix a failed build

const { spawn, spawnSync } = require("child_process");

module.exports = function create(d) {
  const { state, root, api, ui, X } = d;
  const { c, print } = ui;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
    return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
  };

  // ---------- the services, for the model ----------
  let services = [];
  async function load() {
    try { services = (await api.hub("connections")).services || []; } catch { services = []; }
    return services;
  }
  const tools = () => services.filter((s) => s.connected).flatMap((s) => s.tools.map((t) => ({ ...t, label: s.label })));
  // The system prompt's section: what the service tool can reach right now.
  function promptBlock() {
    const list = tools();
    if (!list.length) return "";
    return "\n\n# Connected services\nThe user connected these on the yAI website. Call them with the service tool: <name> is the name below, <args> a JSON object. " +
      "Use them when they fit (live weather, directions, exact maths with wolfram.ask, papers, a YouTube transcript, the user's GitHub repos and issues, Drive files, LEARN due dates). " +
      "The ones marked (asks first) change something; the user approves each call.\n" +
      list.map((t) => `- ${t.name} ${JSON.stringify(t.params || {})}: ${t.desc}${t.write ? " (asks first)" : ""}`).join("\n");
  }
  const call = (tool, args, confirm = false) => api.hub("tool", { method: "POST", body: { tool, args, confirm } });

  // ---------- /connections ----------
  async function connections() {
    await X.busy("checking your connections", () => load());
    if (!services.length) return print(c.yellow("   Couldn't load your connections. Are you signed in? (/login)"));
    print("");
    for (const s of services) {
      const on = s.connected;
      print(`   ${on ? c.green("●") : c.faint("○")} ${c.ink(s.label.padEnd(24))} ${on ? c.dim(s.who ? `connected · ${s.who}` : "on") : c.faint(s.needs || "not connected")}`);
    }
    print("");
    print(c.dim(`   Connect more on the website: ${api.baseUrl()}/?connections=1`));
    print(c.dim("   yAI uses them through its service tool when a task needs them; ones that change something ask you first."));
  }

  // ---------- GitHub: /pr and /issues ----------
  function remoteRepo() {
    const url = git(["remote", "get-url", "origin"]).out;
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  }
  function needGitHub() {
    const gh = services.find((s) => s.id === "github");
    if (gh?.connected) return true;
    print(c.yellow(`   This needs GitHub connected to your yAI account: ${api.baseUrl()}/?connections=1`));
    return false;
  }

  async function pr(note = "") {
    if (!git(["rev-parse", "--is-inside-work-tree"]).ok) return print(c.yellow("   This folder isn't a git repository."));
    const repo = remoteRepo();
    if (!repo) return print(c.yellow("   The origin remote isn't on GitHub."));
    await load();
    if (!needGitHub()) return;
    if (git(["status", "--porcelain"]).out) {
      const i = await d.select({ title: "There are uncommitted changes. Commit them first?", options: ["Commit them (/commit)", "Open the PR without them", "Cancel"] });
      if (i === 2 || i < 0) return print(c.dim("   Cancelled."));
      if (i === 0) { await X.commit(""); if (git(["status", "--porcelain"]).out) return print(c.dim("   Not committed, so no PR yet.")); }
    }
    let branch = git(["branch", "--show-current"]).out;
    const base = (git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).out || "origin/main").replace(/^origin\//, "");
    if (!branch || branch === base) {
      const subject = git(["log", "-1", "--format=%s"]).out;
      const suggested = `yai/${(subject || "changes").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || Date.now()}`;
      const typed = ((await d.question(`   ${c.ink(`You're on ${base || "a detached HEAD"}. New branch for the PR`)} ${c.dim(`[${suggested}]:`)} `)) || "").trim();
      branch = typed || suggested;
      const made = git(["switch", "-c", branch]);
      if (!made.ok) return print(c.red(`   Couldn't make the branch: ${made.err}`));
    }
    const ahead = git(["log", `origin/${base}..HEAD`, "--format=%h %s"]).out;
    if (!ahead) return print(c.yellow(`   ${branch} has no commits that aren't on ${base} yet.`));
    // push with the user's own git credentials
    print(c.dim(`   Pushing ${branch} to origin…`));
    const push = await X.busy(`pushing ${branch}`, () => new Promise((resolve) => {
      const p = spawn("git", ["push", "-u", "origin", branch], { cwd: root, windowsHide: true });
      let out = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (out += b));
      p.on("close", (code) => resolve({ ok: code === 0, out }));
    }));
    if (!push.ok) return print(c.red(`   The push failed:\n${push.out.trim().split("\n").slice(-6).map((l) => "     " + l).join("\n")}`));
    const diff = clip(git(["diff", `origin/${base}...HEAD`]).out, 16000);
    let text;
    try {
      text = await X.busy("writing the pull request", (signal) => X.oneShot({
        model: state.model, signal,
        system: "Write a GitHub pull request for this change. First line: the title (under 70 characters, no prefix like 'PR:'). Then a blank line, then the description in markdown: a short summary, then '## Changes' as bullet points, then '## Testing' with how it was checked (say so plainly if it wasn't). No code fence around the whole thing.",
        messages: [{ role: "user", content: `Commits:\n${ahead}\n\nDiff:\n${diff}${note ? `\n\nNote from the author: ${note}` : ""}` }],
      }));
    } catch (err) {
      return print(c.red(`   ${err.message}`));
    }
    const [title, ...rest] = String(text).replace(/^```\w*\n?|\n?```$/g, "").trim().split("\n");
    const body = rest.join("\n").trim();
    print("");
    ui.frame([" " + c.bold(c.ink(title.replace(/^#+\s*/, ""))), "", ...body.split("\n").slice(0, 30).map((l) => " " + c.dim(l))], { indent: 3, inner: ui.width() - 5 });
    const i = await d.select({ title: `Open this pull request on ${repo} (${branch} → ${base})?`, options: ["Open it", "Open it as a draft", "Cancel"] });
    if (i === 2 || i < 0) return print(c.dim(`   Not opened. ${branch} is pushed, so you can open it on GitHub later.`));
    try {
      const r = await X.busy("opening the pull request", () => call("github.create_pr", { repo, head: branch, base, title: title.replace(/^#+\s*/, ""), body: `${body}\n\n_Opened with yAI Code_`, draft: String(i === 1) }, true));
      print(`   ${c.green("✓")} ${c.ink(r.text)}`);
    } catch (err) {
      print(c.red(`   ${err.message}`));
    }
  }

  async function issues() {
    const repo = remoteRepo();
    if (!repo) return print(c.yellow("   The origin remote isn't on GitHub."));
    await load();
    if (!needGitHub()) return;
    let text;
    try { text = (await X.busy(`reading ${repo}'s issues`, () => call("github.issues", { repo }))).text; } catch (err) { return print(c.red(`   ${err.message}`)); }
    const list = [...String(text).matchAll(/^- #(\d+) \[(\w+)\] (.*?) \(([^)]*)\) (\S+)\n {2}(.*)$/gm)].map((m) => ({ n: m[1], title: m[3], labels: m[4], url: m[5], body: m[6] }));
    if (!list.length) return print(c.dim(`   ${repo} has no open issues.`));
    const i = await d.select({ title: `Which issue should yAI work on? (${repo})`, options: [...list.slice(0, 9).map((x) => `#${x.n} ${clip(x.title, 70)}${x.labels ? `  (${x.labels})` : ""}`), "Cancel"] });
    if (i < 0 || i >= Math.min(9, list.length)) return print(c.dim("   Cancelled."));
    const x = list[i];
    return d.runAgent(`Work on GitHub issue #${x.n} of ${repo}: "${x.title}" (${x.url}).\nIts text starts: ${x.body}\n\nRead the full issue with the service tool (github.issues or github.file) if you need more. Find the cause in this project, fix it, check the fix, and finish with a short summary I can paste into the issue.`);
  }

  // ---------- /deploy ----------
  async function deploy(arg = "") {
    const prod = /\bprod(uction)?\b/i.test(arg);
    const has = spawnSync(process.platform === "win32" ? "vercel.cmd" : "vercel", ["--version"], { cwd: root, encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
    let cmd = "vercel";
    if (has.status !== 0) {
      const i = await d.select({ title: "The Vercel CLI isn't installed. Use npx to run it (it downloads the vercel package)?", options: ["Yes, use npx vercel", "No"] });
      if (i !== 0) return print(c.dim("   Install it with npm i -g vercel, then /deploy again."));
      cmd = "npx --yes vercel@latest";
    }
    if (prod) {
      const i = await d.select({ title: "Deploy to production? The live site changes for everyone.", options: ["Deploy to production", "Make a preview instead", "Cancel"] });
      if (i === 2 || i < 0) return print(c.dim("   Cancelled."));
      if (i === 1) return deploy("");
    }
    const full = `${cmd} deploy --yes${prod ? " --prod" : ""}`;
    ui.toolHeader(process.platform === "win32" ? "PowerShell" : "Bash", full);
    const r = await X.busy(prod ? "deploying to production" : "deploying a preview", (signal) => new Promise((resolve) => {
      const p = spawn(full, { cwd: root, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", CI: "1" } });
      let out = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (out += b));
      signal.addEventListener("abort", () => { try { p.kill(); } catch {} });
      p.on("close", (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "") }));
    }));
    const urls = [...r.out.matchAll(/https:\/\/[\w.-]+\.vercel\.app\b/g)].map((m) => m[0]);
    if (r.code === 0 && urls.length) {
      const url = urls[urls.length - 1];
      print("");
      ui.note(`${c.green("✓")} ${c.ink(prod ? "Live" : "Preview ready")} ${c.accent(url)}`);
      state.pendingContext.push(`I deployed this folder with Vercel (${prod ? "production" : "preview"}): ${url}`);
      return;
    }
    const tail = r.out.trim().split("\n").slice(-15);
    print("");
    print(`   ${c.red("✗")} ${c.ink("The deploy failed.")}`);
    for (const l of tail) print(`     ${c.dim(clip(l, ui.width() - 8))}`);
    if (/vercel login|No existing credentials|not logged in|token/i.test(r.out)) return print(c.yellow("   Sign in to Vercel first: type  ! vercel login  then /deploy again."));
    const i = await d.select({ title: "Let yAI fix it?", options: ["Fix the build", "Leave it"] });
    if (i !== 0) return;
    await d.runAgent(`The Vercel deploy failed. Its last output:\n${tail.join("\n")}\n\nFind the cause in this project and fix it (run the build locally to check if there is one). Don't deploy; I'll run /deploy again.`);
  }

  return { load, promptBlock, call, tools, connections, pr, issues, deploy, services: () => services };
};
