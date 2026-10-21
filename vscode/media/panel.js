// The yAI Code panel (2026-10-20 redesign): a chat in VS Code's own style. yai --stdio sends structured events
// (yAI's words line by line, steps and their results, diffs, notes, questions); this draws them.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let whoText = "";
  let busy = false, turn = null, text = null, step = null, ready = false;

  const I = {
    read: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    list: '<svg viewBox="0 0 16 16"><path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    run: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 6l2.2 2L4 10M8 10.5h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    edit: '<svg viewBox="0 0 16 16"><path d="M3 13h2.5L13 5.5 10.5 3 3 10.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    web: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
    look: '<svg viewBox="0 0 16 16"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
    dot: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5" fill="currentColor"/></svg>',
    send: '<svg viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stop: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  };
  const iconFor = (verb) => {
    const v = verb.toLowerCase();
    if (/read/.test(v)) return I.read;
    if (/list/.test(v)) return I.list;
    if (/find|search|grep/.test(v)) return I.search;
    if (/run|bash|powershell|shell|task/.test(v)) return I.run;
    if (/edit|create|write|update/.test(v)) return I.edit;
    if (/web|fetch/.test(v)) return I.web;
    if (/look/.test(v)) return I.look;
    return I.dot;
  };

  // ---------- a small Markdown renderer (yAI's answers) ----------
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  }
  function markdown(src) {
    const out = [];
    let code = null, list = null, para = [];
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`); list = null; };
    for (const line of src.split("\n")) {
      if (code) {
        if (/^\s*```/.test(line)) { out.push(`<div class="code"><div class="code-head"><span>${esc(code.lang || "code")}</span><button class="copy" type="button">Copy</button></div><pre><code>${esc(code.lines.join("\n"))}</code></pre></div>`); code = null; }
        else code.lines.push(line);
        continue;
      }
      let m;
      if ((m = line.match(/^\s*```\s*([\w+#.-]*)/))) { flushPara(); flushList(); code = { lang: m[1], lines: [] }; }
      else if ((m = line.match(/^(#{1,6})\s+(.*)/))) { flushPara(); flushList(); out.push(`<h4>${inline(m[2])}</h4>`); }
      else if ((m = line.match(/^\s*([-*+•]|\d+[.)])\s+(.*)/))) {
        flushPara();
        const tag = /\d/.test(m[1]) ? "ol" : "ul";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(m[2]);
      } else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line); }
    }
    flushPara(); flushList();
    if (code) out.push(`<div class="code"><div class="code-head"><span>${esc(code.lang || "code")}</span></div><pre><code>${esc(code.lines.join("\n"))}</code></pre></div>`);
    return out.join("");
  }

  // ---------- the conversation ----------
  const stick = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  function add(html, cls) {
    const keep = stick();
    $("empty")?.remove();
    const el = document.createElement("div");
    el.className = cls;
    el.innerHTML = html;
    (turn || log).appendChild(el);
    if (keep) log.scrollTop = log.scrollHeight;
    return el;
  }
  function userMsg(t) {
    $("empty")?.remove();
    turn = null;
    const el = document.createElement("div");
    el.className = "msg-user";
    el.textContent = t;
    log.appendChild(el);
    turn = document.createElement("div");
    turn.className = "turn";
    log.appendChild(turn);
    text = step = null;
    log.scrollTop = log.scrollHeight;
  }
  const pathLink = (p) => (/^[\w./\\-]+\.\w{1,8}$/.test(p) ? `<a class="file" data-path="${esc(p)}">${esc(p)}</a>` : esc(p));

  const handlers = {
    "text-start"() { text = add("", "msg-ai"); text.raw = ""; step = null; },
    text(ev) {
      if (!text) handlers["text-start"]();
      text.raw += (text.raw ? "\n" : "") + ev.line;
      const keep = stick();
      text.innerHTML = markdown(text.raw);
      if (keep) log.scrollTop = log.scrollHeight;
    },
    step(ev) {
      text = null;
      step = add(`<span class="ic spin">${iconFor(ev.verb)}</span><b>${esc(ev.verb)}</b><span class="arg">${pathLink(ev.arg)}</span><span class="res"></span>`, "step");
    },
    "step-result"(ev) {
      const s = step || add(`<span class="ic">${I.dot}</span><b></b><span class="arg"></span><span class="res"></span>`, "step");
      step = null;
      s.querySelector(".ic").classList.remove("spin");
      if (ev.tone) s.classList.add(ev.tone);
      const lines = ev.text ? ev.text.split("\n") : [];
      s.querySelector(".res").textContent = ev.summary || (lines.length === 1 ? lines[0].replace(/^(Read|Found|Listed|Wrote|Updated)\s+/, "") : lines.length ? `${lines.length} lines` : "");
      if (lines.length > 1 || (ev.summary && lines.length)) {
        const d = document.createElement("details");
        d.className = "step-out";
        d.innerHTML = `<summary>Output</summary><pre>${esc(ev.text)}</pre>`;
        if (ev.tone === "error") d.open = true;
        s.after(d);
      }
    },
    "step-cancel"() { if (step) { step.remove(); step = null; } },
    diff(ev) {
      text = null;
      if (step && /edit|create|write|update/i.test(step.querySelector("b").textContent)) { step.remove(); step = null; }
      const rows = ev.lines.map(([k, n, t]) => k === "…" ? '<div class="dl gap">⋯</div>'
        : `<div class="dl ${k === "+" ? "add" : k === "-" ? "del" : ""}"><span class="n">${n || ""}</span><span class="k">${k === " " ? "" : esc(k === "-" ? "−" : k)}</span><span class="t">${esc(t)}</span></div>`).join("");
      add(`<div class="diff-head"><span class="ic">${I.edit}</span><b>${ev.created ? "Create" : "Edit"}</b>${pathLink(ev.path)}<span class="counts">${ev.created ? `new · ${ev.added} line${ev.added === 1 ? "" : "s"}` : `<span class="plus">+${ev.added}</span> <span class="minus">−${ev.removed}</span>`}</span></div><div class="diff-body">${rows}</div>`, "diff");
    },
    note(ev) {
      text = null;
      const t = ev.text.trim();
      const tone = /^✓/.test(t) ? "ok" : /^[✕!]/.test(t) ? "warn" : "";
      add(esc(t), `note ${tone}`);
    },
    out(ev) {
      const t = ev.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
      if (!t.trim()) return;
      text = null;
      add(`<pre>${esc(t.replace(/\n+$/, ""))}</pre>`, "out");
    },
    user(ev) { userMsg(ev.text); },
  };

  // ---------- the question card ----------
  function ask(ev) {
    const box = $("ask");
    const edit = ev.edit;
    box.innerHTML = `<div class="ask-title">${esc(ev.title)}</div>` +
      (edit ? `<div class="ask-sub">${esc(edit.path)} · ${edit.created ? "new file" : "proposed change"} <button class="link" id="viewDiff" type="button">View diff</button></div>` : ev.detail ? `<pre>${esc(ev.detail)}</pre>` : "") +
      `<div class="ask-row">${ev.options.map((o, i) => `<button type="button" data-i="${i}" class="${i === 0 ? "" : "secondary"}">${i < 9 ? `<kbd>${i + 1}</kbd>` : ""}${esc(o)}</button>`).join("")}</div>`;
    box.hidden = false;
    box.onclick = (e) => {
      if (e.target.closest("#viewDiff")) return vscode.postMessage({ type: "viewDiff" });
      const b = e.target.closest("[data-i]");
      if (!b) return;
      vscode.postMessage({ type: "answer", id: ev.id, choice: Number(b.dataset.i) });
      box.hidden = true;
      input.focus();
    };
    box.querySelector("[data-i]").focus();
  }
  document.addEventListener("keydown", (e) => {
    if ($("ask").hidden || e.target === input) return;
    if (/^[1-9]$/.test(e.key)) $("ask").querySelector(`[data-i="${Number(e.key) - 1}"]`)?.click();
  });

  // ---------- state ----------
  function setBusy(b) {
    busy = b;
    $("send").innerHTML = b ? I.stop : I.send;
    $("send").title = b ? "Stop (Esc)" : "Send (Enter)";
    $("send").classList.toggle("stop", b);
    $("status").hidden = !b;
    if (!b) { $("statusText").textContent = ""; step?.querySelector(".ic")?.classList.remove("spin"); }
  }
  function setInfo(ev) {
    if (ev.models) $("model").innerHTML = ev.models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join("");
    if (ev.model) $("model").value = ev.model;
    if (ev.mode) document.querySelectorAll("#modes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === ev.mode)));
    const c = ev.cost || {};
    $("cost").textContent = c.session > 0 ? `$${c.session.toFixed(3)}${c.todayUsd != null ? ` · today $${c.todayUsd.toFixed(2)}/$${c.limitUsd}` : ""}` : "";
    const hot = c.todayUsd != null && c.limitUsd && c.todayUsd / c.limitUsd >= 0.8;
    $("cost").classList.toggle("hot", !!hot);
    if (typeof ev.context === "number") { $("ctx").style.width = `${Math.min(100, ev.context)}%`; $("ctxWrap").title = `Context ${ev.context}% full · /compact frees it`; }
  }
  let statusBits = {};
  function status(ev) {
    if (!ev.text && ev.text !== undefined && !ev.tokens && !ev.extra) { statusBits = {}; $("statusText").textContent = ""; return; }
    Object.assign(statusBits, Object.fromEntries(Object.entries(ev).filter(([k, v]) => k !== "type" && v != null)));
    $("statusText").textContent = [statusBits.text || "thinking", statusBits.tokens ? `${statusBits.tokens} tokens` : "", statusBits.extra || ""].filter(Boolean).join(" · ");
  }

  window.addEventListener("message", ({ data: ev }) => {
    if (handlers[ev.type]) return handlers[ev.type](ev);
    switch (ev.type) {
      case "starting": whoText = `Starting in ${ev.folder}…`; if ($("who")) $("who").textContent = whoText; break;
      case "ready":
        ready = true;
        whoText = `${ev.user} · ${ev.folder.split(/[\\/]/).pop()} · v${ev.version}`;
        if ($("who")) $("who").textContent = whoText;
        setInfo(ev);
        input.focus();
        break;
      case "busy": setBusy(true); statusBits = {}; status({ text: "thinking" }); break;
      case "status": status(ev); break;
      case "ask": ask(ev); break;
      case "done": {
        const worked = busy; // a mode or model change also sends "done"
        setBusy(false);
        setInfo(ev);
        if (worked && ev.stats && turn && turn.childElementCount) add(esc(ev.stats), "stats");
        text = step = null;
        break;
      }
      case "error":
        setBusy(false);
        add(esc(ev.message), "note error");
        break;
      case "exited":
        setBusy(false);
        add(`${esc(ev.message || "yAI Code stopped.")} <button type="button" class="link" id="restartBtn">Start again</button>`, "note error");
        $("restartBtn").onclick = () => vscode.postMessage({ type: "restart" });
        break;
      case "clear":
        log.innerHTML = emptyHtml;
        if ($("who")) $("who").textContent = whoText;
        turn = text = step = null;
        $("ask").hidden = true;
        break;
      case "prefill": input.value = ev.text + input.value; grow(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); break;
      case "echo": userMsg(ev.text); break;
    }
  });

  // ---------- sending ----------
  const emptyHtml = $("log").innerHTML;
  function submit(t) {
    const msg = (t ?? input.value).trim();
    if (!msg) return;
    if (busy) return;
    userMsg(msg);
    vscode.postMessage({ type: "prompt", text: msg });
    input.value = "";
    grow();
  }
  function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; }
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === "Escape" && busy) vscode.postMessage({ type: "stop" });
  });
  $("send").onclick = () => (busy ? vscode.postMessage({ type: "stop" }) : submit());
  $("model").onchange = () => vscode.postMessage({ type: "model", id: $("model").value });
  $("modes").onclick = (e) => { const b = e.target.closest("button"); if (b) vscode.postMessage({ type: "mode", mode: b.dataset.mode }); };
  log.addEventListener("click", (e) => {
    const f = e.target.closest("a.file");
    if (f) return vscode.postMessage({ type: "openFile", path: f.dataset.path });
    const s = e.target.closest(".suggest");
    if (s) return submit(s.dataset.text);
    const c = e.target.closest(".copy");
    if (c) { navigator.clipboard.writeText(c.closest(".code").querySelector("code").textContent); c.textContent = "Copied"; setTimeout(() => (c.textContent = "Copy"), 1200); }
  });
  setBusy(false);
})();
