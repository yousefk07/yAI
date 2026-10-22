// The connections that need no account: weather (Open-Meteo), maps (OpenStreetMap: Nominatim and OSRM), arXiv,
// Semantic Scholar, and Wolfram Alpha (one key for the whole site, WOLFRAM_APP_ID).

const { fetchJson, fetchText, ToolError, clip, site } = require("./util");

// ---------- weather ----------
const WMO = { 0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers", 82: "heavy showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail" };

// "Waterloo, ON" -> the best match for Waterloo whose region or country fits "ON".
async function geocodePlace(place) {
  const [name, ...rest] = String(place || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!name) throw new ToolError("Which place?");
  const d = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name, count: "10", language: "en" })}`);
  const list = d.results || [];
  if (!list.length) throw new ToolError(`Couldn't find a place called ${place}.`);
  // "ON", "Ontario", "Canada", "CA": each part must name the region or the country exactly
  const ABBR = { on: "ontario", bc: "british columbia", ab: "alberta", qc: "quebec", mb: "manitoba", sk: "saskatchewan", ns: "nova scotia", nb: "new brunswick", nl: "newfoundland and labrador", pe: "prince edward island", ny: "new york", ca: "california", tx: "texas", fl: "florida", wa: "washington", il: "illinois", ma: "massachusetts", uk: "united kingdom", usa: "united states", us: "united states" };
  const parts = rest.map((x) => x.toLowerCase()).map((x) => ABBR[x] || x);
  const names = (r) => [r.admin1, r.admin2, r.country, r.country_code].filter(Boolean).map((x) => String(x).toLowerCase());
  const fits = (r) => parts.every((w) => names(r).some((n) => n === w || (w.length >= 4 && n.startsWith(w))));
  return list.find(fits) || list[0];
}

const weather = {
  id: "weather", label: "Weather", desc: "Current weather and the week's forecast for any place", kind: "open",
  tools: [{
    name: "weather.forecast", params: { place: "city, region", days: "1-10, default 7" }, desc: "the current weather and the daily forecast for a place",
    async run(a) {
      const p = await geocodePlace(a.place);
      const days = Math.min(10, Math.max(1, parseInt(a.days, 10) || 7));
      const f = await fetchJson(`https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
        latitude: p.latitude, longitude: p.longitude, timezone: "auto", forecast_days: String(days),
        current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset",
      })}`);
      const c = f.current || {}, d = f.daily || {};
      const where = [p.name, p.admin1, p.country].filter(Boolean).join(", ");
      const lines = [`Weather for ${where} (local time ${c.time || ""}, ${f.timezone}):`,
        `Now: ${c.temperature_2m}°C (feels like ${c.apparent_temperature}°C), ${WMO[c.weather_code] || "?"}, humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h, precipitation ${c.precipitation} mm.`,
        "Daily:"];
      (d.time || []).forEach((day, i) => lines.push(`- ${new Date(day + "T12:00").toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" })}: ${WMO[d.weather_code[i]] || "?"}, ${d.temperature_2m_min[i]} to ${d.temperature_2m_max[i]}°C, ${d.precipitation_probability_max[i] ?? "?"}% chance of precipitation (${d.precipitation_sum[i]} mm), sunrise ${String(d.sunrise[i]).slice(11)}, sunset ${String(d.sunset[i]).slice(11)}`));
      return {
        text: lines.join("\n"),
        sources: [{ title: `Open-Meteo forecast for ${where}`, url: `https://open-meteo.com/en/docs#latitude=${p.latitude}&longitude=${p.longitude}`, site: "open-meteo.com" }],
        // the live card above the answer (public/cards.js)
        card: { kind: "weather", args: { place: a.place, days }, data: {
          place: [p.name, p.admin1].filter(Boolean).join(", "), country: p.country, tz: f.timezone, time: c.time,
          now: { temp: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, label: WMO[c.weather_code] || "", wind: c.wind_speed_10m, humidity: c.relative_humidity_2m },
          days: (d.time || []).map((day, i) => ({ date: day, code: d.weather_code[i], label: WMO[d.weather_code[i]] || "", min: d.temperature_2m_min[i], max: d.temperature_2m_max[i], pop: d.precipitation_probability_max[i] })),
        } },
      };
    },
  }],
};

