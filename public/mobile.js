// yAI as a phone app (2026-10-21, Claude Design "yAI Mobile App"): on a phone, signed in, the chat page becomes an
// app with three tabs (Chats, Projects, You), a chat screen with its own top bar and no tabs, bottom sheets for
// the model and the tools, a full-screen live preview, swipe-from-the-edge to go back, and the phone's back button.
// Desktop is untouched: everything here only runs while <body> has the m-app class.
(function () {
  const PHONE = matchMedia("(max-width: 700px)");
  // The desktop page puts the cursor back in the message box after nearly every button (a tool, a mode, a project).
  // On a phone that pops the keyboard over what you were doing, so there only a tap on the box, or a suggestion that
  // starts the message for you (focusInput), opens it.
  const box = document.getElementById("input");
  const realFocus = box.focus.bind(box);
  box.focus = (...a) => { if (!document.body.classList.contains("m-app")) realFocus(...a); };
  const focusInput = () => realFocus();
  const esc = (s) => escapeHtml(String(s ?? ""));
  const ico = (d, size = 22, sw = 1.8) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const I = {
    chat: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z",
    folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",

    you: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0",
    search: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13M20 20l-4.2-4.2",
    image: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1M4 16l5-5 9 9",
    video: "M4 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1M15 10l6-3v10l-6-3",
    camera: "M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1M12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7",
    file: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5",
    code: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14",
    research: "M5 4h10l4 4v12H5zM9 12h6M9 16h4",
    study: "M3 8l9-4 9 4-9 4zM7 10v5c0 1.5 2.2 3 5 3s5-1.5 5-3v-5",
    canvas: "M3 4h18v16H3zM13 4v16M16 9h2M16 13h2",
    calendar: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4",
    voice: "M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4",
    back: "M15 5l-7 7 7 7",
    chev: "M9 6l6 6-6 6",
    down: "M6 9l6 6 6-6",
    plus: "M12 5v14M5 12h14",
    x: "M6 6l12 12M18 6L6 18",
    gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    more: "",
    trash: "M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3",
    open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    reload: "M4 12a8 8 0 0 1 14-5.3M18 3v4h-4",
  };
  const DOTS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
  const buzz = () => { try { navigator.vibrate?.(8); } catch {} };

  let built = false;
  let view = "home";      // home | projects | project | you | settings | chat
  let lastTab = "home";
  let pushed = false;     // the chat screen added a history entry (the phone's back button returns)
  let openProjectId = null;
  let usage = null, usageAt = 0;

  // ---------- theme (Settings > Theme): light, dark or the system's ----------
  const THEME_KEY = "yaiTheme";
  function applyTheme(t = (() => { try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; } })()) {
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", dark ? "#141413" : "#f8f8f6"));
  }
  applyTheme();
  const theme = () => { try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; } };

  // ---------- helpers ----------
  const when = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    if (d >= new Date(new Date().setHours(0, 0, 0, 0))) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (Date.now() - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const initials = (u) => String(u || "?").slice(0, 2).toUpperCase();
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
  const modelLabel = () => modelSel.selectedOptions[0]?.textContent || "Model";
  const modelTag = (o) => (o.dataset.price || /^(kimi|deepseek|qwen3.8)/.test(o.value) ? "Hosted" : o.dataset.cloud ? "Cloud GPU" : "Your PC");
  async function loadUsage(force) {
    if (!force && usage && Date.now() - usageAt < 60000) return usage;
    try {
      const r = await fetch("/api/hub?op=usage", { cache: "no-store" });
      if (r.ok) { usage = await r.json(); usageAt = Date.now(); }
    } catch {}
    return usage;
  }

  // ---------- the app's own screens ----------
  function build() {
    built = true;
    document.body.insertAdjacentHTML("beforeend", `
      <div id="mApp" aria-label="yAI">
        <section class="m-view" id="mHome"></section>
        <section class="m-view" id="mProjects"></section>
        <section class="m-view" id="mProject"></section>
        <section class="m-view" id="mYou"></section>
        <section class="m-view" id="mSettings"></section>
      </div>
      <nav id="mTabs" aria-label="yAI">
        <button type="button" data-tab="home">${ico(I.chat, 23)}<span>Chats</span></button>
        <button type="button" data-tab="projects">${ico(I.folder, 23)}<span>Projects</span></button>

        <button type="button" data-tab="you">${ico(I.you, 23)}<span>You</span></button>
      </nav>
      <div id="mSheet" hidden><button type="button" class="m-scrim" aria-label="Close"></button><div class="m-sheet" role="dialog" aria-modal="true"><span class="m-grab"></span><div id="mSheetBody"></div></div></div>
      <input type="file" id="mCamera" accept="image/*" capture="environment" hidden />`);

    // The chat screen's top bar, the empty-chat greeting, and the composer's tool pills
    $("app").insertAdjacentHTML("afterbegin", `
      <header id="mChatTop">
        <button type="button" class="m-icon" id="mBack" aria-label="Back to chats">${ico(I.back, 22, 1.9)}</button>
        <button type="button" class="m-title" id="mModelBtn"><b id="mTitle">New chat</b><span><i></i><em id="mModelName"></em>${ico(I.down, 11, 2.4)}</span></button>
        <button type="button" class="m-icon" id="mMore" aria-label="More">${DOTS}</button>
      </header>`);
    $("welcome").insertAdjacentHTML("beforeend", `<div id="mGreet"><h2 id="mHello"></h2><p>What are we working on?</p><div class="m-suggest">
      <button type="button" data-s="search"><span>${ico(I.search, 16)}</span><div><b>Search the web</b><small>Latest news, prices, anything recent</small></div></button>
      <button type="button" data-s="image"><span>${ico(I.image, 16)}</span><div><b>Make an image</b><small>A cosy reading nook, morning light</small></div></button>
      <button type="button" data-s="code"><span>${ico(I.code, 16)}</span><div><b>Write some code</b><small>A script, a page, a fix</small></div></button>
    </div></div>`);
    $("attach").insertAdjacentHTML("afterend", '<span id="mPills"></span>');
    // Live preview: Preview / Code, and Reload / Open in browser at the bottom
    $("previewClose").insertAdjacentHTML("beforebegin", '<div class="m-seg" id="mPrevSeg"><button type="button" data-v="preview" aria-pressed="true">Preview</button><button type="button" data-v="code" aria-pressed="false">Code</button></div>');
    $("previewDialog").insertAdjacentHTML("beforeend", `<pre id="mPrevCode" hidden></pre><div id="mPrevBar"><button type="button" id="mPrevReload">${ico(I.reload, 17)}Reload</button><button type="button" id="mPrevOpen" class="m-primary">${ico(I.open, 16, 2)}Open in browser</button></div>`);

    wire();
  }

  function wire() {
    $("mTabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab]");
      if (!b || b.tagName === "A") return;
      buzz();
      setView(b.dataset.tab);
    });
    $("mBack").addEventListener("click", goBack);
    $("mModelBtn").addEventListener("click", modelSheet);
    $("mMore").addEventListener("click", moreSheet);
    $("mSheet").querySelector(".m-scrim").addEventListener("click", closeSheet);
    $("mGreet").addEventListener("click", (e) => {
      const b = e.target.closest("[data-s]");
      if (!b) return;
      buzz();
      if (b.dataset.s === "search") { if (mode !== "chat") setMode("chat"); if (!webSearch) $("webMode").click(); input.placeholder = "Ask about anything recent"; }
      else if (b.dataset.s === "image" && !$("imageMode").hidden) setMode("image");
      else if (b.dataset.s === "code") { input.value = "Write "; autosize(); }
      renderPills();
      if (b.dataset.s === "code") focusInput();
    });
    $("mPills").addEventListener("click", (e) => {
      const b = e.target.closest("[data-off]");
      if (!b) return;
      if (b.dataset.off === "search") $("webMode").click();
      else setMode("chat");
      renderPills();
    });
    // The + button opens the tools sheet on the phone (the page's own attach handler runs on desktop).
    $("attach").addEventListener("click", (e) => {
      if (!on()) return;
      e.stopImmediatePropagation();
      toolsSheet();
    }, true);
    $("mCamera").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
    $("webMode").addEventListener("click", () => setTimeout(renderPills));
    // Preview extras
    $("mPrevSeg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-v]");
      if (!b) return;
      const code = b.dataset.v === "code";
      $("mPrevSeg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      $("mPrevCode").hidden = !code;
      $("mPrevCode").textContent = code ? previewSrc : "";
      $("previewDialog").classList.toggle("m-code", code);
    });
    $("mPrevReload").addEventListener("click", () => showPreview(previewSrc));
    $("mPrevOpen").addEventListener("click", () => { if (previewUrl) window.open(previewUrl, "_blank"); });
    $("previewDialog").addEventListener("close", () => { $("mPrevSeg").querySelector('[data-v="preview"]').click(); });

    // Swipe from the left edge to go back (the chat screen, a project, settings).
    let sx = null, sy = 0, dragging = false;
    addEventListener("touchstart", (e) => {
      if (!on() || e.touches.length !== 1 || !["chat", "project", "settings"].includes(view) || !$("mSheet").hidden) return;
      const t = e.touches[0];
      if (t.clientX > 24) return;
      sx = t.clientX; sy = t.clientY; dragging = false;
    }, { passive: true });
    addEventListener("touchmove", (e) => {
      if (sx === null) return;
      const t = e.touches[0], dx = t.clientX - sx;
      if (!dragging && (Math.abs(t.clientY - sy) > Math.abs(dx) || dx < 8)) return;
      dragging = true;
      document.body.style.setProperty("--m-drag", `${Math.max(0, dx)}px`);
      document.body.classList.add("m-dragging");
    }, { passive: true });
    addEventListener("touchend", (e) => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx;
      sx = null;
      document.body.classList.remove("m-dragging");
      document.body.style.removeProperty("--m-drag");
      if (dragging && dx > 90) goBack();
    });
    addEventListener("popstate", () => {
      if (!on()) return;
      if (!$("mSheet").hidden) { closeSheet(true); return; }
      if (view === "chat" || view === "project" || view === "settings") { pushed = false; setView(view === "settings" ? "you" : view === "project" ? "projects" : lastTab, { fromPop: true }); }
    });
  }

  // ---------- switching screens ----------
  function setView(v, { fromPop = false } = {}) {
    const prev = view;
    view = v;
    if (["home", "projects", "you"].includes(v)) lastTab = v;
    document.body.dataset.mview = v;
    $("mTabs").querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === (v === "project" ? "projects" : v === "settings" ? "you" : v)));
    // Going deeper (a chat, a project, settings) adds a history entry, so the phone's back button comes back.
    const deep = ["chat", "project", "settings"].includes(v);
    if (deep && !fromPop && !pushed) { history.pushState({ mview: v }, ""); pushed = true; }
    if (!deep) pushed = false;
    const el = v === "chat" ? $("app") : $({ home: "mHome", projects: "mProjects", project: "mProject", you: "mYou", settings: "mSettings" }[v]);
    el?.classList.remove("m-in", "m-back");
    void el?.offsetWidth;
    el?.classList.add(deep && prev !== v ? "m-in" : "m-back");
    render();
    if (v === "chat") { renderTop(); renderPills(); }
  }
  function goBack() {
    buzz();
    if (pushed) history.back(); // popstate switches the screen
    else setView(view === "settings" ? "you" : view === "project" ? "projects" : lastTab, { fromPop: true });
  }

  function render() {
    if (!built) return;
    if (view === "home") renderHome();
    else if (view === "projects") renderProjectsView();
    else if (view === "project") renderProject();
    else if (view === "you") renderYou();
    else if (view === "settings") renderSettings();
    $("mHello").textContent = `${greeting()}, ${user || ""}`;
  }

  // ---------- Chats ----------
  function renderHome() {
    const groups = { Today: [], "Previous 7 days": [], Older: [] };
    const now = Date.now(), dayStart = new Date().setHours(0, 0, 0, 0);
    for (const c of chatList) {
      const t = new Date(c.updatedAt).getTime();
      (t >= dayStart ? groups.Today : now - t < 7 * 864e5 ? groups["Previous 7 days"] : groups.Older).push(c);
    }
    const projName = (id) => projects.find((p) => p.id === id)?.name;
    $("mHome").innerHTML = `
      <div class="m-head"><div class="m-logo"><span>y</span><b>AI</b><i></i></div><button type="button" class="m-avatar" data-go="you">${esc(initials(user))}</button></div>
      <h1 class="m-big">Chats</h1>
      <button type="button" class="m-searchbar" id="mSearch">${ico(I.search, 17)}Search chats</button>
      ${projects.length ? `<div class="m-chips">${projects.map((p) => `<button type="button" data-proj="${esc(p.id)}">${ico(I.folder, 15, 1.7)}<span>${esc(p.name)}</span></button>`).join("")}</div>` : ""}
      <div class="m-list">${chatList.length ? Object.entries(groups).filter(([, l]) => l.length).map(([name, l]) => `
        <div class="m-group"><div class="m-label">${name}</div>${l.map((c) => `
          <button type="button" class="m-row" data-chat="${esc(c.id)}"><span class="m-row-top"><b>${esc(c.title)}</b><small>${esc(when(c.updatedAt))}</small></span>${c.projectId && projName(c.projectId) ? `<span class="m-row-sub">${ico(I.folder, 12, 1.8)}${esc(projName(c.projectId))}</span>` : ""}</button>`).join("")}</div>`).join("")
        : '<p class="m-empty">Your chats will show up here. Start one with New chat.</p>'}</div>
      <button type="button" class="m-fab" id="mNew">${ico(I.plus, 19, 2)}New chat</button>`;
  }
  document.addEventListener("click", (e) => {
    if (!on()) return;
    const chatBtn = e.target.closest("#mHome [data-chat], #mProject [data-chat]");
    if (chatBtn) { buzz(); return openChatScreen(chatBtn.dataset.chat); }
    const proj = e.target.closest("[data-proj]");
    if (proj) { buzz(); openProjectId = proj.dataset.proj; return setView("project"); }
    if (e.target.closest("#mNew")) { buzz(); activeProject = null; chat.projectId = undefined; renderProjects(); startNewChat(); return setView("chat"); }
    if (e.target.closest("#mSearch")) return $("sideSearch").click();
    const go = e.target.closest("[data-go]");
    if (go) { buzz(); return setView(go.dataset.go); }
  });
  async function openChatScreen(id) {
    if (id !== chat.id) await openChat(id);
    setView("chat");
  }

  // ---------- the chat screen ----------
  function renderTop() {
    if (!built) return;
    $("mTitle").textContent = chat.history.length ? chatTitle(chat.history) : activeProject ? activeProject.name : "New chat";
    $("mModelName").textContent = modelLabel();
  }
  function renderPills() {
    if (!built) return;
    const pills = [];
    if (mode === "chat" && webSearch) pills.push(["search", I.search, "Search"]);
    if (mode === "image") pills.push(["mode", I.image, "Image"]);
    if (mode === "video") pills.push(["mode", I.video, "Video"]);
    $("mPills").innerHTML = pills.map(([k, icon, l]) => `<button type="button" class="m-pill" data-off="${k}">${ico(icon, 15)}${l}${ico(I.x, 11, 2.4)}</button>`).join("");
  }

  // ---------- bottom sheets ----------
  function openSheet(html, cls = "") {
    $("mSheetBody").innerHTML = html;
    $("mSheet").className = cls;
    $("mSheet").hidden = false;
    document.body.classList.add("m-sheet-open");
    history.pushState({ msheet: 1 }, "");
  }
  function closeSheet(fromPop) {
    if ($("mSheet").hidden) return;
    $("mSheet").classList.add("m-closing");
    setTimeout(() => { $("mSheet").hidden = true; $("mSheet").classList.remove("m-closing"); }, 180);
    document.body.classList.remove("m-sheet-open");
    if (fromPop !== true) history.back();
  }
  // Drag the grab handle (or the sheet's top) down to close it.
  (() => {
    let y0 = null;
    document.addEventListener("touchstart", (e) => {
      const s = e.target.closest(".m-sheet");
      if (!s || s.scrollTop > 0 || e.target.closest("input, button.m-ratio")) return;
      y0 = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (y0 === null) return;
      const dy = Math.max(0, e.touches[0].clientY - y0);
      document.querySelector(".m-sheet").style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    document.addEventListener("touchend", (e) => {
      if (y0 === null) return;
      const dy = e.changedTouches[0].clientY - y0;
      y0 = null;
      const s = document.querySelector(".m-sheet");
      s.style.transform = "";
      if (dy > 90) closeSheet();
    });
  })();

  function modelSheet() {
    buzz();
    const left = usage?.today?.ultra ? Math.max(0, usage.today.ultra.limitUsd - usage.today.ultra.spentUsd) : null;
    openSheet(`<div class="m-sheet-title">Model</div>${[...modelSel.options].map((o) => `
      <button type="button" class="m-model${o.selected ? " on" : ""}" data-model="${esc(o.value)}"${o.disabled ? " disabled" : ""}>
        <span class="m-model-text"><b>${esc(o.textContent)}<em>${modelTag(o)}</em></b><small>${esc(o.dataset.desc || "")}${modelTag(o) === "Hosted" && left !== null ? ` · $${left.toFixed(2)} left today` : ""}</small></span>
        <span class="m-radio">${ico("M5 12.5l4.5 4.5L19 7", 12, 3)}</span>
      </button>`).join("")}`);
    loadUsage();
    $("mSheetBody").onclick = (e) => {
      const b = e.target.closest("[data-model]");
      if (!b || b.disabled) return;
      buzz();
      if (b.dataset.model !== modelSel.value) {
        modelSel.value = b.dataset.model;
        modelSel.dispatchEvent(new Event("change"));
        buildModelMenu();
      }
      renderTop();
      if (view === "settings") renderSettings();
      closeSheet();
    };
  }

  function toolsSheet() {
    buzz();
    const draw = () => {
      const t = usage?.today;
      const left = (x) => (x && x.limit ? `${Math.max(0, x.limit - x.used)} of ${x.limit} left today` : "");
      const T = window.yaiTools?.state() || {};
      const sw = (v) => `<span class="m-switch${v ? " on" : ""}"><i></i></span>`;
      const row = (key, icon, l, d, v, extra = "") => `<button type="button" class="m-tool${v ? " on" : ""}" data-tool="${key}"><span class="m-tool-ic">${ico(icon, 18)}</span><span class="m-tool-text"><b>${l}</b><small>${d}</small></span>${sw(v)}</button>${extra}`;
      const ratios = mode === "image" ? `<div class="m-ratios">${["1:1", "16:9", "9:16"].map((r) => `<button type="button" class="m-ratio${aspect.image === r ? " on" : ""}" data-ratio="${r}"><i class="r${r.replace(":", "x")}"></i>${r}</button>`).join("")}</div>` : "";
      $("mSheetBody").innerHTML = `
        <div class="m-attach">
          <button type="button" data-attach="camera">${ico(I.camera, 22, 1.7)}Camera</button>
          <button type="button" data-attach="photos">${ico(I.image, 22, 1.7)}Photos</button>
          <button type="button" data-attach="files">${ico(I.file, 22, 1.7)}Files</button>
        </div>
        ${row("search", I.search, "Search the web", left(t?.searches) || "Answers with sources", mode === "chat" && webSearch)}
        ${row("research", I.research, "Deep research", "Several rounds of searching, then a report", researchOn)}
        ${!$("imageMode").hidden ? row("image", I.image, "Make image", left(t?.images) || "Describe it, or attach a photo to edit", mode === "image", ratios) : ""}
        ${!$("videoMode").hidden ? row("video", I.video, "Make video", left(t?.videos) || "A short clip with sound", mode === "video") : ""}
        ${row("study", I.study, "Study mode", "Hints and questions instead of answers", T.study)}
        ${row("canvas", I.canvas, "Canvas", "Writing and code in an editor", T.canvas)}
        ${T.googleConfigured || T.googleConnected ? row("google", I.calendar, "Calendar and email", T.googleConnected ? "Your Google calendar and inbox" : "Connect Google to use it", T.google) : ""}
        <button type="button" class="m-tool" data-tool="voice"><span class="m-tool-ic">${ico(I.voice, 18)}</span><span class="m-tool-text"><b>Voice chat</b><small>Talk with yAI hands-free</small></span>${ico(I.chev, 16, 2)}</button>`;
    };
    openSheet("", "m-tools");
    draw();
    loadUsage().then(() => { if (!$("mSheet").hidden) draw(); });
    $("mSheetBody").onclick = (e) => {
      const a = e.target.closest("[data-attach]");
      if (a) {
        closeSheet();
        if (a.dataset.attach === "camera") return $("mCamera").click();
        const fi = $("fileInput");
        if (a.dataset.attach === "photos") { const old = fi.accept; fi.accept = "image/*"; fi.click(); setTimeout(() => (fi.accept = old), 1000); }
        else fi.click();
        return;
      }
      const r = e.target.closest("[data-ratio]");
      if (r) { buzz(); aspect.image = r.dataset.ratio; updateAspectPick(); return draw(); }
      const b = e.target.closest("[data-tool]");
      if (!b) return;
      buzz();
      const k = b.dataset.tool;
      if (k === "search") { if (mode !== "chat") setMode("chat"); $("webMode").click(); }
      else if (k === "research") { if (mode !== "chat") setMode("chat"); $("researchMode").click(); }
      else if (k === "image") setMode(mode === "image" ? "chat" : "image");
      else if (k === "video") setMode(mode === "video" ? "chat" : "video");
      else if (k === "voice") { closeSheet(); return setTimeout(() => $("voiceBtn").click(), 200); }
      else { const st = window.yaiTools.state(); window.yaiTools.set(k, !st[k]); }
      renderPills();
      draw();
    };
  }

  function moreSheet() {
    buzz();
    const saved = chatList.some((c) => c.id === chat.id);
    openSheet(`
      <button type="button" class="m-action" data-act="new">${ico(I.plus, 19)}New chat</button>
      <button type="button" class="m-action" data-act="search">${ico(I.search, 19)}Search chats</button>
      <button type="button" class="m-action" data-act="voice">${ico(I.voice, 19)}Voice chat</button>
      ${saved ? `<button type="button" class="m-action m-danger" data-act="delete">${ico(I.trash, 19)}Delete this chat</button>` : ""}`);
    $("mSheetBody").onclick = (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      closeSheet();
      const act = b.dataset.act;
      setTimeout(() => {
        if (act === "new") { startNewChat(); renderTop(); }
        else if (act === "search") $("sideSearch").click();
        else if (act === "voice") $("voiceBtn").click();
        else if (act === "delete") { const id = chat.id; deleteChat(id).then(() => { if (!chatList.some((c) => c.id === id)) goBack(); }); }
      }, 200);
    };
  }

  // ---------- Projects ----------
  function renderProjectsView() {
    const chatsIn = (id) => chatList.filter((c) => c.projectId === id).length;
    $("mProjects").innerHTML = `
      <div class="m-head m-head-big"><h1 class="m-big">Projects</h1><button type="button" class="m-round" id="mProjNew" aria-label="New project">${ico(I.plus, 19, 2)}</button></div>
      <div class="m-cards">${projects.length ? projects.map((p) => `
        <button type="button" class="m-card" data-proj="${esc(p.id)}">
          <span class="m-card-top"><span class="m-card-ic">${ico(I.folder, 17, 1.7)}</span><b>${esc(p.name)}</b><small>${esc(when(p.updatedAt))}</small></span>
          <span class="m-card-meta">${chatsIn(p.id)} chat${chatsIn(p.id) === 1 ? "" : "s"} · ${p.files || 0} file${p.files === 1 ? "" : "s"}</span>
        </button>`).join("") : '<p class="m-empty">Projects keep files and instructions together, so every chat in one already knows them.</p>'}</div>`;
    $("mProjNew").onclick = () => openProjectDialog(null);
  }
  let projDetail = null;
  async function renderProject() {
    const p = projects.find((x) => x.id === openProjectId);
    if (!p) return setView("projects");
    const chats = chatList.filter((c) => c.projectId === p.id);
    const draw = (d) => {
      $("mProject").innerHTML = `
        <div class="m-nav"><button type="button" class="m-backlink" data-go="projects">${ico(I.back, 22, 1.9)}Projects</button><button type="button" class="m-link" id="mProjEdit">Edit</button></div>
        <div class="m-proj-head"><h1>${esc(p.name)}</h1><small>${chats.length} chat${chats.length === 1 ? "" : "s"} · ${p.files || 0} file${p.files === 1 ? "" : "s"}</small></div>
        <div class="m-sections">
          ${d?.instructions ? `<div><div class="m-label">Instructions</div><div class="m-box m-clamp">${esc(d.instructions)}</div></div>` : ""}
          ${d?.files?.length ? `<div><div class="m-label">Files</div><div class="m-files">${d.files.map((f) => `<span class="m-file"><i>${esc((f.name.split(".").pop() || "txt").slice(0, 4).toUpperCase())}</i>${esc(f.name)}</span>`).join("")}</div></div>` : ""}
          <div><div class="m-label">Chats</div>${chats.length ? chats.map((c) => `<button type="button" class="m-row m-row-flat" data-chat="${esc(c.id)}"><span class="m-row-top"><b>${esc(c.title)}</b><small>${esc(when(c.updatedAt))}</small></span></button>`).join("") : '<p class="m-empty">No chats in this project yet.</p>'}</div>
        </div>
        <button type="button" class="m-bigbtn" id="mProjChat">${ico(I.plus, 18, 2)}<span>New chat in ${esc(p.name)}</span></button>`;
      $("mProjEdit").onclick = () => openProjectDialog(p.id);
      $("mProjChat").onclick = () => { buzz(); activeProject = { id: p.id, name: p.name }; startNewChat(); renderProjects(); setView("chat"); };
    };
    draw(projDetail?.id === p.id ? projDetail : null);
    try {
      const r = await fetch(`/api/hub?op=project&id=${encodeURIComponent(p.id)}`, { cache: "no-store" });
      if (r.ok) { projDetail = (await r.json()).project; if (view === "project" && openProjectId === p.id) draw(projDetail); }
    } catch {}
  }

  // ---------- You ----------
  async function renderYou() {
    const draw = (u) => {
      const t = u?.today, days = u?.days || [];
      const msgs = (d) => (d?.messages || 0) + (d?.codeMessages || 0);
      const last14 = days.slice(-14);
      const max = Math.max(4, ...last14.map(msgs));
      const hrs = t ? Math.max(0, Math.round((new Date(t.resetsAt) - Date.now()) / 60000)) : 0;
      const tile = (label, used, limit, fmt = (n) => n, note) => {
        const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
        return `<div class="m-tile${pct >= 80 ? " warn" : ""}"><div class="m-tile-top"><span>${label}</span><span>${note ?? (limit ? `${fmt(Math.max(0, limit - used))} left` : "No limit")}</span></div><div class="m-tile-val"><b>${fmt(used)}</b>${limit ? `<span>of ${fmt(limit)}</span>` : ""}</div><div class="m-meter"><i style="width:${pct}%"></i></div></div>`;
      };
      $("mYou").innerHTML = `
        <div class="m-me"><span class="m-avatar m-avatar-big">${esc(initials(user))}</span><div><b>${esc(user)}</b><small>${isAdmin ? "Admin" : "Member"}${t ? ` · limits reset in ${Math.floor(hrs / 60)} h ${hrs % 60} min` : ""}</small></div><button type="button" class="m-round" data-go="settings" aria-label="Settings">${ico(I.gear, 19)}</button></div>
        ${u ? `<div class="m-panel m-today"><div><span>Messages today</span><b>${msgs(days[days.length - 1])}</b></div><div class="m-spark">${last14.map((d, i) => `<i style="height:${Math.max(4, (msgs(d) / max) * 100)}%"${i === last14.length - 1 ? ' class="now"' : ""}></i>`).join("")}</div></div>
        <div class="m-tiles">
          ${tile("yAI Ultra", Math.round(t.ultra.spentUsd * 100) / 100, t.ultra.limitUsd, (n) => `$${Number(n).toFixed(2)}`, `${Math.round((t.ultra.spentUsd / (t.ultra.limitUsd || 1)) * 100)}%`)}
          ${tile("Images", t.images.used, t.images.limit)}
          ${tile("Videos", t.videos.used, t.videos.limit)}
          ${tile("Searches", t.searches.used, t.searches.limit)}
        </div>
        <a class="m-panel m-linkrow" href="/usage"><span>Full usage history</span>${ico(I.chev, 16, 2)}</a>` : '<p class="m-empty">Loading your usage…</p>'}`;
    };
    draw(usage);
    draw(await loadUsage(true));
  }
  function renderSettings() {
    const T = window.yaiTools?.state() || {};
    const row = (l, right, attrs = "", cls = "") => `<button type="button" class="m-set${cls}" ${attrs}><span>${l}</span>${right}</button>`;
    const chev = ico(I.chev, 16, 2);
    const val = (v) => `<em>${esc(v)}</em>${chev}`;
    const t = theme();
    const install = !$("installBtn").hidden;
    $("mSettings").innerHTML = `
      <div class="m-nav m-nav-center"><button type="button" class="m-backlink" data-go="you">${ico(I.back, 22, 1.9)}You</button><b>Settings</b><span></span></div>
      <div class="m-sections">
        <div><div class="m-label">Chat</div><div class="m-group-box">
          ${row("Model", val(modelLabel()), 'data-set="model"')}
          ${row("Search on by default", `<span class="m-switch${webSearch ? " on" : ""}"><i></i></span>`, 'data-set="search"')}
          ${row("Memory", chev, 'data-set="memory"')}
          ${row("Connections", chev, 'data-set="connections"')}
          ${T.googleConfigured || T.googleConnected ? row("Google calendar and email", val(T.googleConnected ? "Connected" : "Connect"), 'data-set="google"') : ""}
        </div></div>
        <div><div class="m-label">Appearance</div><div class="m-group-box">
          <div class="m-set"><span>Theme</span><span class="m-seg" id="mTheme">${["light", "dark", "system"].map((x) => `<button type="button" data-theme="${x}" aria-pressed="${t === x}">${x[0].toUpperCase() + x.slice(1)}</button>`).join("")}</span></div>
        </div></div>
        <div><div class="m-label">More</div><div class="m-group-box">
          ${row("Study", chev, 'data-href="/study"')}
          ${row("Scheduled tasks", chev, 'data-href="/scheduled"')}
          ${row("Remote (yAI Code on your PC)", chev, 'data-href="/remote"')}
          ${row("yAI Code for your terminal", chev, 'data-set="code"')}
          ${row("API keys", chev, 'data-href="/developers"')}
          ${row("What's new", chev, 'data-href="/changelog"')}
          ${install ? row("Install the app", chev, 'data-set="install"') : ""}
          ${isAdmin ? row("People and limits", chev, 'data-href="/people"') + row("Activity (admin)", chev, 'data-href="/admin"') : ""}
        </div></div>
        <div><div class="m-group-box">
          ${row("Clear chat history", "", 'data-set="clear"', " m-danger")}
          ${row("Sign out", "", 'data-set="logout"', " m-danger")}
        </div></div>
        <p class="m-foot" id="mVersion">yAI</p>
      </div>`;
    fetch("/changelog.json", { cache: "no-cache" }).then((r) => r.json()).then((d) => { if ($("mVersion")) $("mVersion").textContent = `yAI ${d.releases[0].version} · server online`; }).catch(() => {});
  }
  document.addEventListener("click", (e) => {
    if (!on()) return;
    const th = e.target.closest("#mTheme [data-theme]");
    if (th) { buzz(); try { localStorage.setItem(THEME_KEY, th.dataset.theme); } catch {} applyTheme(th.dataset.theme); return renderSettings(); }
    const href = e.target.closest("#mSettings [data-href]");
    if (href) return (location.href = href.dataset.href);
    const s = e.target.closest("#mSettings [data-set]");
    if (!s) return;
    buzz();
    const k = s.dataset.set;
    if (k === "model") modelSheet();
    else if (k === "search") { $("webMode").click(); setTimeout(renderSettings); }
    else if (k === "memory") $("memoryBtn").click();
    else if (k === "connections") window.yaiConnections?.open();
    else if (k === "google") $("googleBtn").click();
    else if (k === "code") $("codeDialog").showModal();
    else if (k === "install") $("installBtn").click();
    else if (k === "clear") $("clearChatsBtn").click();
    else if (k === "logout") $("logoutBtn").click();
  });

  // ---------- the opening logo: shown at least ~1 s, gone once the account is known (or after 3 s) ----------
  let splashGone = false;
  const hideSplash = () => {
    const s = document.getElementById("mSplash");
    if (splashGone || !s) return;
    splashGone = true;
    setTimeout(() => { s.classList.add("out"); setTimeout(() => s.remove(), 400); }, Math.max(0, 1100 - performance.now()));
  };
  setTimeout(hideSplash, 3000);

  // ---------- keeping the screens in step with the page ----------
  const on = () => PHONE.matches && !!user;
  function sync() {
    const active = on();
    document.body.classList.toggle("m-app", active);
    if (!active) return;
    if (!built) {
      build();
      const tab = new URLSearchParams(location.search).get("tab");
      if (tab === "projects" || tab === "you") { history.replaceState(null, "", "/"); setView(tab); }
      else setView(chat.history.length ? "chat" : "home");
    } else render();
    renderTop();
  }
  // The page's own functions, wrapped so the app's screens follow along (they're page globals).
  const after = (name, fn) => {
    const orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function () {
      const out = orig.apply(this, arguments);
      try { fn(out); } catch {}
      return out;
    };
  };
  after("updateAccountUI", () => { sync(); hideSplash(); });
  after("renderChatList", () => { if (on() && (view === "home" || view === "project")) render(); renderTop(); });
  after("renderProjects", () => { if (on() && (view === "projects" || view === "project" || view === "home")) render(); renderTop(); });
  after("renderHistory", () => renderTop());
  after("startNewChat", () => { renderTop(); renderPills(); });
  after("openChat", (p) => Promise.resolve(p).then(() => { if (on() && view !== "chat") setView("chat"); }));
  const prevMode = window.yaiAfterMode;
  window.yaiAfterMode = () => { prevMode?.(); renderPills(); };
  modelSel.addEventListener("change", renderTop);
  PHONE.addEventListener("change", sync);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
  sync();
})();
