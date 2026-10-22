// /api/hub: the smaller features that share one function (the Hobby plan allows 12), chosen with ?op=.
//
//   GET    ?op=search&q=…           web search results (yAI Code's web_search tool)
//   GET    ?op=usage                 your usage: today against the limits, the last 30 days, all time
//   GET    ?op=usage-all             admins: everyone's usage (today and the last 30 days)
//   GET    ?op=projects              your Projects            GET ?op=project&id=…   one, with its files
//   PUT    ?op=project               save { id?, name, instructions, files: [{ id?, name, text }] }
//   DELETE ?op=project&id=…          delete one
//   POST   ?op=bench                 a yAI Code /bench result
//   GET    ?op=memory                what yAI remembers about you { enabled, items }
//   POST   ?op=memory                add a fact { text }      PUT ?op=memory  { enabled } and/or { items }
//   DELETE ?op=memory&id=…           forget one fact (no id: forget everything)

const crypto = require("crypto");
const { currentUser, isAdminAccount } = require("./session");
const store = require("./store");
const { sendJson, readBody } = require("./handlers");
const policy = require("./policy");
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
async function today(user, pol) {
  const admin = isAdminAccount(user);
  const [images, videos, searches, spent, voice, limits] = await Promise.all([
    store.peekToday(`image:u:${user}`), store.peekToday(`video:u:${user}`), store.peekToday(`search:u:${user}`), store.getSpendToday(user),
    store.peekToday(`voice:u:${user}`), policy.limitsFor(user, pol),
  ]);
  return {
    admin,
    images: { used: images, limit: limits.images },
    videos: { used: videos, limit: limits.videos },
    searches: { used: searches, limit: limits.searches },
    voice: { used: voice, limit: limits.voiceChars },
    ultra: { spentUsd: spent / 1e6, limitUsd: limits.ultraUsd },
    resetsAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
  };
}

// The newer features' ops (2026-10-20), each module exporting { "METHOD op": handler }. Plain require() calls, so
// Vercel's bundler sees the files and ships them with the function.
const EXTRA = Object.assign({},
  require("./people").ops, require("./apikeys").ops, require("./voice").ops, require("./google").ops,
  require("./study").ops, require("./remote").ops, require("./chatsearch").ops, require("./push").ops, require("./schedule").ops, require("./connectors").ops, require("./answers").ops, require("./watchers").ops, require("./widget").ops);
const schedule = require("./schedule");

async function handleHub(req, res) {
  const url = new URL(req.url, "http://x");
  // A GitHub sign-in sent back to /api/hub itself (the GitHub app's callback set without ?op=…) is its callback.
  const op = url.searchParams.get("op") || (url.searchParams.get("code") && url.searchParams.get("state") ? "github-callback" : "");
  // The scheduler's knock (GitHub Actions every 5 minutes) comes without a sign-in.
  if (op === "tick") return schedule.tick(req, res).catch((err) => sendJson(res, 500, { error: err.message }));
  // the home-screen widget: no sign-in, its private link is the key (lib/widget.js)
  if (op === "widget") return require("./widget").publicWidget(req, res, url).catch((err) => sendJson(res, 500, { error: err.message }));
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "Log in to use yAI", needsLogin: true });
  if (!store.STORE_ON && op !== "search") return sendJson(res, 503, { error: "This needs the site's storage, which isn't set up." });
  if (await policy.isBlocked(user)) return sendJson(res, 403, { error: "This account has been paused by an admin.", blocked: true });
  const noStore = { "Cache-Control": "no-store" };
  try {
    switch (`${req.method} ${op}`) {
      case "GET search": {
        const q = clip(url.searchParams.get("q"), 400).trim();
        if (!q) return sendJson(res, 400, { error: "Missing q" });
        const max = (await policy.limitsFor(user)).searches;
        if (store.STORE_ON && (await store.countToday(`search:u:${user}`).catch(() => 0)) > max) {
          await policy.flag(user, "limits", `web searches: ${max} a day`, 86400);
          return sendJson(res, 429, { error: `You've used today's ${max} web searches.` });
        }
        const results = await search(q, { count: Number(url.searchParams.get("n")) || 6 });
        if (store.STORE_ON) await store.trackUsage(user, { searches: 1 }).catch(() => {});
        return sendJson(res, 200, { engine: results.engine, results }, noStore);
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

      case "GET memory":
        return sendJson(res, 200, await store.getMemory(user), noStore);
      case "POST memory": {
        const text = clip((await body(req)).text, 300).trim();
        if (!text) return sendJson(res, 400, { error: "Write something to remember" });
        await store.addMemories(user, [text]);
        return sendJson(res, 200, await store.getMemory(user), noStore);
      }
      case "PUT memory": {
        const b = await body(req);
        const mem = await store.getMemory(user);
        if (typeof b.enabled === "boolean") mem.enabled = b.enabled;
        if (Array.isArray(b.items)) mem.items = b.items.filter((m) => m && typeof m.text === "string" && m.text.trim())
          .map((m) => ({ id: clip(m.id, 24) || crypto.randomBytes(6).toString("hex"), text: clip(m.text, 300).trim(), ts: clip(m.ts, 40) || new Date().toISOString() }));
        return sendJson(res, 200, await store.putMemory(user, mem), noStore);
      }
      case "DELETE memory": {
        const id = url.searchParams.get("id");
        const mem = await store.getMemory(user);
        mem.items = id ? mem.items.filter((m) => m.id !== id) : [];
        return sendJson(res, 200, await store.putMemory(user, mem), noStore);
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
      default: {
        const fn = EXTRA[`${req.method} ${op}`];
        if (!fn) return sendJson(res, 404, { error: "Unknown op" });
        return await fn({ req, res, url, user, admin: isAdminAccount(user), body: () => body(req), today, noStore });
      }
    }
  } catch (err) {
    return sendJson(res, err.status || (err instanceof SyntaxError ? 400 : 502), { error: err instanceof SyntaxError ? "Invalid JSON" : err.message });
  }
}

module.exports = { handleHub };