// ---------- maps ----------
async function nominatim(q, limit = 5) {
  const list = await fetchJson(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: "jsonv2", limit: String(limit), addressdetails: "0" })}`, { headers: { "Accept-Language": "en" } });
  return list || [];
}
const fmtKm = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const fmtMin = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
const maps = {
  id: "maps", label: "Maps", desc: "Find places and get directions (OpenStreetMap)", kind: "open",
  tools: [
    {
      name: "maps.find", params: { query: "a place, address or kind of place with a town (e.g. 'coffee near Waterloo, ON')" }, desc: "find places and addresses with their location",
      async run(a) {
        const list = await nominatim(String(a.query || ""), 6);
        if (!list.length) return { text: `No places found for "${a.query}".` };
        return {
          text: list.map((p, i) => `${i + 1}. ${p.display_name} (${p.type}; ${(+p.lat).toFixed(5)}, ${(+p.lon).toFixed(5)}) https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`).join("\n"),
          sources: list.slice(0, 3).map((p) => ({ title: clip(p.display_name, 80), url: `https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`, site: "openstreetmap.org" })),
        };
      },
    },
    {
      name: "maps.route", params: { from: "start address or place", to: "destination", mode: "drive, walk, bike or transit" }, desc: "directions between two places: distance, time and the turns",
      async run(a) {
        const mode = /walk|foot/i.test(a.mode) ? "walk" : /bike|cycl/i.test(a.mode) ? "bike" : /transit|bus|train/i.test(a.mode) ? "transit" : "drive";
        const gmaps = `https://www.google.com/maps/dir/?api=1&${new URLSearchParams({ origin: String(a.from || ""), destination: String(a.to || ""), travelmode: { drive: "driving", walk: "walking", bike: "bicycling", transit: "transit" }[mode] })}`;
        if (mode === "transit") return { text: `Transit times aren't available here. Google Maps has them: ${gmaps}`, sources: [{ title: "Directions on Google Maps", url: gmaps, site: "google.com" }] };
        const [f] = await nominatim(String(a.from || ""), 1);
        const [t] = await nominatim(String(a.to || ""), 1);
        if (!f || !t) throw new ToolError(`Couldn't find ${!f ? a.from : a.to}.`);
        const base = { drive: "https://router.project-osrm.org/route/v1/driving", walk: "https://routing.openstreetmap.de/routed-foot/route/v1/driving", bike: "https://routing.openstreetmap.de/routed-bike/route/v1/driving" }[mode];
        const r = await fetchJson(`${base}/${f.lon},${f.lat};${t.lon},${t.lat}?overview=false&steps=true`);
        const route = r.routes?.[0];
        if (!route) throw new ToolError("No route found.");
        const steps = route.legs[0].steps.filter((s) => s.distance > 0 || s.maneuver.type === "arrive").slice(0, 25)
          .map((s) => `- ${s.maneuver.type}${s.maneuver.modifier ? " " + s.maneuver.modifier : ""}${s.name ? ` onto ${s.name}` : ""} (${fmtKm(s.distance)})`);
        return {
          text: `${mode === "drive" ? "Driving" : mode === "walk" ? "Walking" : "Cycling"} from ${f.display_name} to ${t.display_name}: ${fmtKm(route.distance)}, about ${fmtMin(route.duration)} (no live traffic).\nSteps:\n${steps.join("\n")}\nOpen in Google Maps: ${gmaps}`,
          sources: [{ title: "Directions on Google Maps", url: gmaps, site: "google.com" }],
        };
      },
    },
  ],
};

