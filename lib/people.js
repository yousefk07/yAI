// Admin controls (2026-10-20), for the People page (/people): everyone's use, their limits, blocks and flags.
//
//   GET    ?op=people               admins: every account with today, the last 30 days, limits, block and flags
//   PUT    ?op=policy               admins: { user, blocked?, reason?, limits?: { ultraUsd, images, videos, searches, voiceChars } }
//   DELETE ?op=flags&user=…         admins: dismiss someone's flags

const store = require("./store");
const policy = require("./policy");
const { sendJson } = require("./handlers");

const adminOnly = (fn) => async (c) => (c.admin ? fn(c) : sendJson(c.res, 403, { error: "Admins only" }));

const ops = {
  "GET people": adminOnly(async ({ res, today, noStore }) => {
    const [users, flagged] = await Promise.all([store.listUsers(), policy.flaggedUsers()]);
    const open = new Set(flagged);
    const rows = await Promise.all(users.map(async (u) => {
      const pol = await policy.getPolicy(u.username);
      const [t, h, flags] = await Promise.all([today(u.username, pol), store.getUsage(u.username, 30), policy.listFlags(u.username)]);
      const month = {};
      for (const d of h.days) for (const [k, v] of Object.entries(d)) if (k !== "day") month[k] = (month[k] || 0) + v;
      return {
        username: u.username, createdAt: u.createdAt, chats: u.chats, today: t, todayCounts: h.days[h.days.length - 1],
        last30: month, total: h.total, blocked: !!pol.blocked, reason: pol.reason || "", overrides: pol.limits || {},
        flags, flagged: open.has(u.username.toLowerCase()),
      };
    }));
    return sendJson(res, 200, { users: rows, defaults: policy.DEFAULTS, labels: policy.FLAG_LABELS }, noStore);
  }),

  "PUT policy": adminOnly(async ({ res, body, user }) => {
    const b = await body();
    const who = String(b.user || "").trim();
    if (!who || !(await store.listUsers()).some((u) => u.username.toLowerCase() === who.toLowerCase())) return sendJson(res, 404, { error: "No such account" });
    if (who.toLowerCase() === user.toLowerCase() && b.blocked === true) return sendJson(res, 400, { error: "You can't pause your own account." });
    return sendJson(res, 200, { policy: await policy.setPolicy(who, b, user) });
  }),

  "DELETE flags": adminOnly(async ({ res, url }) => {
    await policy.dismissFlags(String(url.searchParams.get("user") || ""));
    return sendJson(res, 200, { ok: true });
  }),
};

module.exports = { ops };
