// Price and page watchers (2026-10-21): yAI checks a page every few hours and tells you (a notification, and a webhook
// if you pick one) when a price drops below your number, or when the page's text changes, with a line on what changed.
// The scheduler's knock (GitHub Actions, every 5 minutes) runs the ones that are due.
//
//   GET    ?op=watches                     { watches }
//   PUT    ?op=watch          { id?, url, kind: "price"|"change", below?, every?, webhook?, name? }   add or edit one
//   DELETE ?op=watch&id=…
//   POST   ?op=watch-check&id=…            check it now -> { watch, event }
//
//   watch:<user>   hash id -> JSON { id, url, name, kind, below, every (hours), webhook, last: { price, currency, hash,
//                  text }, history: [{ t, price }], events: [{ t, text }], lastCheck, status }
//   watch:due      sorted set "<user>|<id>" by the next check time

const crypto = require("crypto");
const store = require("./store");
const { sendJson, modelEntry, completeOnce, cloudOn } = require("./handlers");
const { notify } = require("./push");
const { publicUrl, stripHtml, clip, UA } = require("./connectors/util");

const MAX_WATCHES = 15;
const lower = (u) => String(u).toLowerCase();
const EVERY = [1, 6, 24];

async function getAll(user) {
  const flat = (await store.redis("HGETALL", `watch:${lower(user)}`)) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) { const w = store.parse(flat[i + 1]); if (w) out.push(w); }
  return out.sort((a, b) => (b.created || 0) - (a.created || 0));
}
async function save(user, w) {
  await store.pipeline([
    ["HSET", `watch:${lower(user)}`, w.id, JSON.stringify(w)],
    ["ZADD", "watch:due", (w.lastCheck || Date.now()) + w.every * 3600000, `${lower(user)}|${w.id}`],
  ]);
  return w;
}