// ---------- Wolfram Alpha ----------
const wolfram = {
  id: "wolfram", label: "Wolfram Alpha", desc: "Exact maths, unit conversions, science and data", kind: "key", env: ["WOLFRAM_APP_ID"],
  tools: [{
    name: "wolfram.ask", params: { input: "the question or expression, in plain English or maths" }, desc: "exact answers for maths, physics, chemistry, unit conversions, dates and data",
    async run(a) {
      const input = String(a.input || "").trim();
      if (!input) throw new ToolError("What should Wolfram Alpha work out?");
      const url = `https://www.wolframalpha.com/api/v1/llm-api?${new URLSearchParams({ input, appid: process.env.WOLFRAM_APP_ID, maxchars: "3500" })}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      if (r.status === 501) return { text: `Wolfram Alpha didn't understand "${input}". ${clip(text, 400)}` };
      if (!r.ok) throw new ToolError(`Wolfram Alpha returned ${r.status}`);
      const link = `https://www.wolframalpha.com/input?i=${encodeURIComponent(input)}`;
      return { text: clip(text.replace(/\n\s*Wolfram\|Alpha website result.*$/s, ""), 3500), sources: [{ title: `Wolfram|Alpha: ${clip(input, 60)}`, url: link, site: "wolframalpha.com" }] };
    },
  }],
};

// ---------- arXiv ----------
const tag = (xml, t) => (new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(xml) || [])[1] || "";
const unxml = (s) => String(s).replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, " ").trim();
const arxiv = {
  id: "arxiv", label: "arXiv", desc: "Search research preprints in physics, maths, CS and more", kind: "open",
  tools: [{
    name: "arxiv.search", params: { query: "topic or title words", max: "1-10, default 6", sort: "relevance or newest" }, desc: "search arXiv papers: titles, authors, dates, abstracts and PDF links",
    async run(a) {
      const q = String(a.query || "").trim();
      if (!q) throw new ToolError("What should I search arXiv for?");
      const max = Math.min(10, Math.max(1, parseInt(a.max, 10) || 6));
      const SMALL = new Set("a an the of in on for to and or with by from at as is are via using about".split(" "));
      const words = q.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w && !SMALL.has(w.toLowerCase())).map((w) => `all:${encodeURIComponent(w)}`).join("+AND+");
      const xml = await fetchText(`https://export.arxiv.org/api/query?search_query=${words}&start=0&max_results=${max}&sortBy=${/new|date|recent/i.test(a.sort) ? "submittedDate" : "relevance"}&sortOrder=descending`, { timeout: 15000 });
      const entries = xml.split("<entry>").slice(1).map((e) => ({
        title: unxml(tag(e, "title")), summary: unxml(tag(e, "summary")), published: tag(e, "published").slice(0, 10),
        authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => unxml(m[1])),
        url: unxml(tag(e, "id")), pdf: (/href="([^"]+)"[^>]*title="pdf"/.exec(e) || /title="pdf"[^>]*href="([^"]+)"/.exec(e) || [])[1] || "",
      }));
      if (!entries.length) return { text: `No arXiv papers found for "${q}".` };
      return {
        text: entries.map((p, i) => `${i + 1}. "${p.title}" by ${p.authors.slice(0, 5).join(", ")}${p.authors.length > 5 ? " et al." : ""} (${p.published}) ${p.url}${p.pdf ? ` PDF: ${p.pdf}` : ""}\n   ${clip(p.summary, 600)}`).join("\n"),
        sources: entries.map((p) => ({ title: p.title, url: p.url, site: "arxiv.org" })),
      };
    },
  }],
};

