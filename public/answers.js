// Under each finished answer (2026-10-21): Check (its facts against the web), Another answer (a second answer from the
// same model, side by side, keep the one you like) and Slides (a deck from the conversation, as PowerPoint or PDF).
// Uses the chat page's own pieces: chat, toApiMessages, renderMarkdown, fillAssistant, saveChat, api, modelSel.
(function () {
  const ICON = {
    check: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    alt: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3" y="5" width="8" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="5" width="8" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    slides: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 16v4M8 20h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };

  // The assistant message's place in chat.history: the k-th message that isn't the user's.
  function entryOf(el) {
    const k = [...messagesEl.querySelectorAll(".msg.assistant")].indexOf(el);
    let seen = -1;
    for (let i = 0; i < chat.history.length; i++) if (chat.history[i].role !== "user" && ++seen === k) return i;
    return -1;
  }
  const questionBefore = (i) => { for (let j = i - 1; j >= 0; j--) if (chat.history[j].role === "user" && !chat.history[j].hidden) return String(chat.history[j].content || ""); return ""; };

  // ---------- the buttons ----------
  window.yaiAnswerTools = (el, visible, done) => {
    const actions = el.querySelector(".actions");
    if (!done || !visible.trim() || !actions || actions.querySelector(".a-check")) return;
    const after = actions.querySelector(".listen") || actions.querySelector(".copy");
    after.insertAdjacentHTML("afterend",
      `<button type="button" class="action a-check" title="Check this answer's facts against the web">${ICON.check}<span>Check</span></button>` +
      `<button type="button" class="action a-alt" title="Another answer from the same model, side by side">${ICON.alt}<span>Another</span></button>` +
      `<button type="button" class="action a-slides" title="Make slides from this conversation">${ICON.slides}<span>Slides</span></button>`);
  };
  messagesEl.addEventListener("click", (e) => {
    const b = e.target.closest(".a-check, .a-alt, .a-slides");
    if (!b || b.disabled) return;
    const el = b.closest(".msg");
    if (b.classList.contains("a-check")) checkThis(el, b);
    else if (b.classList.contains("a-alt")) another(el, b);
    else makeSlides(el, b);
  });

  // ---------- Check this ----------
  const VERDICT = { supported: ["✓", "Supported"], wrong: ["✕", "Looks wrong"], doubtful: ["!", "Doubtful"], unclear: ["?", "Couldn't confirm"] };
  async function checkThis(el, btn) {
    const i = entryOf(el);
    let card = el.querySelector(".fc-card");
    if (card) { card.remove(); return; }
    btn.disabled = true;
    btn.querySelector("span").textContent = "Checking…";
    card = document.createElement("div");
    card.className = "fc-card";
    card.innerHTML = '<div class="fc-head"><span class="searching">Finding the facts and looking them up</span></div>';
    el.querySelector(".actions").before(card);
    try {
      const r = await api("/api/hub?op=factcheck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: questionBefore(i), answer: el.dataset.text || "" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't check it");
      if (!d.results?.length) { card.innerHTML = `<div class="fc-head"><b>Nothing to check</b></div><p class="fc-why">${escapeHtml(d.note || "No facts in this answer could be looked up.")}</p>`; return; }
      const bad = d.results.filter((x) => x.verdict === "wrong").length, iffy = d.results.filter((x) => x.verdict === "doubtful").length;
      const src = (n) => d.sources.find((s) => s.n === n);
      card.innerHTML = `<div class="fc-head"><b>${bad ? `${bad} claim${bad === 1 ? " looks" : "s look"} wrong` : iffy ? "Mostly checks out" : "Checks out"}</b><span>${d.results.length} claim${d.results.length === 1 ? "" : "s"} checked against ${d.sources.length} sources</span></div>` +
        d.results.map((x) => `<div class="fc-row ${x.verdict}"><span class="fc-ico" title="${VERDICT[x.verdict][1]}">${VERDICT[x.verdict][0]}</span><div><div class="fc-claim">${escapeHtml(x.claim)}</div>` +
          `<div class="fc-why"><b>${VERDICT[x.verdict][1]}.</b> ${escapeHtml(x.why || "")}</div>` +
          (x.sources.length ? `<div class="fc-src">${x.sources.map((n) => src(n)).filter(Boolean).map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(s.title)}">${escapeHtml(s.site || "source")}</a>`).join("")}</div>` : "") +
          "</div></div>").join("");
    } catch (err) {
      card.innerHTML = `<div class="fc-head"><b>Couldn't check it</b></div><p class="fc-why">${escapeHtml(err.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.querySelector("span").textContent = "Check";
    }
  }

  // ---------- Another answer, side by side ----------
  async function another(el, btn) {
    const i = entryOf(el);
    if (i < 0 || el.querySelector(".alt-pair")) return;
    const content = el.querySelector(".content");
    const pair = document.createElement("div");
    pair.className = "alt-pair";
    pair.innerHTML = `<div class="alt-col"><div class="alt-h">Answer 1 <span>now</span></div><div class="content alt-a"></div><button type="button" class="btn-ghost alt-keep" data-keep="a">Keep this one</button></div>` +
      `<div class="alt-col"><div class="alt-h">Answer 2 <span>same model</span></div><div class="content alt-b"><div class="typing"><span></span><span></span><span></span></div></div><button type="button" class="btn-primary alt-keep" data-keep="b" disabled>Keep this one</button></div>`;
    pair.querySelector(".alt-a").innerHTML = content.innerHTML;
    content.hidden = true;
    content.after(pair);
    btn.disabled = true;
    const ctl = new AbortController();
    let text = "";
    const finish = (keep) => {
      ctl.abort();
      pair.remove();
      content.hidden = false;
      btn.disabled = false;
      if (keep === "b" && text.trim()) {
        const entry = chat.history[i];
        entry.content = text;
        delete entry.sources;
        fillAssistant(el, text, true, entry.stats, null);
        saveChat();
      }
    };
    pair.addEventListener("click", (e) => { const k = e.target.closest(".alt-keep"); if (k && !k.disabled) finish(k.dataset.keep); });
    try {
      const r = await api("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ messages: toApiMessages(chat.history.slice(0, i)), model: chat.history[i].model || modelSel.value, conversationId: `${chat.id}-alt`, projectId: chat.projectId, autoSearch: false }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't get another answer");
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      const out = pair.querySelector(".alt-b");
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const p of parts) {
          if (!p.startsWith("data: ")) continue;
          const m = JSON.parse(p.slice(6));
          if (m.error) throw new Error(m.error);
          if (m.content) { text += m.content; out.innerHTML = renderMarkdown(text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "")); }
        }
      }
      text = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
      pair.querySelector('[data-keep="b"]').disabled = !text;
      window.yaiViz?.render(pair);
    } catch (err) {
      if (ctl.signal.aborted) return;
      pair.querySelector(".alt-b").innerHTML = `<p class="fc-why">${escapeHtml(err.message)}</p>`;
    }
  }

  // ---------- Slides ----------
  let dlg = null, deck = null;
  function slideHtml(s, i) {
    if (i === 0) return `<div class="sl sl-title"><h2>${escapeHtml(deck.title)}</h2>${deck.subtitle ? `<p>${escapeHtml(deck.subtitle)}</p>` : ""}</div>`;
    return `<div class="sl"><h3>${escapeHtml(s.title)}</h3><ul>${s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul></div>`;
  }
  function openDeck() {
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.className = "slides-dialog";
      document.body.appendChild(dlg);
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest(".sd-close")) dlg.close();
        else if (e.target.closest(".sd-pptx")) exportPptx(e.target.closest(".sd-pptx"));
        else if (e.target.closest(".sd-pdf")) exportPdf();
      });
    }
    const all = [{ title: deck.title }, ...deck.slides];
    dlg.innerHTML = `<div class="sd-head"><div><b>${escapeHtml(deck.title)}</b><small>${deck.slides.length + 1} slides</small></div>` +
      `<button type="button" class="btn-primary sd-pptx">PowerPoint</button><button type="button" class="btn-ghost sd-pdf">PDF</button><button type="button" class="btn-ghost sd-close" aria-label="Close">✕</button></div>` +
      `<div class="sd-body">${all.map((s, i) => `<figure class="sd-slide">${slideHtml(s, i)}<figcaption>${i + 1}${s.notes ? ` · <span>${escapeHtml(s.notes)}</span>` : ""}</figcaption></figure>`).join("")}</div>`;
    if (!dlg.open) dlg.showModal();
  }
  async function makeSlides(el, btn) {
    const i = entryOf(el);
    btn.disabled = true;
    btn.querySelector("span").textContent = "Making…";
    try {
      const messages = chat.history.slice(0, i + 1).filter((m) => (m.role === "user" && !m.hidden) || (m.role === "assistant" && typeof m.content === "string")).map((m) => ({ role: m.role, content: String(m.content) }));
      const r = await api("/api/hub?op=slides", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't make the slides");
      deck = d.deck;
      openDeck();
    } catch (err) {
      if (!err.locked) toast(err.message);
    } finally {
      btn.disabled = false;
      btn.querySelector("span").textContent = "Slides";
    }
  }
  function loadPptx() {
    if (window.PptxGenJS) return Promise.resolve();
    return new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js";
      s.onload = ok;
      s.onerror = () => no(new Error("Couldn't load the PowerPoint maker."));
      document.head.appendChild(s);
    });
  }
  const fileName = () => (deck.title || "slides").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "slides";
  async function exportPptx(b) {
    b.disabled = true;
    try {
      await loadPptx();
      const p = new PptxGenJS();
      p.layout = "LAYOUT_WIDE";
      const INK = "1B1B1A", ACC = "6D4FD8", MUTED = "6B6A66";
      const t = p.addSlide();
      t.background = { color: "F8F8F6" };
      t.addShape(p.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: ACC } });
      t.addText(deck.title, { x: 0.9, y: 2.4, w: 11.5, h: 1.4, fontSize: 40, bold: true, color: INK, fontFace: "Segoe UI" });
      if (deck.subtitle) t.addText(deck.subtitle, { x: 0.9, y: 3.8, w: 11.5, h: 0.8, fontSize: 20, color: MUTED, fontFace: "Segoe UI" });
      for (const s of deck.slides) {
        const sl = p.addSlide();
        sl.background = { color: "FFFFFF" };
        sl.addShape(p.ShapeType.rect, { x: 0.6, y: 0.55, w: 0.6, h: 0.08, fill: { color: ACC } });
        sl.addText(s.title, { x: 0.6, y: 0.75, w: 12, h: 0.9, fontSize: 30, bold: true, color: INK, fontFace: "Segoe UI" });
        sl.addText(s.bullets.map((x) => ({ text: x, options: { bullet: { indent: 18 } } })), { x: 0.7, y: 1.8, w: 11.8, h: 5, fontSize: 20, color: INK, fontFace: "Segoe UI", valign: "top", paraSpaceAfter: 10 });
        if (s.notes) sl.addNotes(s.notes);
      }
      await p.writeFile({ fileName: `${fileName()}.pptx` });
    } catch (err) {
      toast(err.message);
    } finally {
      b.disabled = false;
    }
  }
  // PDF: the browser's own print, one slide per page, landscape
  function exportPdf() {
    const w = window.open("", "_blank");
    if (!w) return toast("Allow pop-ups to save the PDF.");
    const all = [{ title: deck.title }, ...deck.slides];
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(fileName())}</title><style>
      @page { size: 13.333in 7.5in; margin: 0; } body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; color: #1b1b1a; }
      .sl { width: 13.333in; height: 7.5in; box-sizing: border-box; padding: 0.9in 1in; page-break-after: always; position: relative; }
      .sl::before { content: ""; position: absolute; left: 1in; top: 0.6in; width: 0.6in; height: 0.08in; background: #6d4fd8; }
      .sl-title { display: flex; flex-direction: column; justify-content: center; border-left: 0.25in solid #6d4fd8; background: #f8f8f6; }
      .sl-title::before { display: none; } h2 { font-size: 44pt; margin: 0 0 0.2in; } p { font-size: 22pt; color: #6b6a66; margin: 0; }
      h3 { font-size: 32pt; margin: 0 0 0.35in; } li { font-size: 21pt; margin: 0 0 0.16in; }
    </style></head><body>${all.map((s, i) => slideHtml(s, i)).join("")}<script>onload = () => { print(); }<\/script></body></html>`);
    w.document.close();
  }
})();
