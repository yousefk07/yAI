// yAI Code for VS Code (2026-10-20): the yAI Code agent in a side panel. It runs `yai --stdio` in the workspace
// folder (one JSON object per line each way; see "yai --stdio" in cli/index.js), shows what yAI prints in the panel,
// and opens each proposed edit as a VS Code diff with Approve / Reject.
const vscode = require("vscode");
const path = require("path");
const { spawn } = require("child_process");

let panel = null; // the webview view
let proc = null; // the running yai --stdio
let pendingAsk = null; // { id, edit } while an edit waits for an answer
const backlog = []; // messages for the panel before it's open
const docs = new Map(); // yai-diff: URIs -> text (the two sides of a diff)

function post(msg) {
  if (panel) panel.webview.postMessage(msg);
  else backlog.push(msg);
}
function send(obj) {
  if (proc && proc.stdin.writable) proc.stdin.write(JSON.stringify(obj) + "\n");
}

function start() {
  stop();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return post({ type: "error", message: "Open a folder first: yAI Code works on the project in it." });
  const cmd = vscode.workspace.getConfiguration("yai").get("command") || "yai";
  const light = [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind);
  const env = { ...process.env, YAI_FORCE_COLOR: "1", YAI_COLUMNS: "60", YAI_THEME: light ? "light" : "dark" };
  // A path to cli/index.js runs with Node; anything else is a command on the PATH (yai, after npm link).
  const isFile = /\.(c|m)?js$/i.test(cmd);
  proc = isFile ? spawn(process.platform === "win32" ? "node.exe" : "node", [cmd, "--stdio"], { cwd: folder, env })
    : spawn(cmd, ["--stdio"], { cwd: folder, env, shell: true });
  post({ type: "starting", folder: path.basename(folder) });
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "ask" && ev.edit) showDiff(ev);
      post(ev);
    }
  });
  let errText = "";
  proc.stderr.on("data", (d) => (errText += d));
  const me = proc;
  proc.on("exit", (code) => {
    if (proc !== me) return;
    proc = null;
    post({ type: "exited", code, message: errText.trim().split("\n").slice(-3).join("\n") || (code ? "yAI Code stopped." : "") });
  });
  proc.on("error", (err) => post({ type: "error", message: `Couldn't start "${cmd}": ${err.message}. Install yAI Code (npm link in your yAI folder) or set yai.command.` }));
}
function stop() {
  if (proc) { const p = proc; proc = null; try { p.kill(); } catch {} }
}

// A proposed edit: the file as it is (or empty) beside the file as yAI would write it.
async function showDiff(ev) {
  pendingAsk = ev;
  const key = `${Date.now()}`;
  const left = vscode.Uri.parse(`yai-diff:/${key}/before/${ev.edit.path}`);
  const right = vscode.Uri.parse(`yai-diff:/${key}/after/${ev.edit.path}`);
  docs.set(left.toString(), ev.edit.before || "");
  docs.set(right.toString(), ev.edit.after || "");
  await vscode.commands.executeCommand("vscode.diff", left, right, `yAI: ${ev.edit.path} (${ev.edit.created ? "new file" : "proposed change"})`, { preview: true, preserveFocus: true });
}
async function closeDiffs() {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input && input.modified && input.modified.scheme === "yai-diff") await vscode.window.tabGroups.close(tab).catch(() => {});
    }
  }
}

