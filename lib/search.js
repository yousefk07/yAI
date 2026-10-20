// Web search and page reading, for the website's "Search the web" answers (with numbered sources) and yAI Code's
// web_search / web_fetch tools. No npm dependency.
//
// Search uses the first one that is set up: BRAVE_API_KEY (Brave Search API), TAVILY_API_KEY (Tavily), and
// otherwise DuckDuckGo's plain HTML page, then Bing's results page, then Wikipedia. The keyless ones can refuse
// server addresses like Vercel's (2026-10-20: searches on the live site came back empty), hence the chain.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const BRAVE_KEY = process.env.BRAVE_API_KEY || "";
const TAVILY_KEY = process.env.TAVILY_API_KEY || "";
const MAX_PAGE_BYTES = 2_000_000;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/" };
const decode = (s) =>
  String(s).replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e];
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
const stripTags = (s) => decode(String(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

async function brave(query, count) {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": BRAVE_KEY },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Brave Search: HTTP ${r.status}`);
  const data = await r.json();
  return (data.web?.results || []).map((x) => ({ title: stripTags(x.title), url: x.url, snippet: stripTags(x.description || "") }));
}

async function tavily(query, count) {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_KEY}` },
    body: JSON.stringify({ query, max_results: count }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Tavily: HTTP ${r.status}`);
  const data = await r.json();
  return (data.results || []).map((x) => ({ title: x.title, url: x.url, snippet: String(x.content || "").slice(0, 400) }));
}

// DuckDuckGo's HTML results: <a class="result__a" href="//duckduckgo.com/l/?uddg=<real url>">title</a>, then
// <a class="result__snippet">…</a>. Ads point at duckduckgo.com/y.js and are skipped.
async function duckduckgo(query, count) {
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.8" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`DuckDuckGo: HTTP ${r.status}`);
  const html = await r.text();
  const results = [];
  // One block per result, so a result without a snippet doesn't take the next one's.
  for (const block of html.split(/class="[^"]*\bresult__body\b/).slice(1)) {
    const m = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!m) continue;
    m[3] = (/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block) || [])[1];
    let url = decode(m[1]);
    const real = /[?&]uddg=([^&]+)/.exec(url);
    if (real) url = decodeURIComponent(real[1]);
    else if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    results.push({ title: stripTags(m[2]), url, snippet: stripTags(m[3] || "") });
    if (results.length >= count) break;
  }
  if (!results.length && /anomaly|captcha/i.test(html)) throw new Error("DuckDuckGo asked for a captcha; set BRAVE_API_KEY or TAVILY_API_KEY");
  return results;
}

