// Study mode (2026-10-20): flashcard decks with spaced repetition, and practice quizzes, made from notes, PDFs or a
// chat. The tutor itself is a chat setting (payload.study in lib/handlers.js); this is the Study page's storage and
// the model calls that write cards and questions and grade short answers.
//
//   GET    ?op=decks                 your decks (no cards)
//   GET    ?op=deck&id=…             one deck with its cards and quizzes
//   PUT    ?op=deck                  save a deck { id?, title, cards, quizzes? }
//   DELETE ?op=deck&id=…
//   POST   ?op=study-make            { kind: "cards"|"quiz", text, title?, count? }  -> { title, cards } | { title, questions }
//   POST   ?op=study-grade           { question, expected, answer }                  -> { correct, score, feedback }
//
//   decks:<name>        hash  id -> JSON { id, title, cards, due, createdAt, updatedAt }
//   deck:<name>:<id>    JSON { id, title, cards: [...], quizzes: [...] }

const crypto = require("crypto");
const store = require("./store");
const policy = require("./policy");
const { sendJson, modelEntry, completeOnce, cloudOn } = require("./handlers");

const MAX_DECKS = 100;
const MAX_TEXT = 40000;
const lower = (u) => String(u).toLowerCase();
const id = () => crypto.randomBytes(8).toString("hex");
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

// yAI Ultra writes the best cards (yAI Ultra Flash if Ultra isn't set up). Both count toward the daily allowance.
async function pickModel(user) {
  const [spent, limits] = await Promise.all([store.getSpendToday(user).catch(() => 0), policy.limitsFor(user)]);
  if (spent >= limits.ultraUsd * 1e6) throw Object.assign(new Error(`You've used today's $${limits.ultraUsd} allowance. It resets at midnight UTC.`), { status: 429 });
  for (const id of ["deepseek-v4-pro", "deepseek-v4.1-flash"]) {
    const entry = modelEntry(id);
    if (entry && cloudOn(entry)) return { entry, id };
  }
  throw Object.assign(new Error("No cloud model is available to write study material right now."), { status: 503 });
}

function jsonIn(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error("The model didn't return any cards. Try again.");
  const open = text[start], close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  return JSON.parse(text.slice(start, end + 1));
}

async function make(user, { kind, text, title, count }) {
  const m = await pickModel(user);
  const n = Math.min(40, Math.max(3, Number(count) || (kind === "quiz" ? 8 : 15)));
  const material = clip(text, MAX_TEXT);
  const ask = kind === "quiz"
    ? `Write a practice quiz of ${n} questions on the material below: about two thirds multiple choice (4 options, one correct) and the rest short answer. ` +
      "Test understanding, not trivia; vary the difficulty. Reply with JSON only, no prose: " +
      '{"title": "short title", "questions": [{"type": "mc", "q": "question", "options": ["A", "B", "C", "D"], "answer": 0, "why": "one-sentence explanation"}, ' +
      '{"type": "short", "q": "question", "answer": "the model answer, one or two sentences", "why": "what a good answer must mention"}]}'
    : `Write ${n} flashcards on the material below. One idea per card; the front is a clear question or term, the back a short, ` +
      "complete answer (at most two sentences). Cover the most important ideas first. Use LaTeX ($...$) for math. Reply with JSON only, no prose: " +
      '{"title": "short title", "cards": [{"front": "...", "back": "..."}]}';
  const reply = await completeOnce(m.entry, m.id, [
    { role: "system", content: "You write study material for students. You reply with valid JSON only." },
    { role: "user", content: `${ask}\n\n<material>\n${material}\n</material>` },
  ], 6000, AbortSignal.timeout(100000), user);
  const data = jsonIn(reply);
  const name = clip(title || data.title || "Study set", 100);
  if (kind === "quiz") {
    const questions = (data.questions || []).filter((q) => q && q.q).slice(0, n).map((q) => q.type === "mc" && Array.isArray(q.options)
      ? { id: id(), type: "mc", q: clip(q.q, 600), options: q.options.slice(0, 6).map((o) => clip(o, 300)), answer: Math.max(0, Math.min(q.options.length - 1, Number(q.answer) || 0)), why: clip(q.why, 600) }
      : { id: id(), type: "short", q: clip(q.q, 600), answer: clip(q.answer, 1000), why: clip(q.why, 600) });
    if (!questions.length) throw new Error("The model didn't write any questions. Try again.");
    return { title: name, questions, model: m.entry.label };
  }
  const cards = (data.cards || []).filter((c) => c && c.front && c.back).slice(0, n)
    .map((c) => ({ id: id(), front: clip(c.front, 600), back: clip(c.back, 1500), box: 0, due: 0, right: 0, wrong: 0 }));
  if (!cards.length) throw new Error("The model didn't write any cards. Try again.");
  return { title: name, cards, model: m.entry.label };
}

