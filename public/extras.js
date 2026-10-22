// The chat page's newer features (2026-10-20), on top of the page's own script: the Tools menu (study mode, canvas,
// calendar and email, voice), searching your chats (Ctrl K), Gmail draft and calendar cards, image editing helpers,
// installing the app, and "what's new" after an update.
(function () {
  // ---------- A small notice at the bottom ----------
  window.toast = function toast(text, { html = false, ms = 4500 } = {}) {
    let box = document.querySelector(".toast");
    if (!box) { box = document.createElement("div"); box.className = "toast"; box.setAttribute("role", "status"); document.body.appendChild(box); }
    box[html ? "innerHTML" : "textContent"] = text;
    box.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => box.classList.remove("show"), ms);
  };

  // ---------- Tools: study mode, canvas, calendar & email, voice ----------
  let studyOn = store.get("studyMode", false);
  let googleOn = store.get("googleMode", false);
  let google = { configured: false, connected: false, email: null };
  const I = {
    study: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l9-4 9 4-9 4z"/><path d="M7 10v5c0 1.5 2.2 3 5 3s5-1.5 5-3v-5"/></svg>',
    canvas: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M13 4v16M16 9h2M16 13h2"/></svg>',
    google: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    research: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h10l4 4v12H5z"/><path d="M9 12h6M9 16h4"/></svg>',
    voice: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>',
  };
  function renderTools() {
    const v = window.yaiVoice?.config() || { voices: [] };
    const sw = (on) => `<span class="switch${on ? " on" : ""}" aria-hidden="true"><i></i></span>`;
    const inChat = mode === "chat";
    $("toolsMenu").innerHTML = `
      ${inChat ? `<button type="button" class="tool-item" data-tool="research" role="menuitemcheckbox" aria-checked="${researchOn}">${I.research}<span><b>Deep research</b><small>Several rounds of searching and reading, then a report with sources</small></span>${sw(researchOn)}</button>` : ""}
      <button type="button" class="tool-item" data-tool="study" role="menuitemcheckbox" aria-checked="${studyOn}">${I.study}<span><b>Study mode</b><small>A tutor: hints and questions instead of answers</small></span>${sw(studyOn)}</button>
      <button type="button" class="tool-item" data-tool="canvas" role="menuitemcheckbox" aria-checked="${yaiCanvas.toolOn()}">${I.canvas}<span><b>Canvas</b><small>Writing and code open in an editor beside the chat</small></span>${sw(yaiCanvas.toolOn())}</button>
      <button type="button" class="tool-item" data-tool="google" role="menuitemcheckbox" aria-checked="${googleOn && google.connected}">${I.google}<span><b>Calendar and email</b><small>${google.connected ? `Reads ${escapeHtml(google.email || "your Google account")}; drafts need your OK` : google.configured ? "Connect Google to use it" : "Not set up on this site yet"}</small></span>${google.connected ? sw(googleOn) : google.configured ? '<span class="tool-link">Connect</span>' : ""}</button>
      ${v.voices.length ? `<div class="tool-voice">${I.voice}<span><b>Voice</b><small>For Listen and voice chat</small></span><select id="voicePick" aria-label="Voice">${v.voices.map((x) => `<option value="${escapeHtml(x.id)}"${x.id === yaiVoice.voiceId() ? " selected" : ""}>${escapeHtml(x.name)}</option>`).join("")}</select><button type="button" class="btn-ghost" id="voiceTry">Try</button></div>` : ""}`;
    $("toolPills").innerHTML = [
      researchOn && mode === "chat" && `<button type="button" class="mode-btn tool-pill" data-off="research" aria-pressed="true" title="Turn off deep research">${I.research}<span>Research</span></button>`,
      studyOn && `<button type="button" class="mode-btn tool-pill" data-off="study" aria-pressed="true" title="Turn off study mode">${I.study}<span>Study</span></button>`,
      yaiCanvas.toolOn() && `<button type="button" class="mode-btn tool-pill" data-off="canvas" aria-pressed="true" title="Turn off canvas">${I.canvas}<span>Canvas</span></button>`,
      googleOn && google.connected && `<button type="button" class="mode-btn tool-pill" data-off="google" aria-pressed="true" title="Turn off calendar and email">${I.google}<span>Google</span></button>`,
    ].filter(Boolean).join("");
    $("toolsBtn").classList.toggle("has-on", !!$("toolPills").innerHTML);
  }
  function setTool(name, on) {
    if (name === "research") { if (researchOn !== on) $("researchMode").click(); }
    if (name === "study") { studyOn = on; store.set("studyMode", on); }
    if (name === "canvas") yaiCanvas.setTool(on);
    if (name === "google") {
      if (!google.connected) { if (google.configured) location.href = "/api/hub?op=google-connect"; return; }
      googleOn = on; store.set("googleMode", on);
    }
    renderTools();
  }
  // The phone app's tools sheet (mobile.js) reads and sets these too.
  window.yaiTools = {
    state: () => ({ study: studyOn, canvas: yaiCanvas.toolOn(), google: googleOn && google.connected, googleConnected: google.connected, googleConfigured: google.configured }),
    set: setTool,
  };
  $("toolsBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $("toolsMenu").hidden;
    renderTools();
    $("toolsMenu").hidden = !open;
    $("toolsBtn").setAttribute("aria-expanded", String(open));
  });
  $("toolsMenu").addEventListener("click", (e) => {
    const b = e.target.closest(".tool-item");
    if (b) setTool(b.dataset.tool, b.getAttribute("aria-checked") !== "true");
    if (e.target.id === "voiceTry") yaiVoice.preview($("voicePick").value);
  });
  $("toolsMenu").addEventListener("change", (e) => { if (e.target.id === "voicePick") yaiVoice.setVoice(e.target.value); });
  $("toolPills").addEventListener("click", (e) => { const b = e.target.closest("[data-off]"); if (b) setTool(b.dataset.off, false); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#tools")) { $("toolsMenu").hidden = true; $("toolsBtn").setAttribute("aria-expanded", "false"); } });

  // What goes with each message (the page's send() adds it to the request).
  window.yaiChatExtras = () => ({
    ...(studyOn && { study: true }),
    ...(googleOn && google.connected && { google: true }),
    ...yaiCanvas.payload(),
  });

  // ---------- Google: connect, cards ----------
  async function loadGoogle() {
    try {
      const r = await fetch("/api/hub?op=google", { cache: "no-store" });
      if (r.ok) google = await r.json();
    } catch {}
    $("googleBtn").textContent = google.connected ? `Disconnect Google (${google.email || "connected"})` : "Connect Google";
    $("googleBtn").hidden = !google.configured && !google.connected;
    renderTools();
  }
  $("googleBtn").addEventListener("click", async () => {
    $("accountMenu").hidden = true;
    if (!google.connected) { location.href = "/api/hub?op=google-connect"; return; }
    if (!confirm("Disconnect your Google account from yAI?")) return;
    await fetch("/api/hub?op=google", { method: "DELETE" }).catch(() => {});
    googleOn = false;
    store.set("googleMode", false);
    await loadGoogle();
    toast("Google disconnected.");
  });
  messagesEl.addEventListener("click", async (e) => {
    const b = e.target.closest(".g-save");
    if (!b || b.disabled) return;
    const card = b.closest(".g-card");
    const g = JSON.parse(card.dataset.g || "{}");
    b.disabled = true;
    b.textContent = "Saving…";
    try {
      const isDraft = card.dataset.kind === "draft";
      const r = await api(`/api/hub?op=${isDraft ? "google-draft" : "google-event"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isDraft ? { to: g.to, subject: g.subject, body: g.body, replyTo: g["reply-to"] } : { title: g.title, start: g.start, end: g.end, location: g.location, description: g.body }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't save it");
      b.outerHTML = `<a class="btn-ghost g-done" href="${escapeHtml(d.url || "#")}" target="_blank" rel="noopener">${isDraft ? "Saved · open Gmail drafts" : "Added · open in Calendar"}</a>`;
    } catch (err) {
      b.disabled = false;
      b.textContent = "Try again";
      if (!err.locked) toast(err.message);
    }
  });

  // ---------- Search your chats (Ctrl K) ----------
  const dlg = $("searchDialog"), sIn = $("searchInput"), sOut = $("searchResults");
  let sTimer = null, sSeq = 0, sItems = [], sAt = 0;
  const mark = (text, words) => {
    let html = escapeHtml(text);
    for (const w of words) html = html.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    return html;
  };
  const when = (iso) => { const d = new Date(iso); return Date.now() - d < 864e5 ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }); };
  function openSearch() {
    if (!user) return;
    if (!dlg.open) dlg.showModal();
    sIn.select();
    if (!sIn.value) showRecent();
  }
  function showRecent() {
    sItems = chatList.slice(0, 8).map((c) => ({ id: c.id }));
    sAt = 0;
    sOut.innerHTML = chatList.length ? `<div class="sr-label">Recent</div>` + chatList.slice(0, 8).map((c, i) =>
      `<button type="button" class="sr-item${i === 0 ? " on" : ""}" data-i="${i}"><b>${escapeHtml(c.title)}</b><small>${when(c.updatedAt)}</small></button>`).join("") : '<p class="sr-empty">No chats yet.</p>';
  }
  async function runSearch() {
    const q = sIn.value.trim();
    if (!q) return showRecent();
    const seq = ++sSeq;
    sOut.classList.add("loading");
    try {
      const r = await fetch(`/api/hub?op=search-chats&q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const d = await r.json();
      if (seq !== sSeq) return;
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      sItems = [];
      sOut.innerHTML = (d.results || []).length ? d.results.map((c) => {
        const rows = c.hits.length ? c.hits : [{ i: null, snippet: "" }];
        return `<div class="sr-chat"><div class="sr-title"><span>${mark(c.title, words)}</span><small>${when(c.updatedAt)}</small></div>` + rows.map((h) => {
          sItems.push({ id: c.id, i: h.i });
          return `<button type="button" class="sr-item" data-i="${sItems.length - 1}">${h.snippet ? `<span class="sr-who">${h.role === "user" ? "You" : "yAI"}</span><span>${mark(h.snippet, words)}</span>` : "<span>Open this chat</span>"}</button>`;
        }).join("") + "</div>";
      }).join("") : `<p class="sr-empty">Nothing found for “${escapeHtml(q)}”.</p>`;
      sAt = 0;
      sOut.querySelector(".sr-item")?.classList.add("on");
    } catch {
      if (seq === sSeq) sOut.innerHTML = '<p class="sr-empty">Couldn\'t search right now.</p>';
    } finally {
      if (seq === sSeq) sOut.classList.remove("loading");
    }
  }
  async function pick(n) {
    const it = sItems[n];
    if (!it) return;
    dlg.close();
    await openChat(it.id);
    if (it.i == null) return;
    // The message's place on the page: hidden messages (data analysis follow-ups) aren't drawn.
    let k = -1;
    for (let j = 0; j <= it.i && j < chat.history.length; j++) if (!(chat.history[j].role === "user" && chat.history[j].hidden)) k++;
    const el = messagesEl.children[k];
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 2200); }
  }
  sIn.addEventListener("input", () => { clearTimeout(sTimer); sTimer = setTimeout(runSearch, 220); });
  sIn.addEventListener("keydown", (e) => {
    const items = [...sOut.querySelectorAll(".sr-item")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sAt = Math.max(0, Math.min(items.length - 1, sAt + (e.key === "ArrowDown" ? 1 : -1)));
      items.forEach((b, i) => b.classList.toggle("on", i === sAt));
      items[sAt]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); pick(Number(items[sAt]?.dataset.i)); }
  });
  sOut.addEventListener("click", (e) => { const b = e.target.closest(".sr-item"); if (b) pick(Number(b.dataset.i)); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k" && !$("shell").hidden) { e.preventDefault(); openSearch(); }
  });
  $("sideSearch").addEventListener("click", openSearch);
  $("railSearch").addEventListener("click", openSearch);

  // ---------- Image editing ----------
  const IDEAS = ["Remove the background", "Make it a watercolor painting", "Turn it into winter, with snow", "Make it look like a film photo", "Add soft golden-hour light", "Make it a cartoon"];
  function updateIdeas() {
    const photo = pending.some((p) => p.kind === "image" && p.status === "ready");
    const show = mode === "image" && photo && features.imageEdit;
    $("editIdeas").hidden = !show;
    if (show && !$("editIdeas").children.length) $("editIdeas").innerHTML = IDEAS.map((t) => `<button type="button" class="edit-idea">${t}</button>`).join("");
  }
  $("editIdeas").addEventListener("click", (e) => {
    const b = e.target.closest(".edit-idea");
    if (!b) return;
    input.value = b.textContent;
    autosize();
    input.focus();
  });
  window.yaiAfterMode = () => { updateIdeas(); renderTools(); };
  $("webMode").addEventListener("click", () => setTimeout(renderTools));
  $("researchMode").addEventListener("click", () => setTimeout(renderTools));
  window.yaiAfterTray = updateIdeas;
  // An Edit button on each made image (the image becomes the photo to change), and before/after on an edit.
  window.yaiAfterMedia = (el, m) => {
    if (!m.image || !features.imageEdit) return;
    const actions = el.querySelector(".actions");
    if (!actions.querySelector(".edit-img")) {
      actions.querySelector(".download")?.insertAdjacentHTML("afterend",
        '<button type="button" class="action edit-img" title="Change this image"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span>Edit</span></button>');
    }
    // Before/after: the photo that was edited is the user's attachment just above.
    const prev = el.previousElementSibling;
    const before = prev?.classList.contains("user") && prev.querySelector(".att-img")?.getAttribute("src");
    const fig = el.querySelector(".gen-media");
    if (before && fig && !fig.querySelector(".compare")) {
      fig.insertAdjacentHTML("beforeend", `<div class="compare" hidden><img src="${escapeHtml(before)}" alt="Before"><b></b><input type="range" min="0" max="100" value="50" aria-label="Before and after"></div>`);
      actions.querySelector(".edit-img")?.insertAdjacentHTML("afterend", '<button type="button" class="action compare-btn"><span>Before / after</span></button>');
    }
  };
  messagesEl.addEventListener("click", async (e) => {
    const ed = e.target.closest(".edit-img");
    if (ed) {
      const src = ed.closest(".msg").querySelector(".gen-media img")?.src;
      if (!src || controller) return;
      try {
        const blob = await (await fetch(src)).blob();
        setMode("image");
        pending = pending.filter((p) => p.kind !== "image");
        addFiles([new File([blob], "yai-image.jpg", { type: blob.type || "image/jpeg" })]);
        input.placeholder = "Say how to change this image";
        input.focus();
      } catch { toast("Couldn't load that image to edit."); }
      return;
    }
    const cmp = e.target.closest(".compare-btn");
    if (cmp) {
      const box = cmp.closest(".msg").querySelector(".compare");
      box.hidden = !box.hidden;
      cmp.classList.toggle("on", !box.hidden);
    }
  });
  messagesEl.addEventListener("input", (e) => {
    if (e.target.matches(".compare input")) e.target.closest(".compare").style.setProperty("--pos", `${e.target.value}%`);
  });

  // ---------- Hooks from the page ----------
  window.yaiAfterFill = (el, visible, done) => {
    if (done) window.yaiViz?.render(el);
    window.yaiCanvasAfterFill?.(el, visible, done);
    window.yaiVoiceAfterFill?.(el, visible, done);
    window.yaiAnswerTools?.(el, visible, done); // Check, Another answer, Slides (answers.js)
  };
  window.yaiAfterHistory = () => window.yaiCanvasAfterHistory?.();

  // ---------- Install the app (PWA) ----------
  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  let installEvt = null;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("installBtn").hidden = false; });
  if (ios && !standalone) $("installBtn").hidden = false;
  $("installBtn").addEventListener("click", async () => {
    $("accountMenu").hidden = true;
    if (installEvt) {
      installEvt.prompt();
      const { outcome } = await installEvt.userChoice;
      if (outcome === "accepted") $("installBtn").hidden = true;
      installEvt = null;
    } else if (ios) toast("In Safari, tap the Share button, then <b>Add to Home Screen</b>.", { html: true, ms: 8000 });
  });
  addEventListener("appinstalled", () => { $("installBtn").hidden = true; toast("yAI is installed. Find it on your home screen."); });

  // ---------- What's new (once after an update) ----------
  async function whatsNew() {
    try {
      const log = await (await fetch("/changelog.json", { cache: "no-cache" })).json();
      const latest = log.releases[0];
      const seen = store.get("seenRelease", null);
      store.set("seenRelease", latest.version);
      if (!seen || seen === latest.version) return; // first visit: nothing to compare with
      toast(`<b>What's new in yAI ${escapeHtml(latest.version)}</b><ul>${latest.items.slice(0, 4).map((x) => `<li>${escapeHtml(x.title)}</li>`).join("")}</ul><a href="/changelog">See everything</a>`, { html: true, ms: 12000 });
    } catch {}
  }

  // ---------- Start ----------
  const p = new URLSearchParams(location.search);
  const g = p.get("google");
  if (g) {
    history.replaceState(null, "", "/");
    if (g === "connected") { googleOn = true; store.set("googleMode", true); }
    setTimeout(() => toast(g === "connected" ? "Google connected. Calendar and email is on in Tools." : g === "cancelled" ? "Google wasn't connected." : "Couldn't connect Google. Try again."), 800);
  }
  // Links that do something (2026-10-21, widgets and app shortcuts): ?q=… asks it at once, ?voice=1 opens voice chat.
  const askNow = p.get("q"), voiceNow = p.get("voice");
  if (askNow || voiceNow) history.replaceState(null, "", "/");
  // Signed in (the page's start finished): the per-account parts.
  (async function waitForUser(n = 0) {
    if (!user) { if (n < 40) setTimeout(() => waitForUser(n + 1), 500); return; }
    if (askNow) setTimeout(() => { const i = $("input"); i.value = askNow.slice(0, 4000); i.dispatchEvent(new Event("input", { bubbles: true })); $("send")?.click(); }, 300);
    if (voiceNow) setTimeout(() => $("voiceBtn")?.click(), 400);
    loadGoogle();
    window.yaiVoice?.load();
    whatsNew();
  })();
  renderTools();
})();
