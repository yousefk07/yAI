// Search your history (2026-10-20): every saved chat's title and messages, for the Ctrl+K search box.
//
//   GET ?op=search-chats&q=…   { results: [{ id, title, updatedAt, titleHit, hits: [{ i, role, snippet }] }] }
//   (i is the message's index in the chat, so the page can jump to it)

const store = require("./store");
const { sendJson } = require("./handlers");

const MAX_RESULTS = 40;
const BATCH = 25;

function snippet(text, words) {
  const low = text.toLowerCase();
  const at = Math.max(0, Math.min(...words.map((w) => low.indexOf(w)).filter((i) => i >= 0)));
  const start = Math.max(0, at - 60);
  return (start ? "…" : "") + text.slice(start, at + 140).replace(/```[\w+#. -]*/g, "").replace(/\s+/g, " ").trim() + (at + 140 < text.length ? "…" : "");
}

const ops = {
  "GET search-chats": async ({ res, user, url, noStore }) => {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 200);
    const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return sendJson(res, 200, { results: [] }, noStore);
    const list = await store.listChats(user); // newest first
    const results = [];
    for (let i = 0; i < list.length && results.length < MAX_RESULTS; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const chats = await store.pipeline(batch.map((c) => ["GET", `chat:${user.toLowerCase()}:${c.id}`]));
      batch.forEach((meta, j) => {
        const chat = store.parse(chats[j]);
        if (!chat || results.length >= MAX_RESULTS) return;
        const titleHit = words.every((w) => String(meta.title || "").toLowerCase().includes(w));
        const hits = [];
        (chat.messages || []).forEach((m, k) => {
          if (hits.length >= 3 || m.hidden || typeof m.content !== "string") return;
          const low = m.content.toLowerCase();
          if (words.every((w) => low.includes(w))) hits.push({ i: k, role: m.role, snippet: snippet(m.content, words) });
        });
        if (titleHit || hits.length) results.push({ id: meta.id, title: meta.title, updatedAt: meta.updatedAt, projectId: meta.projectId, titleHit, hits });
      });
    }
    return sendJson(res, 200, { results }, noStore);
  },
};

module.exports = { ops };
