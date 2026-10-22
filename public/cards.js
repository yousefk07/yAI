// Live data cards (2026-10-21): weather, a stock and scores, drawn above the answer that used them, and kept up to date
// while they're on screen (scores and stocks every 30 s, weather every 15 min) through ?op=card.
(function () {
  const REFRESH = { sports: 30000, stock: 30000, weather: 900000 };
  const WX = (code) => (code === 0 ? "☀️" : code <= 2 ? "🌤️" : code === 3 ? "☁️" : code <= 48 ? "🌫️" : code <= 57 ? "🌦️" : code <= 67 ? "🌧️" : code <= 77 ? "🌨️" : code <= 82 ? "🌧️" : code <= 86 ? "🌨️" : "⛈️");
  const day = (iso, i) => (i === 0 ? "Today" : new Date(iso + "T12:00").toLocaleDateString([], { weekday: "short" }));
  const round = (n) => Math.round(Number(n));
  // two decimals (four for prices under $1, like some crypto)
  const money = (n, cur, small = Number(n) < 1) => `${Number(n).toLocaleString(undefined, { minimumFractionDigits: small ? 4 : 2, maximumFractionDigits: small ? 4 : 2 })}${cur ? ` ${cur}` : ""}`;
  const since = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };

  function weather(d) {
    return `<div class="lc-top"><span class="lc-kind">Weather</span><span class="lc-sub">${escapeHtml(d.place)}${d.country ? `, ${escapeHtml(d.country)}` : ""}</span></div>
      <div class="lc-wx-now"><span class="lc-wx-ico">${WX(d.now.code)}</span><span class="lc-big">${round(d.now.temp)}°</span>
        <span class="lc-wx-meta"><b>${escapeHtml(d.now.label)}</b><span>Feels ${round(d.now.feels)}° · wind ${round(d.now.wind)} km/h · ${round(d.now.humidity)}% humidity</span></span></div>
      <div class="lc-days">${d.days.slice(0, 7).map((x, i) => `<div class="lc-day"><span>${day(x.date, i)}</span><span class="lc-day-ico" title="${escapeHtml(x.label)}">${WX(x.code)}</span><b>${round(x.max)}°</b><span class="lc-lo">${round(x.min)}°</span>${x.pop ? `<span class="lc-pop">${x.pop}%</span>` : ""}</div>`).join("")}</div>`;
  }
  function stock(d) {
    const up = d.change >= 0;
    const pts = d.points || [];
    let path = "", base = "";
    if (pts.length > 1) {
      const vals = pts.map((p) => p[1]).concat(d.prev ? [d.prev] : []);
      const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
      const x = (i) => (i / (pts.length - 1)) * 300, y = (v) => 70 - ((v - lo) / span) * 64 - 3;
      path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
      if (d.prev) base = `<line x1="0" x2="300" y1="${y(d.prev).toFixed(1)}" y2="${y(d.prev).toFixed(1)}" class="lc-prev"/>`;
    }
    return `<div class="lc-top"><span class="lc-kind">${escapeHtml(d.symbol)}</span><span class="lc-sub">${escapeHtml(d.name)} · ${escapeHtml(d.exchange || "")}</span><span class="lc-state ${d.open ? "on" : ""}">${d.open ? "Market open" : "Market closed"}</span></div>
      <div class="lc-stockrow"><div><span class="lc-big">${money(d.price)}</span> <span class="lc-cur">${escapeHtml(d.currency || "")}</span>
        <div class="lc-chg ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${money(Math.abs(d.change), "", d.price < 1)} (${Math.abs(d.pct).toFixed(2)}%) today</div>
        <div class="lc-range">Day range ${money(d.low)} – ${money(d.high)}</div></div>
        ${path ? `<svg class="lc-chart" viewBox="0 0 300 70" preserveAspectRatio="none" aria-hidden="true">${base}<path d="${path}" class="${up ? "up" : "down"}"/></svg>` : ""}</div>`;
  }
  function sports(d) {
    const team = (t, other) => `<div class="lc-team${t.score !== "" && other.score !== "" && Number(t.score) > Number(other.score) ? " win" : ""}">${t.logo ? `<img src="${escapeHtml(t.logo)}" alt="" loading="lazy">` : ""}<span>${escapeHtml(t.name)}</span><b>${escapeHtml(t.score)}</b></div>`;
    return `<div class="lc-top"><span class="lc-kind">${escapeHtml(d.league)}</span><span class="lc-sub">${escapeHtml(d.team || "")}</span>${d.games.some((g) => g.state === "in") ? '<span class="lc-state on">Live</span>' : ""}</div>
      ${d.games.length ? `<div class="lc-games">${d.games.map((g) => `<a class="lc-game ${g.state}" ${g.link ? `href="${escapeHtml(g.link)}" target="_blank" rel="noopener"` : ""}>${team(g.away, g.home)}${team(g.home, g.away)}
        <span class="lc-gs">${g.state === "pre" ? new Date(g.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : escapeHtml(g.status)}</span></a>`).join("")}</div>` : '<p class="lc-none">No games today.</p>'}`;
  }
  const DRAW = { weather, stock, sports };

  // Cards for one message: drawn above its text, then refreshed while on screen.
  function render(el, cards) {
    if (!cards?.length) return;
    let box = el.querySelector(".live-cards");
    if (!box) {
      box = document.createElement("div");
      box.className = "live-cards";
      el.querySelector(".content").before(box);
    }
    box.innerHTML = "";
    for (const c of cards) {
      if (!DRAW[c.kind]) continue;
      const card = document.createElement("div");
      card.className = `live-card lc-${c.kind}`;
      card._c = { ...c, at: c.at || Date.now() };
      draw(card);
      box.appendChild(card);
      watch(card);
    }
  }
  function draw(card) {
    const c = card._c;
    card.innerHTML = DRAW[c.kind](c.data) + `<div class="lc-foot"><span class="lc-live"></span><span class="lc-when">Updated ${since(c.at)}</span></div>`;
  }
  // refresh while visible (an IntersectionObserver keeps hidden cards quiet)
  const seen = new WeakSet();
  const io = "IntersectionObserver" in window ? new IntersectionObserver((list) => { for (const e of list) e.isIntersecting ? seen.add(e.target) : seen.delete(e.target); }) : null;
  const all = new Set();
  function watch(card) { all.add(card); io?.observe(card); }
  setInterval(async () => {
    if (document.hidden) return;
    for (const card of [...all]) {
      if (!card.isConnected) { all.delete(card); continue; }
      const c = card._c;
      card.querySelector(".lc-when").textContent = `Updated ${since(c.at)}`;
      if (io && !seen.has(card)) continue;
      if (Date.now() - c.at < REFRESH[c.kind] || card._busy) continue;
      if (c.kind === "sports" && !c.data.games?.some((g) => g.state === "in" || (g.state === "pre" && new Date(g.start) - Date.now() < 3600000))) { c.at = Date.now(); continue; }
      card._busy = true;
      card.classList.add("lc-busy");
      try {
        const r = await fetch("/api/hub?op=card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: c.kind, args: c.args }) });
        const d = await r.json();
        if (r.ok && d.card) { c.data = d.card.data; c.at = Date.now(); draw(card); }
        else c.at = Date.now();
      } catch { c.at = Date.now(); }
      card._busy = false;
      card.classList.remove("lc-busy");
    }
  }, 5000);

  window.yaiCards = { render };
})();
