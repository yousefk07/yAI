// Canvas (2026-10-20): long writing and code open in an editor beside the chat. Edit it by hand, select a part and
// ask yAI to change just that, step through versions, and run HTML, JavaScript and Python live next to the code.
// While the canvas is open, its text goes with each message (lib/handlers.js canvasBlock), and an answer's
// ```canvas block becomes the next version. Each chat's canvas is kept in this browser (localStorage).
(function () {
  const panel = $("canvas");
  const KEY = (id) => `canvas:${id}`;
  const MAX_VERSIONS = 30;
  const EXT = { doc: "md", html: "html", htm: "html", css: "css", javascript: "js", js: "js", jsx: "jsx", typescript: "ts", ts: "ts", python: "py", py: "py", json: "json", java: "java", c: "c", cpp: "cpp", "c++": "cpp", csharp: "cs", go: "go", rust: "rs", sql: "sql", bash: "sh", sh: "sh", svg: "svg", xml: "xml", yaml: "yml", markdown: "md", md: "md" };
  const isDoc = (k) => k === "doc" || k === "markdown" || k === "md";
  const runKind = (k) => (/^(html?|svg|xml)$/.test(k) ? "html" : /^(javascript|js|jsx)$/.test(k) ? "js" : /^(python|py)$/.test(k) ? "py" : isDoc(k) ? "doc" : null);

  let cv = null;        // { title, kind, versions: [{ text, ts, by }], at, open }
  let view = "edit";    // edit | split | preview
  let liveEl = null;    // the answer that is writing into the canvas right now
  let streaming = false;
  let toolOn = store.get("canvasTool", false); // Tools > Canvas: ask yAI to use the canvas for long writing and code

  panel.innerHTML = `
    <div class="cv-head">
      <span class="cv-kind" id="cvKind">Doc</span>
      <input class="cv-title" id="cvTitle" aria-label="Title" spellcheck="false" />
      <div class="cv-ver" title="Versions">
        <button type="button" class="icon-btn" id="cvPrev" aria-label="Previous version"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
        <span id="cvVer">v1</span>
        <button type="button" class="icon-btn" id="cvNext" aria-label="Next version"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
      </div>
      <div class="segmented cv-views" role="tablist" id="cvViews">
        <button type="button" data-view="edit" aria-selected="true">Edit</button>
        <button type="button" data-view="split" aria-selected="false">Split</button>
        <button type="button" data-view="preview" aria-selected="false" id="cvPreviewTab">Preview</button>
      </div>
      <button type="button" class="icon-btn" id="cvCopy" title="Copy" aria-label="Copy"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button>
      <button type="button" class="icon-btn" id="cvDownload" title="Download" aria-label="Download"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>
      <button type="button" class="icon-btn" id="cvClose" title="Close the canvas" aria-label="Close the canvas"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="cv-body" id="cvBody">
      <textarea id="cvText" class="cv-text" spellcheck="true" aria-label="Canvas text"></textarea>
      <div class="cv-view" id="cvView" hidden></div>
    </div>
    <div class="cv-ask" id="cvAsk" hidden>
      <div class="cv-ask-chips" id="cvChips"></div>
      <form class="cv-ask-row" id="cvAskForm">
        <input id="cvAskInput" placeholder="Ask yAI to change the selected part" autocomplete="off" />
        <button type="submit" class="btn-primary" id="cvAskGo">Change</button>
      </form>
    </div>
    <div class="cv-foot"><span id="cvCount"></span><span id="cvNote">yAI sees this canvas while it's open</span></div>`;

  const ta = $("cvText");
  const cur = () => cv && cv.versions[cv.at];
  const save = () => { try { if (cv && chat?.id) localStorage.setItem(KEY(chat.id), JSON.stringify(cv)); } catch {} };

  function setView(v) {
    const rk = cv && runKind(cv.kind);
    view = rk ? v : "edit";
    $("cvViews").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
    $("cvBody").dataset.view = view;
    ta.hidden = view === "preview";
    $("cvView").hidden = view === "edit";
    if (view !== "edit") renderView();
  }

  function render() {
    if (!cv) return;
    const v = cur();
    $("cvKind").textContent = isDoc(cv.kind) ? "Doc" : cv.kind;
    if (document.activeElement !== $("cvTitle")) $("cvTitle").value = cv.title;
    if (ta.value !== v.text) ta.value = v.text;
    ta.readOnly = streaming;
    ta.classList.toggle("mono", !isDoc(cv.kind));
    $("cvVer").textContent = `v${cv.at + 1}${cv.versions.length > 1 ? ` of ${cv.versions.length}` : ""}`;
    $("cvPrev").disabled = cv.at === 0 || streaming;
    $("cvNext").disabled = cv.at >= cv.versions.length - 1 || streaming;
    const rk = runKind(cv.kind);
    $("cvViews").hidden = !rk;
    $("cvPreviewTab").textContent = rk === "py" ? "Run" : "Preview";
    const words = v.text.trim() ? v.text.trim().split(/\s+/).length : 0;
    $("cvCount").textContent = isDoc(cv.kind) ? `${words.toLocaleString()} words` : `${v.text.split("\n").length.toLocaleString()} lines`;
    $("cvNote").textContent = streaming ? "yAI is writing…" : v.by ? `${v.by} · ${new Date(v.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "yAI sees this canvas while it's open";
    if (view !== "edit") scheduleView();
  }

  // ---------- Preview / run ----------
  let viewTimer = null, viewUrl = "";
  const scheduleView = () => { clearTimeout(viewTimer); viewTimer = setTimeout(renderView, streaming ? 900 : 450); };
  async function renderView() {
    if (!cv || view === "edit") return;
    const text = cur().text, rk = runKind(cv.kind), box = $("cvView");
    if (rk === "doc") { box.innerHTML = `<div class="cv-doc">${renderMarkdown(text)}</div>`; return; }
    if (rk === "py") {
      if (streaming) return;
      box.innerHTML = '<div class="cv-run"><div class="muted">Running in Python (in your browser)…</div></div>';
      try {
        const r = await yaiData.run(text);
        box.innerHTML = `<div class="cv-run">${r.stdout ? `<pre>${escapeHtml(r.stdout)}</pre>` : ""}${(r.images || []).map((src) => `<img src="${src}" alt="Chart">`).join("")}` +
          `${r.error ? `<pre class="cv-err">${escapeHtml(r.error)}</pre>` : ""}${!r.stdout && !r.error && !(r.images || []).length ? '<div class="muted">No output.</div>' : ""}<div class="muted">${r.ms} ms</div></div>`;
      } catch (err) {
        box.innerHTML = `<div class="cv-run"><pre class="cv-err">${escapeHtml(err.message)}</pre></div>`;
      }
      return;
    }
    // HTML / SVG / JavaScript: a sandboxed frame from a blob: URL, like the chat's previews.
    let doc;
    if (rk === "js") doc = `<!doctype html><html><head><meta charset="utf-8">${CONSOLE_SHIM}<style>body{font:15px/1.5 system-ui,sans-serif;margin:16px}</style></head><body><script>${safeScript(text)}<\/script></body></html>`;
    else if (/^\s*<svg[\s>]/i.test(text)) doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh}</style></head><body>${text}</body></html>`;
    else {
      doc = /<html[\s>]/i.test(text) || /<body[\s>]/i.test(text) ? text : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${text}</body></html>`;
      doc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (m) => m + CONSOLE_SHIM) : CONSOLE_SHIM + doc;
    }
    if (viewUrl) URL.revokeObjectURL(viewUrl);
    viewUrl = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
    let frame = box.querySelector("iframe");
    if (!frame) {
      box.innerHTML = '<iframe title="Canvas preview" sandbox="allow-scripts allow-forms allow-modals allow-popups"></iframe>';
      frame = box.querySelector("iframe");
    }
    frame.src = viewUrl;
  }

  // ---------- Opening, versions ----------
  function show() {
    panel.hidden = false;
    $("shell").classList.add("canvas-open");
    cv.open = true;
    render();
    setView(view);
    save();
  }
  function open(title, kind, text, by = "yAI") {
    kind = String(kind || "doc").toLowerCase();
    if (!cv || cv.title !== title || cv.kind !== kind) {
      cv = { title: title || "Untitled", kind, versions: [{ text, ts: Date.now(), by }], at: 0, open: true };
      if (!runKind(kind)) view = "edit";
    } else if (cur().text !== text) addVersion(text, by);
    show();
  }
  function addVersion(text, by) {
    if (cur().text === text) return;
    cv.versions = cv.versions.slice(0, cv.at + 1);
    cv.versions.push({ text, ts: Date.now(), by });
    if (cv.versions.length > MAX_VERSIONS) cv.versions.shift();
    cv.at = cv.versions.length - 1;
  }
  function close() {
    panel.hidden = true;
    $("shell").classList.remove("canvas-open");
    if (cv) { cv.open = false; save(); }
    if (viewUrl) { URL.revokeObjectURL(viewUrl); viewUrl = ""; }
    $("cvView").innerHTML = "";
  }

  // Hand edits become a version after a pause in typing.
  let typeTimer = null;
  ta.addEventListener("input", () => {
    if (!cv || streaming) return;
    clearTimeout(typeTimer);
    const text = ta.value;
    // While typing, the newest version is yours and changes in place; a pause starts a new one next time.
    const v = cur();
    if (v.by === "You" && v.typing) v.text = text;
    else { addVersion(text, "You"); cur().typing = true; }
    cur().ts = Date.now();
    typeTimer = setTimeout(() => { delete cur().typing; save(); render(); }, 1500);
    if (view !== "edit") scheduleView();
    $("cvCount").textContent = isDoc(cv.kind) ? `${(text.trim() ? text.trim().split(/\s+/).length : 0).toLocaleString()} words` : `${text.split("\n").length.toLocaleString()} lines`;
  });
  // Tab indents in code
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && cv && !isDoc(cv.kind) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
    }
  });
  $("cvTitle").addEventListener("change", () => { if (cv) { cv.title = $("cvTitle").value.trim() || "Untitled"; save(); } });
  $("cvPrev").addEventListener("click", () => { if (cv && cv.at > 0) { cv.at--; save(); render(); } });
  $("cvNext").addEventListener("click", () => { if (cv && cv.at < cv.versions.length - 1) { cv.at++; save(); render(); } });
  $("cvViews").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view); });
  $("cvClose").addEventListener("click", close);
  $("cvCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(cur().text); $("cvNote").textContent = "Copied"; } catch {}
  });
  $("cvDownload").addEventListener("click", () => {
    const ext = EXT[cv.kind] || "txt";
    const name = `${(cv.title || "canvas").replace(/[^\w .-]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "canvas"}.${ext}`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([cur().text], { type: "text/plain" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------- Ask yAI about a selection ----------
  let sel = null;
  function checkSelection() {
    if (!cv || streaming) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    sel = e - s > 1 ? { s, e } : null;
    $("cvAsk").hidden = !sel;
    if (sel) {
      const chips = isDoc(cv.kind) ? ["Shorter", "Longer", "Simpler", "More formal", "Fix grammar"] : ["Fix bugs", "Add comments", "Simplify", "Make it faster"];
      $("cvChips").innerHTML = chips.map((c) => `<button type="button" class="cv-chip">${c}</button>`).join("");
    }
  }
  ta.addEventListener("mouseup", checkSelection);
  ta.addEventListener("keyup", (e) => { if (e.shiftKey || e.key.startsWith("Arrow")) checkSelection(); });
  ta.addEventListener("blur", () => setTimeout(() => { if (!$("cvAsk").contains(document.activeElement)) $("cvAsk").hidden = true; }, 150));
  $("cvChips").addEventListener("click", (e) => { const b = e.target.closest(".cv-chip"); if (b) rewrite(b.textContent); });
  $("cvAskForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("cvAskInput").value.trim(); if (q) rewrite(q); });

  async function rewrite(instruction) {
    if (!sel || !cv) return;
    const text = cur().text, { s, e } = sel;
    const part = text.slice(s, e);
    $("cvAskGo").disabled = true;
    $("cvNote").textContent = "yAI is changing the selection…";
    ta.readOnly = true;
    try {
      const r = await api("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelSel.value, conversationId: chat.id,
          messages: [{ role: "user", content:
            `Rewrite only the selected part of this ${isDoc(cv.kind) ? "document" : `${cv.kind} file`} as asked. Reply with ONLY the new text for that part: ` +
            `no quotes, no code fences, no explanation, and keep it fitting with the text around it.\n\nThe whole text:\n<<<\n${text.slice(0, 40000)}\n>>>\n\n` +
            `The selected part:\n<<<\n${part}\n>>>\n\nWhat to do: ${instruction}` }],
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
      let out = "";
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const evs = buf.split("\n\n");
        buf = evs.pop();
        for (const ev of evs) {
          if (!ev.startsWith("data: ")) continue;
          const m = JSON.parse(ev.slice(6));
          if (m.error) throw new Error(m.error);
          if (m.content) out += m.content;
        }
      }
      out = splitThinking(out).visible.replace(/^\s*```[\w-]*\n?|\n?```\s*$/g, "");
      if (!out.trim()) throw new Error("yAI didn't send anything back");
      // Keep the selection's own leading and trailing whitespace.
      const lead = part.match(/^\s*/)[0], trail = part.match(/\s*$/)[0];
      const next = text.slice(0, s) + lead + out.trim() + trail + text.slice(e);
      addVersion(next, `yAI · ${instruction.slice(0, 40)}`);
      save();
      $("cvAskInput").value = "";
      $("cvAsk").hidden = true;
      render();
      ta.focus();
      ta.setSelectionRange(s, s + lead.length + out.trim().length + trail.length);
    } catch (err) {
      if (!err.locked) $("cvNote").textContent = `Couldn't change it: ${err.message}`;
    } finally {
      $("cvAskGo").disabled = false;
      ta.readOnly = false;
    }
  }

  // ---------- Answers ----------
  // A ```canvas block in the answer being written streams into the canvas; when the answer ends it is a version.
  function cardText(card) { return card.querySelector(".cc-src")?.textContent || ""; }
  window.yaiCanvasAfterFill = (el, visible, done) => {
    const cards = el.querySelectorAll(".canvas-card");
    if (!done) liveEl = el;
    if (!cards.length) { if (done && liveEl === el) liveEl = null; return; }
    if (liveEl !== el) return; // an old answer being redrawn
    const card = cards[cards.length - 1];
    const title = card.dataset.title, kind = card.dataset.kind, text = cardText(card);
    if (!done) {
      if (!cv || cv.title !== title || cv.kind !== kind || !streaming) {
        // the first piece: a new canvas, or a new version of this one
        if (!cv || cv.title !== title || cv.kind !== kind) cv = { title, kind, versions: [{ text, ts: Date.now(), by: "yAI" }], at: 0, open: true };
        else addVersion(text, "yAI");
        streaming = true;
        show();
      }
      cur().text = text;
      render();
      return;
    }
    streaming = false;
    liveEl = null;
    if (!cv || cv.title !== title || cv.kind !== kind) open(title, kind, text, "yAI");
    else { cur().text = text; cur().by = "yAI"; cur().ts = Date.now(); show(); }
    save();
  };
  messagesEl.addEventListener("click", (e) => {
    const openBtn = e.target.closest(".open-canvas");
    if (openBtn) {
      const card = openBtn.closest(".canvas-card");
      return open(card.dataset.title, card.dataset.kind, cardText(card), "yAI");
    }
    const edit = e.target.closest(".to-canvas");
    if (edit) {
      const block = edit.closest(".code");
      const lang = (block.querySelector(".code-head span")?.textContent || "code").toLowerCase();
      open(`${lang === "code" ? "Code" : lang.toUpperCase()} from chat`, lang, block.querySelector("code").textContent, "From the chat");
    }
  });

  // A chat's canvas comes back when the chat is opened (if it was open), and a new chat starts without one.
  window.yaiCanvasAfterHistory = () => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY(chat.id)) || "null"); } catch {}
    if (saved && saved.versions?.length) {
      cv = saved;
      streaming = false;
      if (saved.open) show(); else close();
    } else {
      cv = null;
      close();
    }
  };

  window.yaiCanvas = {
    open, close,
    isOpen: () => !panel.hidden && !!cv,
    toolOn: () => toolOn,
    setTool(v) { toolOn = v; store.set("canvasTool", v); },
    // What goes with a message: the open canvas, or just "use the canvas" when the tool is on.
    payload() {
      if (!panel.hidden && cv) return { canvas: { title: cv.title, kind: cv.kind, text: cur().text } };
      return toolOn ? { canvas: { title: "", kind: "", text: "" } } : {};
    },
  };
})();
