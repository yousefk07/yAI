// Live data (2026-10-21): stock quotes (Yahoo Finance) and sports scores (ESPN), no keys needed. Like weather, each
// returns a card the chat draws above the answer and keeps up to date while it's on screen (?op=card refreshes it).

const { fetchJson, ToolError, clip } = require("./util");

// ---------- stocks ----------
const YF = "https://query1.finance.yahoo.com";
const YH = { "User-Agent": "Mozilla/5.0 (compatible; yAI/1.0)" };
async function symbolOf(q) {
  const s = String(q || "").trim();
  if (!s) throw new ToolError("Which stock?");
  if (/^[A-Z^][A-Z0-9.\-=^]{0,11}$/.test(s)) return s;
  const d = await fetchJson(`${YF}/v1/finance/search?${new URLSearchParams({ q: s, quotesCount: "5", newsCount: "0" })}`, { headers: YH });
  const hit = (d.quotes || []).find((x) => ["EQUITY", "ETF", "CRYPTOCURRENCY", "INDEX", "MUTUALFUND", "CURRENCY"].includes(x.quoteType)) || d.quotes?.[0];
  if (!hit) throw new ToolError(`No stock found for "${s}".`);
  return hit.symbol;
}
async function quote(q) {
  const symbol = await symbolOf(q);
  const d = await fetchJson(`${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false`, { headers: YH });
  const r = d.chart?.result?.[0];
  if (!r) throw new ToolError(`No quote for ${symbol}.`);
  const m = r.meta, closes = r.indicators?.quote?.[0]?.close || [];
  const points = (r.timestamp || []).map((t, i) => [t * 1000, closes[i]]).filter((p) => p[1] != null);
  const price = m.regularMarketPrice, prev = m.chartPreviousClose ?? m.previousClose;
  const change = prev ? price - prev : 0;
  const now = Date.now() / 1000;
  const open = m.currentTradingPeriod?.regular && now >= m.currentTradingPeriod.regular.start && now <= m.currentTradingPeriod.regular.end;
  return {
    symbol: m.symbol, name: m.longName || m.shortName || m.symbol, currency: m.currency, exchange: m.fullExchangeName || m.exchangeName,
    price, prev, change, pct: prev ? (change / prev) * 100 : 0, high: m.regularMarketDayHigh, low: m.regularMarketDayLow,
    open: !!open, time: (m.regularMarketTime || 0) * 1000, points: points.filter((_, i) => i % Math.ceil(points.length / 80 || 1) === 0).map((p) => [p[0], +p[1].toFixed(4)]),
  };
}
const stocks = {
  id: "stocks", label: "Stocks", desc: "Live stock, crypto and index prices", kind: "open",
  tools: [{
    name: "stocks.quote", params: { symbol: "ticker like AAPL, SHOP.TO, BTC-USD, or a company name" }, desc: "a live stock, ETF, crypto or index price with today's change",
    async run(a) {
      const q = await quote(a.symbol || a.query || a.name);
      const sign = q.change >= 0 ? "+" : "−";
      return {
        text: `${q.name} (${q.symbol}, ${q.exchange}): ${q.price} ${q.currency}, ${sign}${Math.abs(q.change).toFixed(2)} (${sign}${Math.abs(q.pct).toFixed(2)}%) today; day range ${q.low}–${q.high}; market ${q.open ? "open" : "closed"}; as of ${new Date(q.time).toUTCString()}.`,
        sources: [{ title: `${q.symbol} on Yahoo Finance`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(q.symbol)}`, site: "finance.yahoo.com" }],
        card: { kind: "stock", args: { symbol: q.symbol }, data: q },
      };
    },
  }],
};

// ---------- sports ----------
const LEAGUES = {
  nhl: ["hockey/nhl", "NHL"], nba: ["basketball/nba", "NBA"], wnba: ["basketball/wnba", "WNBA"], nfl: ["football/nfl", "NFL"], mlb: ["baseball/mlb", "MLB"],
  mls: ["soccer/usa.1", "MLS"], epl: ["soccer/eng.1", "Premier League"], "premier league": ["soccer/eng.1", "Premier League"], laliga: ["soccer/esp.1", "LaLiga"],
  "la liga": ["soccer/esp.1", "LaLiga"], "serie a": ["soccer/ita.1", "Serie A"], bundesliga: ["soccer/ger.1", "Bundesliga"], "champions league": ["soccer/uefa.champions", "Champions League"],
  ucl: ["soccer/uefa.champions", "Champions League"], ncaaf: ["football/college-football", "College football"], cfl: ["football/cfl", "CFL"],
};
async function scores(league, team) {
  const key = String(league || "").toLowerCase().trim();
  const L = LEAGUES[key] || Object.entries(LEAGUES).find(([k]) => key.includes(k))?.[1];
  if (!L) throw new ToolError(`Which league? ${[...new Set(Object.values(LEAGUES).map((x) => x[1]))].join(", ")}.`);
  const d = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${L[0]}/scoreboard`, { headers: YH });
  const want = String(team || "").toLowerCase().trim();
  const games = (d.events || []).map((e) => {
    const c = e.competitions?.[0] || {};
    const side = (h) => { const t = (c.competitors || []).find((x) => x.homeAway === h) || {}; return { name: t.team?.shortDisplayName || t.team?.displayName || "?", full: t.team?.displayName || "", abbr: t.team?.abbreviation || "", logo: t.team?.logo || "", score: t.score ?? "", record: t.records?.[0]?.summary || "" }; };
    const st = e.status?.type || {};
    return { id: e.id, away: side("away"), home: side("home"), state: st.state, status: st.shortDetail || st.description || "", start: e.date, link: e.links?.[0]?.href || "" };
  }).filter((g) => !want || [g.away, g.home].some((t) => [t.name, t.full, t.abbr].some((n) => n.toLowerCase().includes(want))));
  return { league: L[1], leagueKey: key, team: team || "", games: games.slice(0, 12), day: d.day?.date || "" };
}
const sports = {
  id: "sports", label: "Scores", desc: "Live scores and today's games (NHL, NBA, NFL, MLB, soccer…)", kind: "open",
  tools: [{
    name: "sports.scores", params: { league: "nhl, nba, nfl, mlb, mls, epl, laliga, champions league…", team: "optional team name to filter" }, desc: "live scores and today's schedule for a league or a team",
    async run(a) {
      const s = await scores(a.league, a.team);
      const line = (g) => `${g.away.name} ${g.away.score} @ ${g.home.name} ${g.home.score} (${g.state === "pre" ? new Date(g.start).toUTCString() : g.status})`;
      return {
        text: s.games.length ? `${s.league}${s.team ? ` (${s.team})` : ""}, ${s.day || "today"}:\n${s.games.map(line).join("\n")}` : `No ${s.league} games${s.team ? ` for ${s.team}` : ""} today.`,
        sources: [{ title: `${s.league} scores on ESPN`, url: `https://www.espn.com/${(LEAGUES[s.leagueKey] || ["", ""])[0].split("/")[1] || ""}/scoreboard`, site: "espn.com" }],
        card: { kind: "sports", args: { league: a.league, team: a.team || "" }, data: s },
      };
    },
  }],
};

module.exports = { stocks, sports, quote, scores };