// ---------- Semantic Scholar ----------
const S2 = "https://api.semanticscholar.org/graph/v1";
const s2 = (path) => fetchJson(`${S2}${path}`, { headers: process.env.S2_API_KEY ? { "x-api-key": process.env.S2_API_KEY } : {}, timeout: 15000 });
// OpenAlex, when Semantic Scholar is busy: the same kind of answer, from another open index of papers.
async function openAlex(q, limit, year) {
  const [from, to] = String(year || "").split("-");
  const filter = [from && `from_publication_date:${from}-01-01`, to && `to_publication_date:${to}-12-31`].filter(Boolean).join(",");
  const d = await fetchJson(`https://api.openalex.org/works?${new URLSearchParams({ search: q, "per-page": String(limit), ...(filter && { filter }), mailto: "yai@yousefkamel.site" })}`);
  const abstract = (inv) => { if (!inv) return ""; const words = []; for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w; return words.join(" "); };
  return (d.results || []).map((w) => ({
    title: w.title, year: w.publication_year, venue: w.primary_location?.source?.display_name, citationCount: w.cited_by_count,
    authors: (w.authorships || []).map((a) => ({ name: a.author?.display_name })), url: w.doi || w.id,
    openAccessPdf: w.open_access?.oa_url ? { url: w.open_access.oa_url } : null, abstract: abstract(w.abstract_inverted_index),
  }));
}
const paperLine = (p, i) => `${i + 1}. "${p.title}" (${p.year || "?"}${p.venue ? `, ${p.venue}` : ""}) by ${(p.authors || []).slice(0, 5).map((x) => x.name).join(", ")}${(p.authors || []).length > 5 ? " et al." : ""}; cited ${p.citationCount ?? "?"} times. ${p.url}${p.openAccessPdf?.url ? ` PDF: ${p.openAccessPdf.url}` : ""}\n   ${clip(p.tldr?.text || p.abstract || "", 500)}`;
const scholar = {
  id: "scholar", label: "Semantic Scholar", desc: "Search published papers with citation counts", kind: "open",
  tools: [
    {
      name: "scholar.search", params: { query: "topic or title words", limit: "1-10, default 6", year: "optional, e.g. 2020- or 2018-2022" }, desc: "find published papers across all fields, with citation counts, summaries and open PDFs",
      async run(a) {
        const q = String(a.query || "").trim();
        if (!q) throw new ToolError("What should I search for?");
        const limit = Math.min(10, Math.max(1, parseInt(a.limit, 10) || 6));
        let list, from = "semanticscholar.org";
        try {
          list = (await s2(`/paper/search?${new URLSearchParams({ query: q, limit: String(limit), fields: "title,year,authors,abstract,citationCount,url,venue,openAccessPdf,tldr", ...(a.year && { year: String(a.year) }) })}`)).data || [];
        } catch (err) {
          if (!/429|5\d\d/.test(err.message)) throw err;
          list = await openAlex(q, limit, a.year);
          from = "openalex.org";
        }
        if (!list.length) return { text: `No papers found for "${q}".` };
        return { text: list.map(paperLine).join("\n"), sources: list.map((p) => ({ title: p.title, url: p.url, site: from === "openalex.org" ? site(p.url) || from : from })) };
      },
    },
    {
      name: "scholar.paper", params: { id: "a Semantic Scholar id, DOI (DOI:...), arXiv id (ARXIV:...) or paper URL" }, desc: "one paper in detail: abstract, authors, and its most-cited references",
      async run(a) {
        let id = String(a.id || "").trim();
        if (/^https?:/.test(id)) id = `URL:${id}`;
        const p = await s2(`/paper/${encodeURIComponent(id)}?fields=title,year,authors,abstract,citationCount,referenceCount,url,venue,openAccessPdf,tldr,references.title,references.year,references.citationCount`);
        const refs = (p.references || []).filter((r) => r.title).sort((x, y) => (y.citationCount || 0) - (x.citationCount || 0)).slice(0, 8);
        return {
          text: `${paperLine(p, 0).replace(/^1\. /, "")}\nAbstract: ${clip(p.abstract || "(none)", 2500)}\nMost-cited references:\n${refs.map((r) => `- ${r.title} (${r.year || "?"}, cited ${r.citationCount ?? "?"})`).join("\n") || "(none listed)"}`,
          sources: [{ title: p.title, url: p.url, site: "semanticscholar.org" }],
        };
      },
    },
  ],
};

module.exports = { weather, maps, wolfram, arxiv, scholar, geocodePlace, site };
