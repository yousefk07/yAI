// The yAI sidebar on the pages beside the chat (/usage), so they look and move like the chat page
// (2026-10-20 redesign): projects and chats link into the chat (/?project=…, /?chat=…), the sidebar collapses to a
// rail on desktop and is a drawer on phones. The page provides <div class="shell" id="shell"> with its .app inside,
// a #sideToggle button in its top bar, and <body data-page="usage|study|people|developers|remote|scheduled|changelog">. Exposes window.yaiSide.me (a promise of
// { user, admin }).
(function () {
  const page = document.body.dataset.page || "";
  // The phone app (2026-10-21): the theme chosen in Settings, and the same bottom tabs as the chat page (mobile.css).
  try { const t = localStorage.getItem("yaiTheme"); if (t && t !== "system") document.documentElement.dataset.theme = t; } catch {}
  if (matchMedia("(max-width: 700px)").matches) {
    document.head.insertAdjacentHTML("beforeend", '<link rel="stylesheet" href="/mobile.css" />');
    const tab = (href, key, label, d) => `<a href="${href}"${page === "usage" && key === "you" ? ' class="on"' : ""}><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg><span>${label}</span></a>`;
    document.body.classList.add("m-page");
    const vp = document.querySelector('meta[name="viewport"]');
    if (vp && !/maximum-scale/.test(vp.content)) vp.content += ", maximum-scale=1"; // no pinch or double-tap zoom, like an app
    document.body.insertAdjacentHTML("beforeend", `<nav id="mTabs" aria-label="yAI">${[
      tab("/", "home", "Chats", "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"),
      tab("/?tab=projects", "projects", "Projects", "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"),

      tab("/?tab=you", "you", "You", "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0"),
    ].join("")}</nav>`);
  }
  const shell = document.getElementById("shell");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const I = {
    panel: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>',
    plus: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    folder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    chat: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"/></svg>',
    code: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 10l3 2.5L7 15M13 15h4"/></svg>',
    usage: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 20V11M12 20V4M19 20v-6"/></svg>',
    study: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l9-4 9 4-9 4z"/><path d="M7 10v5c0 1.5 2.2 3 5 3s5-1.5 5-3v-5"/></svg>',
    clock: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 3h6"/></svg>',
    phone: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/></svg>',
  };
  const on = (p) => (page === p ? " active" : "");

  shell.insertAdjacentHTML("afterbegin", `
    <nav id="rail" class="rail" aria-label="Sidebar">
      <a href="/" class="rail-logo" title="New chat">y<i></i></a>
      <button type="button" class="rail-btn toggle" id="railExpand" title="Show sidebar" aria-label="Show sidebar">${I.panel}</button>
      <a href="/" class="rail-btn new" title="New chat" aria-label="New chat">${I.plus}</a>
      <button type="button" class="rail-btn" data-expand title="Projects" aria-label="Projects">${I.folder}</button>
      <button type="button" class="rail-btn" data-expand title="Chats" aria-label="Chats">${I.chat}</button>
      <span class="grow"></span>
      <a class="rail-btn${on("study")}" href="/study" title="Study" aria-label="Study">${I.study}</a>
      <a class="rail-btn${on("usage")}" href="/usage" title="Your usage" aria-label="Your usage">${I.usage}</a>
      <a class="rail-btn" href="/?code=1" title="yAI Code" aria-label="yAI Code">${I.code}</a>
    </nav>
    <aside id="sidebar" class="sidebar" aria-label="Your chats">
      <div class="sidebar-head">
        <a href="/" class="logo-word" title="New chat"><span class="lw"><span>y</span><b>AI</b></span><i></i></a>
        <button type="button" class="icon-btn side-close" id="sideClose" aria-label="Hide sidebar" title="Hide sidebar">${I.panel}</button>
      </div>
      <div class="side-new-wrap"><a class="side-new" href="/">${I.plus}<span>New chat</span></a></div>
      <div class="side-scroll">
        <div><div class="side-label"><span>Projects</span><a class="icon-btn" href="/?newproject=1" title="New project" aria-label="New project">${I.plus}</a></div>
          <nav class="proj-list" id="sideProjects"></nav></div>
        <nav class="chat-list" id="sideChats"></nav>
      </div>
      <div class="side-foot">
        <a class="side-link" href="/?code=1">${I.code}<span class="grow">yAI Code</span><span class="side-tag">CLI</span></a>
        <a class="side-link${on("usage")}" href="/usage">${I.usage}<span class="grow">Your usage</span></a>
        <a class="side-link${on("study")}" href="/study">${I.study}<span class="grow">Study</span></a>
        <a class="side-link${on("scheduled")}" href="/scheduled">${I.clock}<span class="grow">Scheduled</span></a>
        <a class="side-link${on("remote")}" href="/remote">${I.phone}<span class="grow">Remote</span></a>
        <div class="side-me"><span class="avatar" id="sideAvatar"></span><div class="side-me-text"><b id="sideName"></b><small id="sideRole"></small></div></div>
      </div>
    </aside>
    <div class="side-backdrop" id="sideBackdrop" hidden></div>`);
  shell.classList.add("with-sidebar");

  // Collapsing (desktop, remembered like the chat page) and the drawer (phones)
  const $ = (id) => document.getElementById(id);
  const isPhone = () => matchMedia("(max-width: 900px)").matches;
  const collapse = (v) => { shell.classList.toggle("side-collapsed", v); set("sidebarCollapsed", v); };
  collapse(get("sidebarCollapsed", false));
  const openDrawer = () => { shell.classList.add("side-open"); $("sideBackdrop").hidden = false; };
  const closeDrawer = () => { shell.classList.remove("side-open"); $("sideBackdrop").hidden = true; };
  $("sideClose").addEventListener("click", () => (isPhone() ? closeDrawer() : collapse(true)));
  $("railExpand").addEventListener("click", () => collapse(false));
  document.querySelectorAll("[data-expand]").forEach((b) => b.addEventListener("click", () => collapse(false)));
  $("sideBackdrop").addEventListener("click", closeDrawer);
  const toggle = $("sideToggle");
  if (toggle) { toggle.hidden = false; toggle.addEventListener("click", openDrawer); }

  // Who's signed in, their projects and chats
  const me = fetch("/api/auth?action=me", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
  window.yaiSide = { me };
  me.then(async ({ user, admin }) => {
    if (!user) { location.href = "/"; return; }
    for (const el of document.querySelectorAll("#sideAvatar, .page-avatar")) el.textContent = user.slice(0, 2);
    $("sideName").textContent = user;
    $("sideRole").textContent = admin ? "Admin" : "Member";
    const [chats, projects] = await Promise.all([
      fetch("/api/chats", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).then((d) => d.chats || []).catch(() => []),
      fetch("/api/hub?op=projects", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).then((d) => d.projects || []).catch(() => []),
    ]);
    $("sideProjects").innerHTML = projects.length
      ? projects.map((p) => `<div class="chat-item"><a class="chat-open proj-open" href="/?project=${encodeURIComponent(p.id)}">${I.folder}<span class="proj-name">${esc(p.name)}</span><span class="proj-n">${p.files || ""}</span></a></div>`).join("")
      : '<p class="chat-empty">Keep files and instructions for chats about one thing.</p>';
    const groups = { Today: [], "Previous 7 days": [], Older: [] };
    const now = Date.now(), dayStart = new Date().setHours(0, 0, 0, 0);
    for (const c of chats) {
      const t = new Date(c.updatedAt).getTime();
      (t >= dayStart ? groups.Today : now - t < 7 * 864e5 ? groups["Previous 7 days"] : groups.Older).push(c);
    }
    $("sideChats").innerHTML = chats.length
      ? Object.entries(groups).filter(([, l]) => l.length).map(([name, l]) => `<div><div class="chat-group">${name}</div><div class="chat-group-list">${l.slice(0, 30).map((c) =>
          `<div class="chat-item"><a class="chat-open" href="/?chat=${encodeURIComponent(c.id)}" title="${esc(c.title)}">${esc(c.title)}</a></div>`).join("")}</div></div>`).join("")
      : '<div><div class="chat-group">Chats</div><p class="chat-empty">Your chats will show up here.</p></div>';
  });
})();
