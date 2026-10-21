// Minimal, safe Markdown renderer shared by the chat and admin pages.
// Code and math are pulled out first (so Markdown rules can't mangle them), then
// everything else is HTML-escaped, so model or user text can never inject markup.

window.escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// LaTeX via KaTeX (loaded by the page). Falls back to the raw source if KaTeX is missing.
function renderTex(tex, display) {
  if (!window.katex) return escapeHtml(display ? `$$${tex}$$` : `$${tex}$`);
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html", strict: "ignore" });
  } catch {
    return escapeHtml(tex);
  }
}

// Calendar and email (2026-10-20): <gmail-draft …>body</gmail-draft> and <calendar-event …>notes</calendar-event> from the
// model become cards the chat page gives Save buttons (extras.js). Attributes are read, never passed through as HTML.
const attrsOf = (s) => Object.fromEntries([...String(s).matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
function googleCard(tag, attrs, body, done) {
  const a = attrsOf(attrs);
  const data = escapeHtml(JSON.stringify({ ...a, body: body.trim() }));
  if (tag === "gmail-draft") {
    return `<div class="g-card" data-kind="draft" data-g="${data}"><div class="g-head"><span class="g-badge">Gmail draft</span><b>${escapeHtml(a.subject || "(no subject)")}</b></div>` +
      `<div class="g-meta">To ${escapeHtml(a.to || "?")}${a["reply-to"] ? " · a reply" : ""}</div><div class="g-body">${escapeHtml(body.trim())}</div>` +
      `<div class="g-actions">${done ? '<button type="button" class="btn-primary g-save">Save to Gmail drafts</button>' : '<span class="muted">Writing…</span>'}</div></div>`;
  }
  return `<div class="g-card" data-kind="event" data-g="${data}"><div class="g-head"><span class="g-badge">Calendar</span><b>${escapeHtml(a.title || "Event")}</b></div>` +
    `<div class="g-meta">${escapeHtml((a.start || "").replace("T", " "))}${a.end ? " – " + escapeHtml(a.end.replace("T", " ")) : ""}${a.location ? " · " + escapeHtml(a.location) : ""}</div>` +
    (body.trim() ? `<div class="g-body">${escapeHtml(body.trim())}</div>` : "") +
    `<div class="g-actions">${done ? '<button type="button" class="btn-primary g-save">Add to Google Calendar</button>' : '<span class="muted">Writing…</span>'}</div></div>`;
}

window.renderMarkdown = function renderMarkdown(src) {
  const blocks = [];
  const hold = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  const displayMath = (tex) => `\n${hold(`<div class="math">${renderTex(tex.trim(), true)}</div>`)}\n`;

  let text = String(src)
    // Canvas (2026-10-20): ```canvas <kind> <title> is a document for the canvas beside the chat (canvas.js), shown as a card.
    .replace(/```canvas[ \t]+([\w+#.-]+)[ \t]*([^\n]*)\n?([\s\S]*?)(```|$)/g, (_, kind, title, body, end) =>
      hold(`<div class="canvas-card${end ? "" : " writing"}" data-kind="${escapeHtml(kind.toLowerCase())}" data-title="${escapeHtml(title.trim() || "Untitled")}">` +
        `<div class="cc-icon">${kind.toLowerCase() === "doc" ? "Aa" : "&lt;/&gt;"}</div><div class="cc-text"><b>${escapeHtml(title.trim() || "Untitled")}</b>` +
        `<small>${kind.toLowerCase() === "doc" ? "Document" : escapeHtml(kind)} · ${body.split("\n").length} lines${end ? "" : " · writing"}</small></div>` +
        `<button type="button" class="btn-ghost open-canvas">Open</button><pre hidden class="cc-src">${escapeHtml(body.replace(/\n$/, ""))}</pre></div>`))
    .replace(/<(gmail-draft|calendar-event)\b([^>]*)>([\s\S]*?)(<\/\1>|$)/g, (_, tag, attrs, body, end) => `\n${hold(googleCard(tag, attrs, body, !!end))}\n`)
    .replace(/```([\w+#.-]*)[^\n]*\n?([\s\S]*?)(```|$)/g, (_, lang, code) =>
      hold(
        `<div class="code"><div class="code-head"><span>${escapeHtml(lang || "code")}</span>` +
          // Web code gets a live Preview (the chat page runs it in a sandboxed frame).
          (/^(html?|svg|xml|js|javascript|jsx)$/i.test(lang) ? `<button class="preview-code" type="button" data-lang="${escapeHtml(lang.toLowerCase())}"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5l13 7.5-13 7.5z"/></svg><span>Preview</span></button>` : "") +
          (/^(python|py)$/i.test(lang) && typeof window !== "undefined" && window.yaiData ? `<button class="run-code" type="button"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5l13 7.5-13 7.5z"/></svg><span>Run</span></button>` : "") +
          (typeof window !== "undefined" && window.yaiCanvas ? `<button class="to-canvas" type="button" title="Edit in the canvas"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg><span>Edit</span></button>` : "") +
          `<button class="copy-code" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span>Copy</span></button></div>` +
          `<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre></div>`
      ))
    .replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`))
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => displayMath(tex))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => displayMath(tex))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => hold(renderTex(tex.trim(), false)))
    // $inline$: no space just inside the dollars, so prices like "$5 and $10" stay as text
    .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?![\w$])/g, (_, pre, tex) => pre + hold(renderTex(tex, false)));

  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join("<br>")}</p>`); para = []; } };
  const flushList = () => {
    if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`); list = null; }
  };
  const flush = () => { flushPara(); flushList(); };

  const lines = text.split("\n");
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const isDivider = (row) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row || "");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (line.includes("|") && isDivider(lines[i + 1])) {
      // Markdown table: header row, divider row, then body rows
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${head.map((_, j) => `<td>${r[j] ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    }
    else if (/^\u0000\d+\u0000$/.test(line.trim())) { flush(); out.push(line.trim()); }
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flush(); const h = m[1].length <= 2 ? "h3" : "h4"; out.push(`<${h}>${m[2]}</${h}>`); }
    else if ((m = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]);
    }
    else if ((m = line.match(/^&gt;\s?(.*)$/))) { flush(); out.push(`<blockquote>${m[1]}</blockquote>`); }
    else if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flush(); out.push("<hr>"); }
    else if (!line.trim()) flush();
    else { flushList(); para.push(line); }
  }
  flush();
  return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
};

// Splits a reply into its hidden reasoning (<think>…</think>) and the visible answer.
window.splitThinking = function splitThinking(answer) {
  const m = answer.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
  return m ? { thought: m[1], visible: answer.slice(m[0].length) } : { thought: "", visible: answer };
};
