// The yAI Code panel: what yAI prints (with its colours), questions as buttons, model and approval pickers.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input");
  let busy = false, cur = null;

  // ---------- yAI's coloured output: ANSI SGR codes to spans ----------
  const st = { fg: null, bg: null, bold: false, dim: false, italic: false };
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  function sgr(params) {
    const p = params.split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const n = p[i] || 0;
      if (n === 0) Object.assign(st, { fg: null, bg: null, bold: false, dim: false, italic: false });
      else if (n === 1) st.bold = true;
      else if (n === 2) st.dim = true;
      else if (n === 3) st.italic = true;
      else if (n === 22) st.bold = st.dim = false;
      else if (n === 23) st.italic = false;
      else if (n === 39) st.fg = null;
      else if (n === 49) st.bg = null;
      else if ((n === 38 || n === 48) && p[i + 1] === 2) { const c = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; n === 38 ? (st.fg = c) : (st.bg = c); i += 4; }
    }
  }
  function toHtml(text) {
    let out = "";
    const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07]*\x07/g;
    let last = 0, m;
    const piece = (s) => {
      if (!s) return;
      s = s.split("\n").map((line) => line.split("\r").filter((x, i, a) => i === a.length - 1 || x).pop() || "").join("\n");
      const style = [st.fg && `color:${st.fg}`, st.bg && `background:${st.bg}`, st.bold && "font-weight:600", st.dim && "opacity:.75", st.italic && "font-style:italic"].filter(Boolean).join(";");
      out += style ? `<span style="${style}">${esc(s)}</span>` : esc(s);
    };
    while ((m = re.exec(text))) {
      piece(text.slice(last, m.index));
      if (m[2] === "m") sgr(m[1]);
      last = re.lastIndex;
    }
    piece(text.slice(last));
    return out;
  }
  function block(cls) {
    const el = document.createElement("div");
    el.className = cls;
    log.appendChild(el);
    return el;
  }
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  function append(html) {
    const stick = atBottom();
    if (!cur) cur = block("out");
    cur.insertAdjacentHTML("beforeend", html);
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function note(text, cls = "note") {
    cur = null;
    block(cls).textContent = text;
    log.scrollTop = log.scrollHeight;
  }
  function userLine(text) {
    cur = null;
    block("user").textContent = text;
    log.scrollTop = log.scrollHeight;
  }
  function setBusy(b) {
    busy = b;
    $("stop").hidden = !b;
    $("send").disabled = b;
    if (!b) $("status").textContent = "";
  }

  // ---------- questions ----------
  function ask(ev) {
    const box = $("ask");
    box.innerHTML = "";
    const title = document.createElement("div");
    title.className = "ask-title";
    title.textContent = ev.title;
    box.appendChild(title);
    if (ev.edit) {
      const sub = document.createElement("div");
      sub.className = "ask-sub";
      sub.textContent = `The ${ev.edit.created ? "new file" : "change"} is open as a diff in the editor.`;
      box.appendChild(sub);
    } else if (ev.detail) {
      const pre = document.createElement("pre");
      pre.textContent = ev.detail;
      box.appendChild(pre);
    }
    const row = document.createElement("div");
    row.className = "ask-row";
    ev.options.forEach((label, i) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (i > 0) b.className = "secondary";
      b.onclick = () => {
        vscode.postMessage({ type: "answer", id: ev.id, choice: i });
        box.hidden = true;
      };
      row.appendChild(b);
    });
    box.appendChild(row);
    box.hidden = false;
    row.firstChild.focus();
  }

  // ---------- from the extension ----------
  window.addEventListener("message", ({ data: ev }) => {
    switch (ev.type) {
      case "starting": note(`Starting yAI Code in ${ev.folder}…`, "faint"); break;
      case "ready": {
        note(`yAI Code ${ev.version} · ${ev.user} · ${ev.models.find((m) => m.id === ev.model)?.label || ev.model}`, "faint");
        $("model").innerHTML = ev.models.map((m) => `<option value="${esc(m.id)}"${m.id === ev.model ? " selected" : ""}>${esc(m.label)}</option>`).join("");
        $("mode").value = ev.mode;
        input.focus();
        break;
      }
      case "busy": setBusy(true); break;
      case "out": append(toHtml(ev.text)); break;
      case "status": $("status").textContent = ev.text ? `${ev.text}${ev.tokens ? ` · ${ev.tokens} tokens` : ""}…` : ""; break;
      case "ask": ask(ev); break;
      case "done": {
        setBusy(false);
        cur = null;
        if (ev.mode) $("mode").value = ev.mode;
        if (ev.model) $("model").value = ev.model;
        const c = ev.cost || {};
        $("cost").textContent = c.session > 0 ? `$${c.session.toFixed(3)}${c.todayUsd != null ? ` · today $${c.todayUsd.toFixed(2)}/$${c.limitUsd}` : ""}` : "";
        $("cost").title = "yAI Ultra: this session, and today against your daily allowance";
        if (ev.stats) note(ev.stats, "faint");
        break;
      }
      case "error": setBusy(false); note(ev.message, "error"); break;
      case "exited": setBusy(false); note(ev.message || "yAI Code stopped.", "error"); { const b = block("restart"); b.innerHTML = '<button type="button">Start again</button>'; b.firstChild.onclick = () => vscode.postMessage({ type: "restart" }); } break;
      case "clear": log.innerHTML = ""; cur = null; $("ask").hidden = true; break;
      case "prefill": input.value = ev.text + input.value; input.focus(); input.setSelectionRange(input.value.length, input.value.length); break;
      case "echo": userLine(ev.text); break;
    }
  });

  // ---------- to the extension ----------
  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    userLine(text);
    vscode.postMessage({ type: "prompt", text });
    input.value = "";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("form").requestSubmit(); }
    if (e.key === "Escape" && busy) vscode.postMessage({ type: "stop" });
  });
  $("stop").onclick = () => vscode.postMessage({ type: "stop" });
  $("mode").onchange = () => vscode.postMessage({ type: "mode", mode: $("mode").value });
  $("model").onchange = () => vscode.postMessage({ type: "model", id: $("model").value });
})();
