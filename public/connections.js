// Connections (2026-10-21): the panel where people connect GitHub, LEARN and webhooks, and see
// what's always on (weather, maps, papers, YouTube). yAI uses them on its own when a question needs them; anything that
// changes something comes as a card with a button (<yai-action> in md.js), run here after the person presses it.
(function () {
  const GROUPS = [
    ["Your accounts", ["github", "learn", "webhooks"]],
    ["Always on", ["weather", "maps", "arxiv", "scholar", "youtube"]],
    ["Set up by the site", ["wolfram", "uw"]],
  ];
  let dlg = null, services = [], settings = { webhooks: [] };

  function build() {
    dlg = document.createElement("dialog");
    dlg.className = "conn-dialog";
    dlg.setAttribute("aria-label", "Connections");
    dlg.innerHTML = `<div class="conn-head"><div><h2>Connections</h2><p class="muted">yAI uses these on its own when a question needs them. Anything that changes something (a GitHub issue or comment, a webhook message) shows a button and waits for you.</p></div><button type="button" class="btn-ghost conn-close" aria-label="Close">✕</button></div><div class="conn-body"><div class="muted">Loading…</div></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector(".conn-close").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    dlg.querySelector(".conn-body").addEventListener("click", onClick);
    dlg.querySelector(".conn-body").addEventListener("submit", onSubmit);
  }

  async function load() {
    const [a, b] = await Promise.all([api("/api/hub?op=connections").then((r) => r.json()), api("/api/hub?op=connections-settings").then((r) => r.json())]);
    services = a.services || [];
    settings = b || { webhooks: [] };
  }

  function row(s) {
    const state = s.connected ? `<span class="conn-on">${s.kind === "open" || s.kind === "key" ? "On" : "Connected"}</span>${s.who ? ` · ${escapeHtml(s.who)}` : ""}` : `<span class="muted">${escapeHtml(s.needs || "Not connected")}</span>`;
    let action = "";
    if (s.kind === "oauth" && s.ready) action = s.connected ? `<button type="button" class="btn-ghost" data-act="disconnect" data-id="${s.id}">Disconnect</button>` : `<button type="button" class="btn-primary" data-act="connect" data-id="${s.id}">Connect</button>`;
    let extra = "";
    if (s.id === "learn") {
      extra = `<form class="conn-form" data-form="learn"><input type="url" name="url" placeholder="${s.connected ? "Saved · paste a new link to replace it" : "https://learn.uwaterloo.ca/d2l/le/calendar/feed/user/feed.ics?token=…"}" autocomplete="off" aria-label="LEARN calendar link"><button type="submit" class="btn-primary">Save</button>${s.connected ? '<button type="button" class="btn-ghost" data-act="disconnect" data-id="learn">Remove</button>' : ""}</form>` +
        `<p class="conn-help muted">On LEARN, open Calendar, press Subscribe, and copy the link it shows. yAI only reads your due dates from it.</p>`;
    }
    if (s.id === "webhooks") {
      extra = `<ul class="conn-hooks">${(settings.webhooks || []).map((h) => `<li><b>${escapeHtml(h.name)}</b> <span class="muted">${escapeHtml(h.host)}</span><button type="button" class="btn-ghost" data-act="hook-test" data-name="${escapeHtml(h.name)}">Test</button><button type="button" class="btn-ghost" data-act="hook-del" data-hid="${escapeHtml(h.id)}" aria-label="Remove ${escapeHtml(h.name)}">Remove</button></li>`).join("")}</ul>` +
        `<form class="conn-form" data-form="hook"><input name="name" placeholder="Name (e.g. Discord)" maxlength="40" aria-label="Webhook name"><input type="url" name="url" placeholder="https://discord.com/api/webhooks/…" aria-label="Webhook link"><button type="submit" class="btn-primary">Add</button></form>` +
        `<p class="conn-help muted">Works with Discord, Slack, Zapier, n8n or any link that takes JSON. Scheduled tasks can send their results here too.</p>`;
    }
    const tools = s.tools.map((t) => `<span class="conn-tool${t.write ? " w" : ""}" title="${escapeHtml(t.desc)}${t.write ? " (asks you first)" : ""}">${escapeHtml(t.name.split(".")[1].replace(/_/g, " "))}</span>`).join("");
    return `<div class="conn-row" data-id="${s.id}"><div class="conn-main"><div class="conn-title"><b>${escapeHtml(s.label)}</b><small>${state}</small></div><p class="muted">${escapeHtml(s.desc)}</p><div class="conn-tools">${tools}</div>${extra}</div><div class="conn-act">${action}</div></div>`;
  }

  function render() {
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    dlg.querySelector(".conn-body").innerHTML = GROUPS.map(([title, ids]) => `<h3>${title}</h3>${ids.filter((id) => by[id]).map((id) => row(by[id])).join("")}`).join("");
  }

  async function open() {
    if (!dlg) build();
    if (!dlg.open) dlg.showModal();
    try { await load(); render(); } catch (err) { dlg.querySelector(".conn-body").innerHTML = `<p class="muted">Couldn't load connections: ${escapeHtml(err.message)}</p>`; }
  }

  async function saveSettings(body) {
    const r = await api("/api/hub?op=connections-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Couldn't save");
    return d;
  }

  async function onClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    try {
      if (act === "connect") { location.href = `/api/hub?op=${b.dataset.id}-connect`; return; }
      b.disabled = true;
      if (act === "disconnect") await api(`/api/hub?op=connections&service=${encodeURIComponent(b.dataset.id)}`, { method: "DELETE" });
      if (act === "hook-del") await saveSettings({ webhooks: (settings.webhooks || []).filter((h) => h.id !== b.dataset.hid).map((h) => ({ id: h.id, name: h.name })) });
      if (act === "hook-test") {
        const r = await api("/api/hub?op=webhook-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: b.dataset.name }) });
        const d = await r.json().catch(() => ({}));
        toast(r.ok ? `Sent a test to ${b.dataset.name}.` : d.error || "The test didn't go through.");
        b.disabled = false;
        return;
      }
      await load();
      render();
    } catch (err) {
      b.disabled = false;
      if (!err.locked) toast(err.message);
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      if (f.dataset.form === "learn") await saveSettings({ learnIcs: f.url.value.trim() });
      if (f.dataset.form === "hook") await saveSettings({ webhooks: [...(settings.webhooks || []).map((h) => ({ id: h.id, name: h.name })), { name: f.name.value.trim(), url: f.url.value.trim() }] });
      toast(f.dataset.form === "learn" ? "LEARN connected. Ask “what's due this week?”" : "Webhook saved.");
      await load();
      render();
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  }

  // ---------- action cards: run the tool once the person presses the button ----------
  document.addEventListener("click", async (e) => {
    const b = e.target.closest(".a-run");
    if (!b || b.disabled) return;
    const card = b.closest(".a-card");
    let args = {};
    try { args = JSON.parse(card.dataset.args || "{}"); } catch {}
    b.disabled = true;
    b.textContent = "Working…";
    try {
      const r = await api("/api/hub?op=tool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: card.dataset.tool, args, confirm: true }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "It didn't work");
      const done = document.createElement("div");
      done.className = "a-done";
      done.textContent = d.text || "Done.";
      b.replaceWith(done);
      if (d.link) done.insertAdjacentHTML("beforeend", ` <a href="${escapeHtml(d.link)}" target="_blank" rel="noopener">Open</a>`);
    } catch (err) {
      b.disabled = false;
      b.textContent = "Try again";
      if (!err.locked) toast(err.message);
    }
  });

  // Back from a service's consent screen.
  const p = new URLSearchParams(location.search);
  // GitHub sent the sign-in back to the site's home page (its app's callback is set to the site address): pass it on.
  if (p.get("code") && p.get("state") && !p.get("connected")) { location.replace(`/api/hub?op=github-callback&${p.toString()}`); return; }
  if (p.get("connections")) { history.replaceState(null, "", "/"); setTimeout(open, 600); } // yAI Code's /connections link
  if (p.get("connected")) {
    const id = p.get("connected"), ok = p.get("result") === "ok";
    history.replaceState(null, "", "/");
    const name = { github: "GitHub" }[id] || id;
    setTimeout(() => { toast(ok ? `${name} connected.` : p.get("result") === "cancelled" ? `${name} wasn't connected.` : `Couldn't connect ${name}. Try again.`); if (ok) open(); }, 800);
  }
  document.getElementById("connectionsBtn")?.addEventListener("click", () => { document.getElementById("accountMenu").hidden = true; open(); });
  window.yaiConnections = { open };
})();
