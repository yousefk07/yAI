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

window.renderMarkdown = function renderMarkdown(src) {
  const blocks = [];
  const hold = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  const displayMath = (tex) => `\n${hold(`<div class="math">${renderTex(tex.trim(), true)}</div>`)}\n`;

  let text = String(src)
    .replace(/```([\w+#.-]*)[^\n]*\n?([\s\S]*?)(```|$)/g, (_, lang, code) =>
      hold(
        `<div class="code"><div class="code-head"><span>${escapeHtml(lang || "code")}</span>` +
          `<button class="copy-code" type="button">Copy</button></div>` +
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