// ---------- reading a page ----------
async function fetchHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": `Mozilla/5.0 (compatible; ${UA})`, "Accept-Language": "en-CA,en;q=0.9", Accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`The page answered ${r.status}`);
  return (await r.text()).slice(0, 2_000_000);
}
// The product price from the page's own data (JSON-LD offers, product meta tags, itemprop), before asking a model.
function priceFromHtml(html) {
  const num = (v) => { const n = parseFloat(String(v).replace(/[^\d.,]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : null; };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== "object") return null;
        if (Array.isArray(o)) { for (const x of o) { const r = walk(x); if (r) return r; } return null; }
        const offers = o.offers ? (Array.isArray(o.offers) ? o.offers : [o.offers]) : null;
        if (offers) for (const of of offers) { const p = num(of.price ?? of.lowPrice); if (p) return { price: p, currency: of.priceCurrency || "" }; }
        for (const k of ["@graph", "mainEntity", "itemListElement"]) { const r = walk(o[k]); if (r) return r; }
        return null;
      };
      const r = walk(JSON.parse(m[1]));
      if (r) return r;
    } catch {}
  }
  const meta = (p) => (new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${p}["'][^>]+content=["']([^"']+)`, "i").exec(html) || new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["']${p}["']`, "i").exec(html) || [])[1];
  const p = num(meta("product:price:amount") || meta("og:price:amount") || meta("price"));
  if (p) return { price: p, currency: meta("product:price:currency") || meta("og:price:currency") || meta("priceCurrency") || "" };
  return null;
}
const textOf = (html) => stripHtml(html.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ")).slice(0, 12000);
async function ask(system, user, maxTokens, who) {
  const m = modelEntry("deepseek-v4.1-flash");
  if (!m || !cloudOn(m)) return "";
  return completeOnce(m, m.id, [{ role: "system", content: system }, { role: "user", content: user }], maxTokens, AbortSignal.timeout(30000), who).catch(() => "");
}

// ---------- checking one ----------
async function check(user, w) {
  const html = await fetchHtml(w.url);
  const text = textOf(html);
  const title = clip(stripHtml((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || ""), 120);
  if (!w.name && title) w.name = title;
  let event = null;
  if (w.kind === "price") {
    let found = priceFromHtml(html);
    if (!found) {
      const r = String(await ask('Find the current price of the main product on this page. Reply with only JSON {"price": number or null, "currency": "CAD/USD/…"}.', `${title}\n\n${text.slice(0, 6000)}`, 60, user));
      try { const j = JSON.parse(r.match(/\{[\s\S]*\}/)[0]); if (Number(j.price) > 0) found = { price: Number(j.price), currency: j.currency || "" }; } catch {}
    }
    if (!found) throw new Error("Couldn't find a price on that page.");
    const before = w.last?.price;
    w.history = [...(w.history || []), { t: Date.now(), price: found.price }].slice(-60);
    const cur = found.currency || w.last?.currency || "";
    const fmt = (n) => `${cur === "USD" || cur === "CAD" || !cur ? "$" : ""}${n.toFixed(2)}${cur && cur !== "USD" && cur !== "CAD" ? ` ${cur}` : ""}`;
    if (w.below && found.price <= w.below && !(before && before <= w.below)) event = `Now ${fmt(found.price)}, at or under your ${fmt(w.below)}${before ? ` (was ${fmt(before)})` : ""}.`;
    else if (!w.below && before && found.price < before) event = `Dropped to ${fmt(found.price)} from ${fmt(before)}.`;
    w.last = { price: found.price, currency: cur };
  } else {
    const hash = crypto.createHash("sha1").update(text.replace(/\s+/g, " ").replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "")).digest("hex");
    if (w.last?.hash && w.last.hash !== hash) {
      const what = String(await ask("Two versions of the same web page's text, before and after. In one short sentence, say what changed that a person would care about (ignore ads, dates and counters). If nothing meaningful changed, reply NOTHING.", `Before:\n${clip(w.last.text, 5000)}\n\nAfter:\n${text.slice(0, 5000)}`, 120, user)).trim();
      if (what && !/^NOTHING\b/i.test(what)) event = clip(what, 300);
    }
    w.last = { hash, text: text.slice(0, 5000) };
  }
  w.lastCheck = Date.now();
  w.status = "ok";
  if (event) {
    w.events = [{ t: Date.now(), text: event }, ...(w.events || [])].slice(0, 20);
    await notify(user, { title: `${w.kind === "price" ? "Price" : "Page"} watch: ${clip(w.name || new URL(w.url).hostname, 60)}`, body: event, url: w.url, tag: `watch-${w.id}` }).catch(() => 0);
    if (w.webhook) {
      try {
        const c = require("./connectors");
        const h = (await c.getSettings(user)).webhooks.find((x) => x.id === w.webhook);
        if (h) await c.sendWebhook(h, `**${w.name || w.url}**\n${event}\n${w.url}`, user, { watch: w.url });
      } catch {}
    }
  }
  return event;
}

// The scheduler's knock: the watchers that are due, a few at a time, within the time it has.
async function runDue(until) {
  const due = (await store.redis("ZRANGEBYSCORE", "watch:due", 0, Date.now(), "LIMIT", 0, 12)) || [];
  let ran = 0;
  for (const member of due) {
    if (Date.now() > until) break;
    const [user, id] = member.split("|");
    const w = store.parse(await store.redis("HGET", `watch:${user}`, id));
    if (!w) { await store.redis("ZREM", "watch:due", member); continue; }
    try { await check(user, w); } catch (err) { w.status = clip(err.message, 160); w.lastCheck = Date.now(); }
    await save(user, w);
    ran++;
  }
  return ran;
}

// Adding one (from the page, or the chat's "Do it" card).
async function add(user, b, old = null) {
  const url = await publicUrl(b.url);
  if (!old && (await getAll(user)).length >= MAX_WATCHES) throw Object.assign(new Error(`You can have ${MAX_WATCHES} watchers.`), { status: 400 });
  const w = {
    id: old?.id || crypto.randomBytes(5).toString("hex"), url, name: clip(b.name || old?.name || "", 120),
    kind: /change|text|page/i.test(b.kind) ? "change" : "price",
    below: Number(b.below) > 0 ? Number(b.below) : null,
    every: EVERY.includes(Number(b.every)) ? Number(b.every) : old?.every || 6,
    webhook: /^[\w-]{1,40}$/.test(b.webhook || "") ? b.webhook : "",
    created: old?.created || Date.now(), last: old?.url === url ? old.last : null, history: old?.url === url ? old.history : [], events: old?.events || [],
    lastCheck: 0, status: "",
  };
  try { await check(user, w); } catch (err) { w.status = clip(err.message, 160); }
  w.lastCheck = Date.now();
  return save(user, w);
}

const ops = {
  "GET watches": async ({ res, user, noStore }) => sendJson(res, 200, { watches: (await getAll(user)).map(({ last, ...w }) => ({ ...w, price: last?.price ?? null, currency: last?.currency || "" })) }, noStore),
  "PUT watch": async ({ res, user, body }) => {
    const b = await body();
    const old = b.id ? store.parse(await store.redis("HGET", `watch:${lower(user)}`, String(b.id))) : null;
    try { const w = await add(user, b, old); return sendJson(res, 200, { watch: { ...w, price: w.last?.price ?? null } }); }
    catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }
  },
  "DELETE watch": async ({ res, user, url }) => {
    const id = String(url.searchParams.get("id") || "");
    await store.pipeline([["HDEL", `watch:${lower(user)}`, id], ["ZREM", "watch:due", `${lower(user)}|${id}`]]);
    return sendJson(res, 200, { ok: true });
  },
  "POST watch-check": async ({ res, user, url }) => {
    const w = store.parse(await store.redis("HGET", `watch:${lower(user)}`, String(url.searchParams.get("id") || "")));
    if (!w) return sendJson(res, 404, { error: "No such watcher" });
    let event = null;
    try { event = await check(user, w); } catch (err) { w.status = clip(err.message, 160); w.lastCheck = Date.now(); }
    await save(user, w);
    return sendJson(res, 200, { watch: { ...w, price: w.last?.price ?? null }, event });
  },
};

module.exports = { ops, runDue, add, priceFromHtml };
