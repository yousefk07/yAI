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
  // a Markdown table (| a | b | then |---|---|), as the terminal draws it since 2026-10-22
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((x) => x.trim());
  const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  function table(rows) {
    const align = cells(rows[1]).map((x) => (/^:-+:$/.test(x) ? "center" : /-:$/.test(x) ? "right" : "left"));
    const cell = (tag, x, i) => `<${tag} style="text-align:${align[i] || "left"}">${inline(x)}</${tag}>`;
    return `<div class="tbl"><table><thead><tr>${cells(rows[0]).map((x, i) => cell("th", x, i)).join("")}</tr></thead><tbody>${rows.slice(2).filter((r) => !SEP.test(r)).map((r) => `<tr>${cells(r).map((x, i) => cell("td", x, i)).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function markdown(src) {
    const out = [];
    let code = null, list = null, para = [], tbl = [];
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`); list = null; };
    const flushTable = () => { if (tbl.length) { if (tbl.length > 1 && SEP.test(tbl[1])) out.push(table(tbl)); else para.push(...tbl); } tbl = []; };
    for (const line of src.split("\n")) {
      if (code) {
        if (/^\s*```/.test(line)) { out.push(`<div class="code"><div class="code-head"><span>${esc(code.lang || "code")}</span><button class="copy" type="button">Copy</button></div><pre><code>${esc(code.lines.join("\n"))}</code></pre></div>`); code = null; }
        else code.lines.push(line);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); tbl.push(line); continue; }
      flushTable();
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
    flushTable(); flushPara(); flushList();
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

  // ---------- /team (2026-10-22): the picker, the board and one agent, as in the terminal ----------
  const GLYPH = { done: ["✓", "g-done"], pass: ["✓", "g-pass"], fail: ["✕", "g-fail"], work: ["◐", "g-work"], stuck: ["‖", "g-stuck"], wait: ["○", "g-wait"], skip: ["–", "g-wait"], stopped: ["■", "g-stuck"] };
  const glyph = (st) => { const [g, c] = GLYPH[st] || ["·", "g-wait"]; return `<span class="glyph ${c}">${g}</span>`; };
  const money = (x) => (!x ? "free" : x < 0.001 ? "<$0.001" : `$${x.toFixed(3)}`);

  // the picker: rows by stage, each with a tick, its model and an estimate; presets; Start, chat or cancel
  function teamPick(ev) {
    text = step = null;
    const rows = ev.groups.flatMap((g) => g.rows);
    const price = (id) => ev.models.find((m) => m.id === id)?.price || { in: 0, cached: 0, out: 0 };
    const est = (r) => {
      if (r.builtIn || !r.profile) return { usd: 0, min: 0.5 };
      const [req, ctx, out, min] = r.profile, p = price(r.model);
      return { usd: (req * ctx * 1000 * (0.07 * (p.in || 0) + 0.93 * (p.cached ?? p.in ?? 0)) + out * 1000 * (p.out || 0)) / 1e6, min };
    };
    const card = add("", "team-card pick");
    const draw = () => {
      const on = rows.filter((r) => r.on), builders = on.filter((r) => r.builder).length;
      const usd = on.reduce((s, r) => s + est(r).usd, 0);
      const min = ev.groups.reduce((s, g) => s + Math.max(0, ...g.rows.filter((r) => r.on).map((r) => est(r).min)), 0);
      const preset = (k) => rows.every((r) => !r.presets || !!r.on === !!r.presets[k]);
      card.innerHTML = `<div class="tc-head"><b>Pick your team</b><span class="presets">${ev.presets.map((p) => `<button type="button" data-preset="${p.key}" class="${preset(p.key) ? "on" : ""}">${esc(p.label)} · ${rows.filter((r) => (r.presets ? r.presets[p.key] : r.on)).length}</button>`).join("")}</span></div>` +
        `<div class="tc-sub">The lead split this into ${ev.builders} builder job${ev.builders === 1 ? "" : "s"}. Choose who else joins and which model each one uses.</div>` +
        ev.groups.map((g) => `<div class="stage"><div class="stage-name"><b>${esc(g.name)}</b> ${esc(g.note)}</div>` + g.rows.map((r) => `<label class="pick-row ${r.on ? "" : "off"}">` +
          `<input type="checkbox" data-i="${r.i}" ${r.on ? "checked" : ""}><span class="pr-name" title="${esc(r.desc)}">${esc(r.label)}</span>` +
          (r.builtIn ? `<span class="pr-model muted">built-in</span>` : `<select data-m="${r.i}">${ev.models.map((m) => `<option value="${esc(m.id)}" ${m.id === r.model ? "selected" : ""}>${esc(m.short)}</option>`).join("")}</select>`) +
          `<span class="pr-est">${r.builtIn ? "free" : `${est(r).min < 1 ? "<1" : Math.round(est(r).min)}m · ${money(est(r).usd)}`}</span><span class="pr-desc">${esc(r.desc)}</span></label>`).join("") + `</div>`).join("") +
        `<div class="tc-foot"><button type="button" class="start" ${builders ? "" : "disabled"}>▶ Start ${builders ? on.length : 0} agent${on.length === 1 ? "" : "s"}</button>` +
        `<span class="muted">~${Math.max(1, Math.round(min))} min · ${usd ? "~" + money(usd) : "free"} · ${builders} at once</span>` +
        `<span class="tc-links"><button type="button" class="link" data-chat>Chat about the plan</button> <button type="button" class="link" data-cancel>Cancel</button></span></div>`;
    };
    // once answered, the picker folds to one line (the board takes over below it)
    const fold = (what) => { card.classList.add("done"); card.innerHTML = `<div class="muted">${what}</div>`; };
    const finish = (result) => {
      vscode.postMessage({ type: "teamPick", id: ev.id, result });
      const on = rows.filter((r) => r.on).length;
      fold(result?.rows ? `Team picked · ${on} agent${on === 1 ? "" : "s"}` : result?.chat ? "Not started · talking the plan over" : "Cancelled");
    };
    card.fold = () => fold(`Team picked · ${rows.filter((r) => r.on).length} agents`); // answered another way
    card.addEventListener("change", (e) => {
      const i = e.target.dataset.i ?? e.target.dataset.m;
      const r = rows.find((x) => String(x.i) === String(i));
      if (!r) return;
      if (e.target.dataset.i != null) r.on = e.target.checked; else r.model = e.target.value;
      draw();
    });
    card.addEventListener("click", (e) => {
      const p = e.target.closest("[data-preset]");
      if (p) { for (const r of rows) { if (r.presets) r.on = !!r.presets[p.dataset.preset]; if (r.presetModels && r.presetModels[p.dataset.preset]) r.model = r.presetModels[p.dataset.preset]; } return draw(); }
      if (e.target.closest(".start")) return finish({ rows: rows.map((r) => ({ i: r.i, on: r.on, model: r.model })) });
      if (e.target.closest("[data-chat]")) return finish({ chat: true });
      if (e.target.closest("[data-cancel]")) return finish(null);
    });
    draw();
  }

  // the board: stats, the stage bar, the agents under their stages, the live feed; or one agent opened
  let team = null; // { card, view, open }
  function teamBoard(view) {
    if (!team || team.over) {
      text = step = null;
      log.querySelectorAll(".team-card.pick:not(.done)").forEach((c) => c.fold && c.fold());
      team = { card: add("", "team-card board"), open: 0 };
      setTimeout(() => team.card.scrollIntoView({ block: "start" }), 0);
    }
    team.view = view;
    team.over = view.over;
    if (view.agent) team.open = view.agent.n; else if (!view.over) team.open = 0;
    drawBoard();
    setPlaceholder();
  }
  function drawBoard() {
    const v = team.view, keep = stick();
    const strip = v.strip.map((s) => { const total = Math.max(1, s.total), d = s.total ? (s.done / s.total) * 100 : s.past ? 100 : 0, w = s.total ? (s.working / s.total) * 100 : 0;
      return `<div class="sg ${s.current ? "cur" : s.past ? "past" : ""}" style="flex:${total}"><div class="bar"><i style="width:${d}%"></i><i class="w" style="width:${w}%"></i></div><span>${esc(s.label)}</span></div>`; }).join("");
    const head = `<div class="tc-head"><b title="${esc(v.task)}">${esc(v.task)}</b></div><div class="tc-stats"><span><b>${v.done} / ${v.total}</b> done</span>${v.working ? `<span><b>${v.working}</b> working</span>` : ""}<span><b>${esc(v.elapsed)}</b></span><span><b>${esc(v.cost)}</b>${v.estimate ? ` of ~${esc(v.estimate)}` : ""}</span>${v.over ? `<span class="muted">finished</span>` : ""}</div><div class="strip">${strip}</div>`;
    if (v.agent) { team.card.innerHTML = head + agentHtml(v.agent); }
    else {
      const stages = v.stages.map((g) => `<div class="stage"><div class="stage-name ${g.current ? "cur" : ""}"><b>${esc(g.name)}</b> ${esc(g.note)}</div>` + g.rows.map((r) =>
        `<div class="agent-row st-${r.st}" data-open="${r.n}" title="Open ${esc(r.name)}">${glyph(r.st)}<span class="ar-name">${esc(r.name)}</span><span class="ar-model">${esc(r.model || "")}</span><span class="ar-time">${esc(r.time || "")}</span><span class="ar-cost">${esc(r.cost || "")}</span>` +
        `<span class="ar-act">${esc(r.act)}</span>${r.st === "wait" || r.st === "skip" ? "" : `<span class="ar-bar"><i style="width:${r.pct}%"></i></span>`}` +
        (!v.over && (r.canRetry || (r.canSkip && r.st !== "wait")) ? `<span class="ar-acts">${r.canRetry ? `<button type="button" class="link" data-act="retry" data-n="${r.n}">Retry</button>` : ""}${r.canSkip && r.st !== "wait" ? `<button type="button" class="link" data-act="skip" data-n="${r.n}">Skip</button>` : ""}</span>` : "") + `</div>`).join("") + `</div>`).join("");
      const feed = v.feed.length ? `<details class="feed" ${team.feedOpen === false ? "" : "open"}><summary>Live <span class="muted">newest first</span></summary>${v.feed.slice(0, 30).map((f) => `<div class="fe"><span class="fe-t">${esc(f.t)}</span><div><b class="tone-${esc(f.whoTone || "")}">${esc(f.who)}</b> ${esc(f.what)}${f.quote ? `<div class="fe-q">${esc(f.quote)}</div>` : ""}</div></div>`).join("")}</details>` : "";
      team.card.innerHTML = head + stages + feed;
    }
    if (keep) log.scrollTop = log.scrollHeight;
  }
  function agentHtml(a) {
    const steps = a.steps.map((s) => `<div class="as-step ${s.st}">${s.st === "done" ? "✓" : s.st === "work" ? "◐" : "○"} ${esc(s.l)}</div>`).join("");
    const body = [];
    let para = [];
    const flush = () => { if (para.length) body.push(`<div class="msg-ai">${markdown(para.join("\n"))}</div>`); para = []; };
    for (const e of a.log) {
      if (e.k === "text") { para.push(e.line); continue; }
      if (e.k === "gap") { flush(); continue; }
      flush();
      if (e.k === "brief") continue;
      if (e.k === "step") body.push(`<div class="step"><span class="ic">${iconFor(e.verb || "")}</span><b>${esc(e.verb)}</b><span class="arg">${pathLink(e.arg || "")}</span></div>`);
      else if (e.k === "result") { if (e.text) body.push(`<div class="as-res ${esc(e.tone || "")}">└ ${esc(String(e.text).split("\n")[0])}</div>`); }
      else if (e.k === "diff") body.push(`<div class="as-diff"><span class="ic">${I.edit}</span><b>${e.created ? "Create" : "Edit"}</b> ${pathLink(e.path)} <span class="plus">+${e.added}</span> <span class="minus">−${e.removed}</span></div>`);
      else if (e.k === "you") body.push(`<div class="as-you">› <b>you</b> ${esc(e.text)} <span class="${e.read ? "ok" : "muted"}">${e.read ? "✓ read" : "· read after its current step"}</span></div>`);
      else if (e.k === "note" || e.k === "error") body.push(`<div class="note ${e.k === "error" ? "error" : ""}">${esc(e.text)}</div>`);
    }
    flush();
    return `<div class="agent-view"><div class="av-top"><button type="button" class="link" data-close>← Team</button>` +
      `${a.state === "working" ? `<button type="button" class="link" data-act="pause" data-n="${a.n}">${a.paused ? "Resume" : "Pause"}</button>` : ""}${a.canRetry ? `<button type="button" class="link" data-act="retry" data-n="${a.n}">Restart</button>` : ""}${a.canSkip ? `<button type="button" class="link" data-act="skip" data-n="${a.n}">Skip</button>` : ""}</div>` +
      `<div class="av-name"><span class="badge">${a.n}</span><b>${esc(a.name)}</b> <span class="muted">${esc(a.where)}</span></div><div class="muted av-desc">${esc(a.desc)}</div>` +
      `<div class="av-stats">${a.stats.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("")}</div>` +
      (steps ? `<div class="av-sec">ITS STEPS</div>${steps}` : "") +
      `<div class="av-sec">CAN TOUCH</div>${a.touch.map(([w, h]) => `<div class="av-touch"><span>${esc(w)}</span><span class="muted">${esc(h)}</span></div>`).join("")}` +
      (a.waiting.length ? `<div class="av-sec">WAITING ON IT</div><div class="muted">${a.waiting.map((n) => `○ ${esc(n)}`).join("  ")}</div>` : "") +
      `<div class="av-log">${body.join("")}</div></div>`;
  }
  log.addEventListener("click", (e) => {
    if (!team || !team.card.contains(e.target)) return;
    const act = e.target.closest("[data-act]");
    if (act) { e.stopPropagation(); return vscode.postMessage({ type: "teamAction", action: act.dataset.act, n: Number(act.dataset.n) }); }
    if (e.target.closest("[data-close]")) { team.open = 0; vscode.postMessage({ type: "teamAction", action: "close" }); return; }
    const row = e.target.closest("[data-open]");
    if (row && !team.over) { team.open = Number(row.dataset.open); vscode.postMessage({ type: "teamAction", action: "open", n: team.open }); }
    const f = e.target.closest("details.feed > summary");
    if (f) team.feedOpen = !f.parentElement.open;
  });
  const teamLive = () => !!team && !team.over && busy;

  // the plan card while yAI works: its steps, ticked off as it goes
  function planCard(plan) {
    const box = $("plan");
    if (!plan || !plan.steps || !plan.steps.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = plan.steps.map((s, i) => `<div class="pl ${i < plan.done ? "done" : i === plan.done ? "now" : ""}">${i < plan.done ? "✓" : i === plan.done ? "◐" : "○"} ${esc(s)}</div>`).join("");
  }
  function setPlaceholder() {
    input.placeholder = !busy ? "Ask yAI Code…" : teamLive() ? (team.open && team.view.agent ? `Message ${team.view.agent.name} directly…` : "Add a note for the whole team…") : "Add a note while yAI works… (read after this step)";
  }

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
    setPlaceholder();
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
      case "team-pick": teamPick(ev); break;
      case "team": teamBoard(ev.view); break;
      case "progress": planCard(ev.plan); break;
      case "done": {
        const worked = busy; // a mode or model change also sends "done"
        setBusy(false);
        planCard(null);
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
        team = null;
        planCard(null);
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
    // while yAI works, what you send is a note it reads after its current step: for the team (or the agent you
    // opened) during /team, else for yAI itself
    if (busy) {
      if (teamLive()) vscode.postMessage({ type: "teamAction", action: "note", n: team.open || 0, text: msg });
      else { vscode.postMessage({ type: "note", text: msg }); add(`› <b>you</b> ${esc(msg)} <span class="muted">· read after this step</span>`, "note you"); }
      input.value = "";
      grow();
      return;
    }
    userMsg(msg);
    vscode.postMessage({ type: "prompt", text: msg });
    input.value = "";
    grow();
  }
  function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; }
  input.addEventListener("input", () => {
    grow();
    // while busy: the button sends what you typed as a note, or stops yAI when the box is empty
    if (busy) { const note = !!input.value.trim(); $("send").innerHTML = note ? I.send : I.stop; $("send").classList.toggle("stop", !note); $("send").title = note ? "Send as a note (Enter)" : "Stop (Esc)"; }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === "Escape" && busy) vscode.postMessage({ type: "stop" });
  });
  $("send").onclick = () => (busy && !input.value.trim() ? vscode.postMessage({ type: "stop" }) : submit());
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
