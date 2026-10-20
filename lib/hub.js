// /api/hub: the smaller features that share one function (the Hobby plan allows 12), chosen with ?op=.
//
//   GET    ?op=search&q=…           web search results (yAI Code's web_search tool)
//   GET    ?op=usage                 your usage: today against the limits, the last 30 days, all time
//   GET    ?op=usage-all             admins: everyone's usage (today and the last 30 days)
//   GET    ?op=projects              your Projects            GET ?op=project&id=…   one, with its files
//   PUT    ?op=project               save { id?, name, instructions, files: [{ id?, name, text }] }
//   DELETE ?op=project&id=…          delete one
//   GET    ?op=arena                 the arena leaderboard and the coding benchmark results
//   POST   ?op=vote                  an arena vote { a, b, winner: "a" | "b" | "tie" }
//   POST   ?op=bench                 a yAI Code /bench result

const crypto = require("crypto");
const { currentUser, isAdminAccount } = require("./session");
const store = require("./store");
const { sendJson, readBody, ULTRA_DAILY_USD, SEARCH_DAILY } = require("./handlers");
const { DAILY_LIMIT } = require("./images");
const { search } = require("./search");

const MAX_BODY = 1_000_000;
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

async function body(req) {
  const raw = await readBody(req);
  if (raw.length > MAX_BODY) throw Object.assign(new Error("Too large"), { status: 413 });
  return JSON.parse(raw);
}

// Today's use against each limit, for one person.
async function today(user) {
  const admin = isAdminAccount(user);
  const [images, videos, searches, spent] = await Promise.all([
    store.peekToday(`image:u:${user}`), store.peekToday(`video:u:${user}`), store.peekToday(`search:u:${user}`), store.getSpendToday(user),
  ]);
  return {
    admin,
    images: { used: images, limit: admin ? null : DAILY_LIMIT.image.user },
    videos: { used: videos, limit: admin ? null : DAILY_LIMIT.video.user },
    searches: { used: searches, limit: SEARCH_DAILY },
    ultra: { spentUsd: spent / 1e6, limitUsd: ULTRA_DAILY_USD },
    resetsAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
  };
}

async function handleHub(req, res) {
  const url = new URL(req.url, "http://x");
  const op = url.searchParams.get("op") || "";
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "Log in to use yAI", needsLogin: true });
  if (!store.STORE_ON && op !== "search") return sendJson(res, 503, { error: "This needs the site's storage, which isn't set up." });
  const noStore = { "Cache-Control": "no-store" };
  try {
    switch (`${req.method} ${op}`) {
      case "GET search": {
        const q = clip(url.searchParams.get("q"), 400).trim();
        if (!q) return sendJson(res, 400, { error: "Missing q" });
        if (store.STORE_ON && (await store.countToday(`search:u:${user}`).catch(() => 0)) > SEARCH_DAILY) {
          return sendJson(res, 429, { error: `You've used today's ${SEARCH_DAILY} web searches.` });
        }
        const results = await search(q, { count: Number(url.searchParams.get("n")) || 6 });
        if (store.STORE_ON) await store.trackUsage(user, { searches: 1 }).catch(() => {});
        return sendJson(res, 200, { results }, noStore);
      }

      case "GET usage": {
        const [t, history] = await Promise.all([today(user), store.getUsage(user, 30)]);
        return sendJson(res, 200, { user, today: t, ...history }, noStore);
      }
      case "GET usage-all": {
        if (!isAdminAccount(user)) return sendJson(res, 403, { error: "Admins only" });
        const users = await store.listUsers();
        const rows = await Promise.all(users.map(async (u) => {
          const [t, h] = await Promise.all([today(u.username), store.getUsage(u.username, 30)]);
          const month = {};
          for (const d of h.days) for (const [k, v] of Object.entries(d)) if (k !== "day") month[k] = (month[k] || 0) + v;
          return { username: u.username, createdAt: u.createdAt, today: t, todayCounts: h.days[h.days.length - 1], last30: month, total: h.total };
        }));
        return sendJson(res, 200, { users: rows.sort((a, b) => (b.last30.messages || 0) + (b.last30.codeMessages || 0) - (a.last30.messages || 0) - (a.last30.codeMessages || 0)) }, noStore);
      }

      case "GET projects":
        return sendJson(res, 200, { projects: await store.listProjects(user) }, noStore);
      case "GET project": {
        const p = await store.getProject(user, clip(url.searchParams.get("id"), 64));
        return p ? sendJson(res, 200, { project: p }, noStore) : sendJson(res, 404, { error: "Project not found" });
      }
      case "PUT project": {
        const b = await body(req);
        const id = ID_RE.test(b.id || "") ? b.id : crypto.randomUUID();
        const name = clip(b.name, 80).trim() || "Untitled project";
        const files = (Array.isArray(b.files) ? b.files : []).slice(0, 40)
          .filter((f) => f && typeof f.text === "string" && f.text.trim())
          .map((f) => ({ id: ID_RE.test(f.id || "") ? f.id : crypto.randomUUID(), name: clip(f.name, 160) || "file", text: f.text, chars: f.text.length }));
        const r = await store.putProject(user, { id, name, instructions: clip(b.instructions, 8000), files });
        return r.error ? sendJson(res, r.status, { error: r.error }) : sendJson(res, 200, { project: r.project });
      }
      case "DELETE project":
        return sendJson(res, 200, await store.deleteProject(user, clip(url.searchParams.get("id"), 64)));

      case "GET arena": {
        const [board, bench] = await Promise.all([store.arenaBoard(), store.listBench()]);
        // The benchmark table keeps each model's best run.
        const best = {};
        for (const r of bench) if (!best[r.model] || r.passed > best[r.model].passed || (r.passed === best[r.model].passed && r.secs < best[r.model].secs)) best[r.model] = r;
        return sendJson(res, 200, { board, bench: Object.values(best).sort((a, b) => b.passed - a.passed || a.secs - b.secs) }, noStore);
      }
      case "POST vote": {
        const b = await body(req);
        const a = clip(b.a, 80), bb = clip(b.b, 80);
        if (!a || !bb || a === bb || !["a", "b", "tie"].includes(b.winner)) return sendJson(res, 400, { error: "Invalid vote" });
        if ((await store.countToday(`vote:u:${user}`).catch(() => 0)) > 300) return sendJson(res, 429, { error: "That's a lot of votes for one day." });
        return sendJson(res, 200, { ratings: await store.arenaVote(a, bb, b.winner, user) });
      }
      case "POST bench": {
        const b = await body(req);
        const tasks = (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 20).map((t) => ({
          task: clip(t.task, 60), passed: Number(t.passed) || 0, total: Number(t.total) || 0, secs: Number(t.secs) || 0, tampered: !!t.tampered,
        }));
        const result = {
          model: clip(b.model, 80), label: clip(b.label, 80), passed: Number(b.passed) || 0, total: Number(b.total) || 0,
          solved: Number(b.solved) || 0, secs: Number(b.secs) || 0, tasks, user, ts: new Date().toISOString(),
        };
        if (!result.model || !result.total) return sendJson(res, 400, { error: "Invalid result" });
        await store.addBench(result);
        return sendJson(res, 200, { ok: true });
      }
      default:
        return sendJson(res, 404, { error: "Unknown op" });
    }
  } catch (err) {
    return sendJson(res, err.status || (err instanceof SyntaxError ? 400 : 502), { error: err instanceof SyntaxError ? "Invalid JSON" : err.message });
  }
}

module.exports = { handleHub };
