"use strict";
// Talks to the yAI site: sign-in (the same account as the web app), models, warm-up and chat.

const fs = require("fs");
const os = require("os");
const path = require("path");

// YAI_DIR: another folder for the sign-in, settings and sessions (test/crew-team runs with a throwaway one)
const DIR = process.env.YAI_DIR || path.join(os.homedir(), ".yai");
const CONFIG_FILE = path.join(DIR, "config.json");
const DEFAULT_URL = "https://yousef-llmai.vercel.app";
const UA = "yai-code/1.0";

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
const cfg = load();
function save() {
  fs.mkdirSync(DIR, { recursive: true });
  // The session cookie is a 30-day login, so keep the file private to this user.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
const baseUrl = () => (process.env.YAI_URL || cfg.url || DEFAULT_URL).replace(/\/+$/, "");

async function request(pathname, { method = "GET", body, signal } = {}) {
  return fetch(baseUrl() + pathname, {
    method,
    signal,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      ...(cfg.cookie && { Cookie: cfg.cookie }),
    },
    body: body && JSON.stringify(body),
  });
}

async function errorOf(res) {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text).error || text;
  } catch {
    return /<html/i.test(text) ? `The site returned HTTP ${res.status}` : text.slice(0, 300) || `HTTP ${res.status}`;
  }
}

async function json(pathname, opts = {}) {
  // a plain request (sign-in, models, a web search, a page through the site) gets 2 minutes: none of them waits on a
  // model, and one that never came back held its agent with it (2026-10-23)
  const res = await request(pathname, { ...opts, signal: opts.signal ? AbortSignal.any?.([opts.signal, AbortSignal.timeout(120000)]) || opts.signal : AbortSignal.timeout(120000) });
  if (res.status === 401) throw Object.assign(new Error("Not signed in"), { auth: true });
  if (!res.ok) throw new Error(await errorOf(res));
  return res.json();
}

// ---------- account ----------
async function me() {
  if (!cfg.cookie) return null;
  const data = await json("/api/auth?action=me");
  return data.user || null;
}

async function login(username, password) {
  const res = await request("/api/auth?action=login", { method: "POST", body: { username, password } });
  if (!res.ok) throw new Error(await errorOf(res));
  const data = await res.json();
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const session = cookies.map((s) => s.split(";")[0]).find((s) => s.startsWith("yai_session="));
  if (!session) throw new Error("The site didn't return a session");
  cfg.cookie = session;
  cfg.user = data.user;
  save();
  return data.user;
}

async function logout() {
  await request("/api/auth?action=logout").catch(() => {});
  delete cfg.cookie;
  delete cfg.user;
  save();
}

// ---------- models ----------
async function models() {
  return json("/api/models");
}

// Streams Server-Sent Events (`data: {json}` lines) to onEvent.
// When onEvent returns false (a tool call is complete) reading goes on for a moment, for the final event only: it has the
// real token counts and cost (2026-10-22: stopping at once left most /team steps' cost estimated, and cached tokens
// unknown). With native tool calls the reply ends at the call, so it comes almost at once.
const TAIL_MS = 1200;
async function readEvents(res, onEvent, touch = () => {}) {
  const decoder = new TextDecoder();
  let buf = "", tailUntil = 0;
  const it = res.body[Symbol.asyncIterator]();
  for (;;) {
    touch(); // something came: the quiet timer starts again (see chatOnce)
    let step;
    if (tailUntil) {
      const left = tailUntil - Date.now();
      if (left <= 0) { it.return?.().catch?.(() => {}); return; }
      step = await Promise.race([it.next(), new Promise((r) => setTimeout(() => r(null), left))]);
      if (!step) { it.return?.().catch?.(() => {}); return; }
    } else step = await it.next();
    if (step.done) return;
    const chunk = step.value;
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (tailUntil) { if (ev.done) { onEvent(ev); it.return?.().catch?.(() => {}); return; } continue; }
      if (onEvent(ev) === false) tailUntil = Date.now() + TAIL_MS;
    }
  }
}

