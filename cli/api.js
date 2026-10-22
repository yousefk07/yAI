"use strict";
// Talks to the yAI site: sign-in (the same account as the web app), models, warm-up and chat.

const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = path.join(os.homedir(), ".yai");
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

async function json(pathname, opts) {
  const res = await request(pathname, opts);
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
async function readEvents(res, onEvent) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
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
      if (onEvent(ev) === false) return;
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
const NET_ERROR = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|socket|other side closed|terminated|network|Bad Gateway|Service Unavailable|Gateway Time-?out|50[234]/i;
async function chat(opts) {
  let got = false;
  const onText = (piece) => { got = true; return opts.onText(piece); };
  for (let attempt = 0; ; attempt++) {
    try { return await chatOnce({ ...opts, onText }); }
    catch (err) {
      const msg = `${err.message} ${err.cause?.code || ""} ${err.cause?.message || ""}`;
      if (got || attempt >= 3 || opts.signal?.aborted || err.auth || !NET_ERROR.test(msg)) throw err;
      opts.onStatus?.(`connection dropped · trying again (${attempt + 1} of 3)`);
      await new Promise((r) => setTimeout(r, [1500, 4000, 9000][attempt]));
      if (opts.signal?.aborted) throw err;
    }
  }
}
async function chatOnce({ messages, model, system, context, conversationId, signal, onText, onTokens, onStatus, tools, toolFormat }) {
  // YAI_DEBUG_DIR=<folder>: keep each request (model, system prompt, messages) as JSON, to replay a model's odd reply.
  if (process.env.YAI_DEBUG_DIR) {
    try {
      fs.mkdirSync(process.env.YAI_DEBUG_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.YAI_DEBUG_DIR, `request-${Date.now()}.json`), JSON.stringify({ model, system, messages }, null, 1));
    } catch {}
  }
  const res = await request("/api/chat", {
    method: "POST",
    signal,
    // tools/toolFormat: for a host with native tool calling (DeepSeek's API), the site swaps the text format for the
    // tool list; other hosts ignore them
    body: { agent: true, system, context, messages, model, temperature: 0.3, conversationId, ...(tools && { tools, toolFormat }) },
  });
  if (res.status === 401) throw Object.assign(new Error("Your session expired. Run /login."), { auth: true });
  if (!res.ok) throw new Error(await errorOf(res));
  let usage, error, cost, fallback;
  await readEvents(res, (ev) => {
    if (ev.fallback) fallback = ev.fallback; // answered by the model's fallback (yAI Lite busy → DeepSeek Flash)
    if (ev.status && onStatus) onStatus(ev.status);
    if (ev.t) onTokens(ev.t);
    if (ev.error) error = ev.error;
    if (ev.done) usage = ev.usage;
    // What the reply cost (yAI Ultra), and today's total against the allowance, for the status line.
    if (ev.done && typeof ev.costUsd === "number") cost = { usd: ev.costUsd, todayUsd: ev.ultraTodayUsd, limitUsd: ev.ultraLimitUsd };
    if (ev.content) return onText(ev.content);
  });
  if (error) throw new Error(error);
  return { usage, cost, fallback };
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

// ---------- /share: publish a session at an unlisted link ----------
async function share(session) {
  return json("/api/share", { method: "POST", body: session });
}

// ---------- yai remote: tasks from the phone (the site's /remote page) ----------
async function hub(op, { method = "GET", body, signal } = {}) {
  return json(`/api/hub?op=${op}`, { method, body, signal });
}

module.exports = { hub, cfg, save, baseUrl, DIR, me, login, logout, models, warmup, chat, startMedia, pollMedia, cancelMedia, downloadVideo, share, search };