class ChatView {
  constructor(context) { this.context = context; }
  resolveWebviewView(view) {
    panel = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2);
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${css}"></head><body>
      <header id="bar">
        <select id="model" title="Model"></select>
        <div id="modes" class="seg" role="group" aria-label="Approvals">
          <button type="button" data-mode="default" title="Ask before each edit and command">Ask</button>
          <button type="button" data-mode="acceptEdits" title="Apply edits without asking (commands still ask)">Auto</button>
          <button type="button" data-mode="plan" title="Read-only: investigate and propose a plan">Plan</button>
        </div>
        <span id="cost" title="yAI Ultra: this session, and today against your daily allowance"></span>
      </header>
      <div id="ctxWrap"><div id="ctx"></div></div>
      <main id="log" role="log" aria-live="polite"><div id="empty">
        <div class="mark">y<i></i></div>
        <h2>yAI Code</h2>
        <p id="who">Starting…</p>
        <div class="suggests">
          <button type="button" class="suggest" data-text="Explain how this project is put together">Explain this project</button>
          <button type="button" class="suggest" data-text="Find bugs in the code I changed recently and fix them">Find and fix bugs</button>
          <button type="button" class="suggest" data-text="/review">Review my changes</button>
        </div>
        <p class="tip">Edits open as diffs to approve · @file mentions a file · / for commands</p>
      </div></main>
      <div id="ask" hidden></div>
      <div id="plan" hidden></div>
      <div id="status" hidden><span class="dots"><i></i><i></i><i></i></span><span id="statusText"></span></div>
      <footer id="composer">
        <textarea id="input" rows="1" placeholder="Ask yAI Code…"></textarea>
        <button type="button" id="send" title="Send (Enter)"></button>
      </footer>
      <script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m) => {
      if (m.type === "prompt") { if (!proc) start(); send({ type: m.text.startsWith("/") ? "command" : "prompt", text: m.text }); }
      else if (m.type === "answer") { send({ type: "answer", id: m.id, choice: m.choice }); if (pendingAsk && pendingAsk.id === m.id) { pendingAsk = null; closeDiffs(); } }
      else if (m.type === "stop") send({ type: "stop" });
      // a note while yAI works, and /team: the picker's answer and the board's actions (open, retry, skip, pause, note)
      else if (m.type === "note") send({ type: "note", text: m.text });
      else if (m.type === "teamPick") send({ type: "team-pick-answer", id: m.id, result: m.result });
      else if (m.type === "teamAction") send({ type: "team-action", action: m.action, n: m.n, text: m.text });
      else if (m.type === "mode") send({ type: "mode", mode: m.mode });
      else if (m.type === "model") send({ type: "model", id: m.id });
      else if (m.type === "restart") start();
      else if (m.type === "viewDiff" && pendingAsk) showDiff(pendingAsk);
      else if (m.type === "openFile") {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (folder) vscode.window.showTextDocument(vscode.Uri.joinPath(folder, m.path)).then(undefined, () => {});
      }
    });
    view.onDidDispose(() => { panel = null; });
    while (backlog.length) view.webview.postMessage(backlog.shift());
    if (!proc) start();
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("yai-diff", { provideTextDocumentContent: (uri) => docs.get(uri.toString()) || "" }),
    vscode.window.registerWebviewViewProvider("yai.chat", new ChatView(context), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("yai.newChat", () => { send({ type: "new" }); post({ type: "clear" }); }),
    vscode.commands.registerCommand("yai.stop", () => send({ type: "stop" })),
    vscode.commands.registerCommand("yai.restart", () => { post({ type: "clear" }); start(); }),
    vscode.commands.registerCommand("yai.askAboutSelection", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      const sel = ed.selection;
      const lines = sel.isEmpty ? "" : ` (lines ${sel.start.line + 1}-${sel.end.line + 1})`;
      await vscode.commands.executeCommand("yai.chat.focus");
      post({ type: "prefill", text: `@${rel}${lines} ` });
    }),
    vscode.commands.registerCommand("yai.fixProblems", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const problems = vscode.languages.getDiagnostics(ed.document.uri).filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      if (!problems.length) return vscode.window.showInformationMessage(`No problems in ${rel}.`);
      const list = problems.slice(0, 30).map((d) => `- line ${d.range.start.line + 1}: ${d.message}`).join("\n");
      await vscode.commands.executeCommand("yai.chat.focus");
      if (!proc) start();
      send({ type: "prompt", text: `Fix these problems VS Code reports in @${rel}:\n${list}` });
      post({ type: "echo", text: `Fix the ${problems.length} problem${problems.length === 1 ? "" : "s"} in ${rel}` });
    }),
    { dispose: stop }
  );
}
function deactivate() { stop(); }

module.exports = { activate, deactivate };