// Bing's results page: <li class="b_algo"> blocks; the link is a bing.com/ck redirect whose u= holds the real URL
// as "a1" + base64url.
async function bing(query, count) {
  const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&count=${count + 4}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.8" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Bing: HTTP ${r.status}`);
  const html = await r.text();
  const results = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const m = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!m) continue;
    let url = decode(m[1]);
    const u = /[?&]u=a1([^&]+)/.exec(url);
    if (u) {
      try {
        url = Buffer.from(u[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      } catch {}
    }
    if (!/^https?:\/\//.test(url) || /^https?:\/\/(www\.)?bing\.com\//.test(url)) continue;
    const snippet = (/<p[^>]*>([\s\S]*?)<\/p>/.exec(block.split('class="b_caption"')[1] || "") || [])[1] || "";
    results.push({ title: stripTags(m[2]), url, snippet: stripTags(snippet).replace(/^[A-Z][a-z]{2} \d{1,2}, \d{4}\s*·\s*/, "") });
    if (results.length >= count) break;
  }
  return results;
}

// Wikipedia's search API: always reachable, and good for people, places and things.
async function wikipedia(query, count) {
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${Math.min(count, 5)}&srsearch=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "yAI/1.0 (https://yousef-llmai.vercel.app)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Wikipedia: HTTP ${r.status}`);
  const data = await r.json();
  return (data.query?.search || []).map((x) => ({
    title: x.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}`, snippet: stripTags(x.snippet),
  }));
}

// The words that matter in a question: "who is abdel halim hafez" -> abdel, halim, hafez.
const STOP = new Set(("a an the is are was were be been am do does did of in on at to for from by with about as and or but not " +
  "who what when where why how which whose whom tell me explain give show find please can could would should i you my your it its " +
  "this that these those there their they he she him her his hers we us our").split(" "));
const fold = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const keywords = (q) => [...new Set(fold(q).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)))];
// Share of the question's keywords found in a result's title, snippet and address.
function relevance(result, words) {
  if (!words.length) return 1;
  const text = fold(`${result.title} ${result.snippet} ${decodeURIComponent(result.url).replace(/[_/-]/g, " ")}`);
  return words.filter((w) => text.includes(w)).length / words.length;
}

// Returns [{ title, url, site, snippet }] (at most `count`), with .engine saying which engine answered.
// Keyless engines sometimes answer a server with results for one word of the question (2026-10-20, live site:
// "who is abdel halim hafez" came back as pages about the name "Abdel"), so results that miss most of the question's
// words are dropped, and an engine left with fewer than 2 good results hands over to the next one.
async function search(query, { count = 6 } = {}) {
  query = String(query || "").trim().slice(0, 400);
  if (!query) return [];
  count = Math.min(Math.max(count, 1), 10);
  const words = keywords(query);
  const need = words.length <= 1 ? 1 : 0.6;
  const engines = [BRAVE_KEY && brave, TAVILY_KEY && tavily, duckduckgo, bing, wikipedia].filter(Boolean);
  const errors = [];
  let best = null;
  for (const engine of engines) {
    try {
      const raw = await engine(query, count + 2);
      const good = raw.filter((x) => relevance(x, words) >= need).slice(0, count);
      if (good.length >= Math.min(2, raw.length) && good.length) {
        if (errors.length) console.warn(`search: ${errors.join("; ")}; used ${engine.name}`);
        return Object.assign(good.map((x) => ({ ...x, site: hostOf(x.url) })), { engine: engine.name });
      }
      if (good.length && (!best || good.length > best.length)) best = Object.assign(good, { engine: engine.name });
      errors.push(`${engine.name}: ${raw.length ? `${raw.length - good.length} of ${raw.length} results off-topic` : "no results"}`);
    } catch (err) {
      errors.push(err.message);
    }
  }
  console.warn(`search "${query.slice(0, 80)}": ${errors.join("; ")}`);
  if (best) return Object.assign(best.map((x) => ({ ...x, site: hostOf(x.url) })), { engine: best.engine });
  if (errors.some((e) => !/no results|off-topic/.test(e))) throw new Error(errors.join("; "));
  return [];
}

// The readable text of a web page: scripts, styles, navigation and footers removed, block elements on their own lines.
function htmlToText(html) {
  const title = stripTags((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "");
  let body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html) || [, html])[1];
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && main[2].length > 500) body = main[2];
  const text = body
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => "\n\n" + "#".repeat(Number(n)) + " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|ul|ol|table|tr|pre|blockquote)>/gi, "\n")
    .replace(/<td[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  const clean = decode(text)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, all) => l || (all[i - 1] && all[i - 1].trim()))
    .join("\n")
    .trim();
  return { title, text: clean };
}

// Fetches a page and returns { url, title, text } (text cut to maxChars). Only http(s); no private addresses unless
// allowPrivate (yAI Code on the user's own machine, reading their dev server).
async function fetchPage(url, { maxChars = 20000, timeout = 10000, allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https pages can be read");
  if (!allowPrivate && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.)/i.test(u.hostname)) throw new Error("That address is private");
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = r.headers.get("content-type") || "";
  if (!/text|json|xml|javascript/.test(type)) throw new Error(`Not a text page (${type.split(";")[0] || "unknown type"})`);
  const raw = (await r.text()).slice(0, MAX_PAGE_BYTES);
  const { title, text } = /html/.test(type) ? htmlToText(raw) : { title: "", text: raw };
  return { url: r.url || String(u), title, text: text.length > maxChars ? text.slice(0, maxChars) + `\n… (${text.length - maxChars} more characters)` : text };
}

module.exports = { search, fetchPage, htmlToText, hostOf };