const meta = (d) => ({ id: d.id, title: d.title, cards: d.cards.length, quizzes: (d.quizzes || []).length,
  due: d.cards.filter((c) => !c.due || c.due <= Date.now()).length, createdAt: d.createdAt, updatedAt: d.updatedAt });

const ops = {
  "GET decks": async ({ res, user, noStore }) => {
    const flat = (await store.redis("HGETALL", `decks:${lower(user)}`)) || [];
    const decks = [];
    for (let i = 0; i < flat.length; i += 2) { const d = store.parse(flat[i + 1]); if (d) decks.push(d); }
    return sendJson(res, 200, { decks: decks.sort((a, b) => String(b.updatedAt).localeCompare(a.updatedAt)) }, noStore);
  },
  "GET deck": async ({ res, user, url, noStore }) => {
    const d = store.parse(await store.redis("GET", `deck:${lower(user)}:${clip(url.searchParams.get("id"), 40)}`));
    return d ? sendJson(res, 200, { deck: d }, noStore) : sendJson(res, 404, { error: "Deck not found" });
  },
  "PUT deck": async ({ res, user, body }) => {
    const b = await body();
    const deckId = /^[a-f0-9]{16}$/.test(b.id || "") ? b.id : id();
    const old = store.parse(await store.redis("GET", `deck:${lower(user)}:${deckId}`));
    if (!old && ((await store.redis("HLEN", `decks:${lower(user)}`)) || 0) >= MAX_DECKS) return sendJson(res, 400, { error: `You can keep ${MAX_DECKS} decks. Delete one first.` });
    const now = new Date().toISOString();
    const deck = {
      id: deckId, title: clip(b.title, 100) || "Study set", createdAt: old?.createdAt || now, updatedAt: now,
      cards: (Array.isArray(b.cards) ? b.cards : []).slice(0, 500).filter((c) => c && c.front).map((c) => ({
        id: /^[a-f0-9]{16}$/.test(c.id || "") ? c.id : id(), front: clip(c.front, 600), back: clip(c.back, 1500),
        box: Math.max(0, Math.min(6, Number(c.box) || 0)), due: Number(c.due) || 0, right: Number(c.right) || 0, wrong: Number(c.wrong) || 0,
      })),
      quizzes: (Array.isArray(b.quizzes) ? b.quizzes : old?.quizzes || []).slice(-30),
    };
    const raw = JSON.stringify(deck);
    if (raw.length > 800_000) return sendJson(res, 413, { error: "That deck is too big." });
    await store.pipeline([["SET", `deck:${lower(user)}:${deckId}`, raw], ["HSET", `decks:${lower(user)}`, deckId, JSON.stringify(meta(deck))]]);
    return sendJson(res, 200, { deck });
  },
  "DELETE deck": async ({ res, user, url }) => {
    const deckId = clip(url.searchParams.get("id"), 40);
    await store.pipeline([["DEL", `deck:${lower(user)}:${deckId}`], ["HDEL", `decks:${lower(user)}`, deckId]]);
    return sendJson(res, 200, { ok: true });
  },
  "POST study-make": async ({ res, user, body }) => {
    const b = await body();
    if (String(b.text || "").trim().length < 40) return sendJson(res, 400, { error: "Add some notes first: paste text, attach a PDF, or pick a chat." });
    if ((await store.countToday(`study:u:${user}`).catch(() => 0)) > 60) return sendJson(res, 429, { error: "That's a lot of study sets for one day. Try again tomorrow." });
    const out = await make(user, { kind: b.kind === "quiz" ? "quiz" : "cards", text: b.text, title: b.title, count: b.count });
    store.trackUsage(user, { studySets: 1 }).catch(() => {});
    return sendJson(res, 200, out);
  },
  "POST study-grade": async ({ res, user, body }) => {
    const b = await body();
    const m = await pickModel(user);
    const reply = await completeOnce(m.entry, m.id, [
      { role: "system", content: "You grade a student's short answer fairly and kindly. Reply with JSON only." },
      { role: "user", content: `Question: ${clip(b.question, 800)}\nModel answer: ${clip(b.expected, 1200)}\nStudent's answer: ${clip(b.answer, 2000)}\n\n` +
        'Is the student right? Accept different wording and partial credit. Reply: {"score": 0 to 1, "feedback": "one or two sentences: what was right, what was missing"}' },
    ], 400, AbortSignal.timeout(60000), user);
    const g = jsonIn(reply);
    const score = Math.max(0, Math.min(1, Number(g.score) || 0));
    return sendJson(res, 200, { score, correct: score >= 0.7, feedback: clip(g.feedback, 600) });
  },
};

module.exports = { ops };
