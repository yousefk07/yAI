// Tools for an answer that's already written (2026-10-21):
//
//   POST ?op=factcheck  { question, answer }   "Check this": the answer's checkable facts, each searched on the web and
//                                              judged from what the sources say -> { results: [{ claim, verdict, why,
//                                              sources: [n] }], sources: [{ n, title, url, site, text }] }
//   POST ?op=slides     { messages: [{ role, content }], focus? }   a slide deck from a conversation -> { deck }
//
// Both use yAI Ultra Flash (fast and cheap); fact checks count against the daily web searches.

const store = require("./store");
const policy = require("./policy");
const { sendJson, modelEntry, completeOnce, cloudOn } = require("./handlers");
const { search, fetchPage } = require("./search");

const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const json = (text) => { const m = String(text || "").match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } };
function flash() {
  const m = modelEntry("deepseek-v4.1-flash");
  if (!m || !cloudOn(m)) throw Object.assign(new Error("yAI Ultra Flash isn't available right now."), { status: 503 });
  return m;
}
const ask = (system, user, maxTokens, user_, ms = 45000) => {
  const m = flash();
  return completeOnce(m, m.id, [{ role: "system", content: system }, { role: "user", content: user }], maxTokens, AbortSignal.timeout(ms), user_);
};

// ---------- Check this ----------
const EXTRACT =
  "List the factual claims in the assistant's answer that can be checked on the web: names, numbers, dates, events, prices, " +
  "places, who said or did what. Skip opinions, advice, code, maths and anything about the user themselves. Reply with only JSON: " +
  '{"claims":[{"claim":"the claim in one plain sentence","query":"a short web search query (under 10 words) to check it"}]} with ' +
  'at most 4 claims, the most important first. If nothing can be checked, reply {"claims":[]}.';
const JUDGE =
  "You check claims against web search results. Judge each claim ONLY from the numbered sources given, not from memory: " +
  "supported (the sources say so), wrong (the sources say otherwise), doubtful (the sources disagree, or only partly support it), " +
  "or unclear (nothing relevant in the sources). Reply with only JSON: " +
  '{"results":[{"claim":"…","verdict":"supported|wrong|doubtful|unclear","why":"one short sentence; for wrong, give the correct fact","sources":[1,3]}]}.';

async function factcheck(user, question, answer) {
  const got = json(await ask(EXTRACT, `The user asked:\n${clip(question, 2000)}\n\nThe assistant answered:\n${clip(answer, 12000)}`, 600, user));
  const claims = (got?.claims || []).filter((c) => c && c.claim && c.query).slice(0, 4);
  if (!claims.length) return { results: [], sources: [], note: "There's nothing in this answer to look up (no facts that can be checked on the web)." };
  const limits = await policy.limitsFor(user);
  if (limits.searches != null && store.STORE_ON && (await store.peekToday(`search:u:${user}`).catch(() => 0)) + claims.length > limits.searches) {
    throw Object.assign(new Error(`Checking needs ${claims.length} web searches, and today's ${limits.searches} are nearly used up.`), { status: 429 });
  }
  // each claim's search, and the top page read
  const sources = [];
  const blocks = await Promise.all(claims.map(async (c) => {
    const results = await search(clip(c.query, 200), { count: 4 }).catch(() => []);
    const page = results[0] ? await fetchPage(results[0].url, { maxChars: 2500, timeout: 6000 }).catch(() => null) : null;
    if (store.STORE_ON) await store.countToday(`search:u:${user}`).catch(() => 0);
    return results.map((r, i) => ({ ...r, text: i === 0 && page?.text?.length > (r.snippet || "").length ? page.text : r.snippet || "" }));
  }));
  if (store.STORE_ON) await store.trackUsage(user, { searches: claims.length }).catch(() => {});
  const lines = [];
  claims.forEach((c, i) => {
    lines.push(`## Claim ${i + 1}: ${c.claim}`);
    for (const r of blocks[i]) {
      const n = sources.push({ n: sources.length + 1, title: r.title, url: r.url, site: r.site, text: clip(r.text, 1800) });
      lines.push(`[${n}] ${r.title} (${r.url})\n${clip(r.text, 1500)}`);
    }
    if (!blocks[i].length) lines.push("(the search found nothing)");
  });
  const judged = json(await ask(JUDGE, `Claims and their search results:\n\n${lines.join("\n\n")}`, 1200, user, 60000));
  const VERDICTS = ["supported", "wrong", "doubtful", "unclear"];
  const results = (judged?.results || []).slice(0, claims.length).map((r, i) => ({
    claim: clip(r.claim || claims[i]?.claim, 300),
    verdict: VERDICTS.includes(r.verdict) ? r.verdict : "unclear",
    why: clip(r.why, 400),
    sources: (Array.isArray(r.sources) ? r.sources : []).map(Number).filter((n) => n >= 1 && n <= sources.length).slice(0, 4),
  }));
  return { results, sources };
}

// ---------- Slides ----------
const SLIDES =
  "Turn the conversation into a clear slide deck about its subject, written for an audience, not as a chat transcript " +
  "(no 'the user asked'). Reply with only JSON: " +
  '{"title":"deck title","subtitle":"one line","slides":[{"title":"slide title","bullets":["short point"],"notes":"what a speaker would say, 1-3 sentences"}]}. ' +
  "6 to 12 slides after the title; at most 6 bullets each, each under 14 words; keep real numbers, names and steps from the conversation; " +
  "the last slide sums up the key takeaways. No markdown inside the strings.";

async function slides(user, messages, focus) {
  const convo = messages.slice(-16).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${clip(m.content, 6000)}`).join("\n\n");
  const deck = json(await ask(SLIDES, `${focus ? `Focus on: ${clip(focus, 300)}\n\n` : ""}The conversation:\n\n${clip(convo, 40000)}`, 3500, user, 90000));
  if (!deck || !Array.isArray(deck.slides) || !deck.slides.length) throw new Error("The slides didn't come out right. Try again.");
  return {
    title: clip(deck.title || "Slides", 120), subtitle: clip(deck.subtitle, 200),
    slides: deck.slides.slice(0, 16).map((s) => ({ title: clip(s.title, 120), bullets: (Array.isArray(s.bullets) ? s.bullets : []).slice(0, 8).map((b) => clip(b, 200)), notes: clip(s.notes, 800) })),
  };
}

const ops = {
  "POST factcheck": async ({ res, user, body }) => {
    const b = await body();
    if (!String(b.answer || "").trim()) return sendJson(res, 400, { error: "There's no answer to check." });
    try { return sendJson(res, 200, await factcheck(user, b.question || "", b.answer)); }
    catch (err) { return sendJson(res, err.status || 502, { error: err.message }); }
  },
  "POST slides": async ({ res, user, body }) => {
    const b = await body();
    const messages = (Array.isArray(b.messages) ? b.messages : []).filter((m) => m && typeof m.content === "string" && m.content.trim());
    if (!messages.length) return sendJson(res, 400, { error: "There's nothing to make slides from." });
    try { return sendJson(res, 200, { deck: await slides(user, messages, b.focus) }); }
    catch (err) { return sendJson(res, err.status || 502, { error: err.message }); }
  },
};

module.exports = { ops, factcheck, slides };
