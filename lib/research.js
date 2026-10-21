// Deep research (2026-10-20, the "medium report" Yousef picked): a question becomes a plan of searches, the top pages
// are read, a second round fills the gaps, and the writer gets about 15 numbered sources to write a 1–2 page report
// with [n] citations. Runs inside /api/chat before the reply streams; progress goes to the page as status events.
//
// runResearch({ question, complete, search, fetchPage, onStatus, contextTokens, deadline })
//   complete(messages, maxTokens) -> text     a one-off, non-streamed model call (the planner)
//   returns { block, sources, searches }     block goes into the system prompt; sources go to the page

const PLANNER =
  "You plan web research. Reply with ONLY a JSON array of 3 or 4 short web search queries that together cover the " +
  "question from different angles (background, latest developments, numbers and data, other viewpoints). No prose.";
const GAPS =
  "You plan the second round of web research. Given the question and what was found so far, reply with ONLY a JSON " +
  "array of 2 short web search queries for what is still missing or needs checking. No prose.";

// A JSON array of strings out of a model's reply (with or without code fences); falls back to quoted strings or lines.
function queriesFrom(text, fallback) {
  const t = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = t.match(/\[[\s\S]*?\]/);
  let list = [];
  if (m) {
    try {
      list = JSON.parse(m[0]);
    } catch {}
  }
  if (!Array.isArray(list) || !list.length) list = [...t.matchAll(/"([^"\n]{4,120})"/g)].map((x) => x[1]);
  if (!list.length) list = t.split("\n").map((l) => l.replace(/^[\s\-*\d.)]+/, "").trim()).filter((l) => l.length > 4 && l.length < 120);
  list = list.map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
  return list.length ? list : [fallback];
}

async function runResearch({ question, complete, search, fetchPage, onStatus, contextTokens, deadline }) {
  const q = String(question).slice(0, 600);
  const seen = new Map(); // url -> { title, url, site, snippet, text }
  let searches = 0;

  async function round(queries, take) {
    const lists = await Promise.all(queries.map(async (query) => {
      searches++;
      try {
        return await search(query, { count: 5 });
      } catch {
        return [];
      }
    }));
    // Round-robin over the queries' results, so each angle gets its best pages in.
    const fresh = [];
    for (let i = 0; i < 5 && fresh.length < take; i++) {
      for (const list of lists) {
        const r = list[i];
        if (r && !seen.has(r.url) && fresh.length < take) {
          seen.set(r.url, { ...r, text: "" });
          fresh.push(r.url);
        }
      }
    }
    return fresh;
  }
  async function read(urls, perPage) {
    await Promise.all(urls.map(async (url) => {
      const s = seen.get(url);
      try {
        const page = await fetchPage(url, { maxChars: perPage, timeout: 8000 });
        s.text = page.text;
        if (!s.title && page.title) s.title = page.title;
      } catch {
        s.text = s.snippet || "";
      }
    }));
  }

  const budget = Math.max(12000, Math.floor(contextTokens * 3.6 * 0.55));
  const perPage = Math.min(6000, Math.floor(budget / 15));

  onStatus("Planning the research");
  let plan;
  try {
    plan = queriesFrom(await complete([{ role: "system", content: PLANNER }, { role: "user", content: q }], 400), q);
  } catch {
    plan = [q];
  }
  onStatus(`Searching: ${plan.join(" · ")}`);
  const first = await round(plan, 10);
  onStatus(`Reading ${first.length} sources`);
  await read(first, perPage);

  // A second round for the gaps, if there's time left.
  if (Date.now() < deadline - 90000 && seen.size) {
    const notes = [...seen.values()].map((s, i) => `${i + 1}. ${s.title}: ${(s.text || s.snippet || "").slice(0, 280).replace(/\s+/g, " ")}`).join("\n");
    let more = [];
    try {
      more = queriesFrom(await complete([{ role: "system", content: GAPS }, { role: "user", content: `Question: ${q}\n\nFound so far:\n${notes}` }], 300), "").filter(Boolean).slice(0, 2);
    } catch {}
    if (more.length) {
      onStatus(`Filling gaps: ${more.join(" · ")}`);
      const second = await round(more, 5);
      if (second.length) {
        onStatus(`Reading ${second.length} more sources`);
        await read(second, perPage);
      }
    }
  }

  const all = [...seen.values()].filter((s) => (s.text || s.snippet || "").trim());
  onStatus(`Writing the report from ${all.length} sources`);
  let block = all.map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${(s.text || s.snippet).slice(0, perPage)}`).join("\n\n");
  if (block.length > budget) block = block.slice(0, budget) + "\n…";
  return {
    searches,
    sources: all.map((s, i) => ({ n: i + 1, title: s.title, url: s.url, site: s.site })),
    block:
      `\n\n# Deep research (sources gathered ${new Date().toDateString()})\n` +
      "Write a well-organised research report that answers the user's question from these sources: a title, a short " +
      "summary up top, then sections with headings, and a brief conclusion. About 1–2 pages. Cite sources like [3] or " +
      "[2][5] after the sentences that use them, prefer the newest information, say where sources disagree, and don't " +
      "add a sources list at the end (the page shows one). If the sources don't cover something, say so.\n\n" + block,
  };
}

module.exports = { runResearch, queriesFrom };