// Loads a local model on the PC or wakes the cloud GPU. onProgress gets a status string.
async function warmup(model, { signal, onProgress }) {
  const res = await request(`/api/warmup?model=${encodeURIComponent(model)}`, { signal });
  if (!res.ok) throw new Error(await errorOf(res));
  if ((res.headers.get("content-type") || "").includes("json")) {
    const d = await res.json();
    if (d.state === "error") throw new Error(d.error);
    return;
  }
  let error;
  await readEvents(res, (ev) => {
    if (ev.state === "error" || ev.error) error = ev.error || "Couldn't load the model";
    else if (ev.state === "waking") onProgress(`Waking the cloud GPU (${ev.elapsed || 0}s, can take a minute or two)`);
    else if (typeof ev.progress === "number" && ev.progress < 1) onProgress(`Loading model ${Math.round(ev.progress * 100)}%`);
  });
  if (error) throw new Error(error);
}

// One model reply in agent mode. onText gets each piece of text; return false from it to stop early.
// onStatus gets what the cloud GPU is doing (queued, starting...) until the reply starts.
// A dropped connection or a busy gateway before any reply text arrived is tried again, up to 3 times (2026-10-22: one
// "fetch failed" ended a /team builder 15 s in). Once text has arrived it isn't: the reply would start over twice.
// Matched against the error's message, code and cause separately (2026-10-22 review: "50[234]" anywhere matched
// "35024 tokens", and bare "network" or "socket" matched model errors).
const NET_ERROR = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_|socket hang up|other side closed|^terminated$|Bad Gateway|Service Unavailable|Gateway Time-?out|\bHTTP 50[234]\b/i;
// (callModel uses it too: a drop after the reply started keeps what came, 2026-10-23)
const isNetError = (err) => [err?.message, err?.cause?.code, err?.cause?.message].some((x) => x && NET_ERROR.test(String(x)));
async function chat(opts) {
  let got = false;
  const onText = (piece) => { got = true; return opts.onText(piece); };
  const onTokens = (n) => { got = true; return opts.onTokens?.(n); }; // thinking tokens count: a retry would bill them twice
  const onReasoning = (piece) => { got = true; return opts.onReasoning?.(piece); };
  for (let attempt = 0; ; attempt++) {
    try { return await chatOnce({ ...opts, onText, onTokens, onReasoning }); }
    catch (err) {
      const net = isNetError(err);
      if (got || attempt >= 3 || opts.signal?.aborted || err.auth || !net) throw err;
      opts.onStatus?.(`connection dropped · trying again (${attempt + 1} of 3)`);
      await new Promise((r) => setTimeout(r, [1500, 4000, 9000][attempt]));
      if (opts.signal?.aborted) throw err;
    }
  }
}
// think: "low" | "high" | "max" asks DeepSeek to think first (lib/handlers.js bodyFor); its reasoning arrives through
// onReasoning, and thinkingOff in the result says DeepSeek refused it for this chat
async function chatOnce({ messages, model, system, context, conversationId, signal, onText, onTokens, onStatus, onReasoning, tools, toolFormat, temperature, think }) {
  // YAI_DEBUG_DIR=<folder>: keep each request (model, system prompt, messages) as JSON, to replay a model's odd reply.
  if (process.env.YAI_DEBUG_DIR) {
    try {
      fs.mkdirSync(process.env.YAI_DEBUG_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.YAI_DEBUG_DIR, `request-${Date.now()}.json`), JSON.stringify({ model, system, messages }, null, 1));
    } catch {}
  }
  // Nothing at all from the site for 330 s (it ends any reply by 300 s) means the connection is dead: it's closed and
  // the request fails as a network error, so it's tried again or, with text already in, kept (2026-10-23: a /crew
  // background agent sat 8 minutes on an open connection that sent nothing, with no timer left to wake it).
  const quietMs = Number(process.env.YAI_IDLE_MS) || 330000;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) ctl.abort();
  let quiet = false, timer = null;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => { quiet = true; ctl.abort(); }, quietMs); };
  const wentQuiet = () => Object.assign(new Error(`the connection to yAI went quiet (nothing for ${Math.round(quietMs / 1000)} s): ETIMEDOUT`), { code: "ETIMEDOUT" });
  touch();
  try {
  let res;
  try {
    res = await request("/api/chat", {
      method: "POST",
      signal: ctl.signal,
      // tools/toolFormat: for a host with native tool calling (DeepSeek's API), the site swaps the text format for the
      // tool list; other hosts ignore them
      body: { agent: true, system, context, messages, model, temperature: temperature ?? 0.3, conversationId, ...(tools && { tools, toolFormat }), ...(think && { think }) },
    });
  } catch (err) { throw quiet ? wentQuiet() : err; }
  if (res.status === 401) throw Object.assign(new Error("Your session expired. Run /login."), { auth: true });
  if (!res.ok) throw new Error(await errorOf(res));
  let usage, error, cost, fallback, thinkingOff = false;
  try {
  await readEvents(res, (ev) => {
    if (ev.fallback) fallback = ev.fallback; // answered by the model's fallback (yAI Lite busy → DeepSeek Flash)
    if (ev.thinkingOff) thinkingOff = true;
    if (ev.r && onReasoning) onReasoning(ev.r);
    if (ev.status && onStatus) onStatus(ev.status);
    if (ev.t) onTokens(ev.t);
    if (ev.error) error = ev.error;
    if (ev.done) usage = ev.usage;
    // What the reply cost (yAI Ultra), and today's total against the allowance, for the status line.
    if (ev.done && typeof ev.costUsd === "number") cost = { usd: ev.costUsd, todayUsd: ev.ultraTodayUsd, limitUsd: ev.ultraLimitUsd };
    if (ev.content) return onText(ev.content);
  }, touch);
  } catch (err) { throw quiet ? wentQuiet() : err; }
  if (error) throw new Error(error);
  return { usage, cost, fallback, thinkingOff };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

// ---------- images and videos (the web app's Make Image / Make Video) ----------
// A job is started, then polled until the GPU is done (see lib/images.js on the site).
async function startMedia({ kind, prompt, image, aspect }) {
  return json("/api/image", { method: "POST", body: { kind, prompt, image, aspect } });
}
async function pollMedia(job, signal) {
  return json(`/api/image?job=${encodeURIComponent(job)}`, { signal });
}
async function cancelMedia(job) {
  await request(`/api/image?job=${encodeURIComponent(job)}`, { method: "DELETE" }).catch(() => {});
}
// A finished video is stored on the site; this downloads it.
async function downloadVideo(id, signal) {
  const res = await request(`/api/image?video=${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(await errorOf(res));
  return Buffer.from(await res.arrayBuffer());
}

// ---------- web search (the site's /api/hub) ----------
async function search(q) {
  return json(`/api/hub?op=search&q=${encodeURIComponent(q)}`);
}

// a page that refused a plain fetch, read through the site (Tavily Extract)
async function extract(url) {
  return json(`/api/hub?op=extract&url=${encodeURIComponent(url)}`);
}

// ---------- /share: publish a session at an unlisted link ----------
async function share(session) {
  return json("/api/share", { method: "POST", body: session });
}

// ---------- yai remote: tasks from the phone (the site's /remote page) ----------
async function hub(op, { method = "GET", body, signal } = {}) {
  return json(`/api/hub?op=${op}`, { method, body, signal });
}

module.exports = { hub, cfg, save, baseUrl, DIR, me, login, logout, models, warmup, chat, isNetError, startMedia, pollMedia, cancelMedia, downloadVideo, share, search, extract };
