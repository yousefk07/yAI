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
async function chat({ messages, model, system, conversationId, signal, onText, onTokens, onStatus }) {
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
    body: { agent: true, system, messages, model, temperature: 0.3, conversationId },
  });
  if (res.status === 401) throw Object.assign(new Error("Your session expired. Run /login."), { auth: true });
  if (!res.ok) throw new Error(await errorOf(res));
  let usage, error;
  await readEvents(res, (ev) => {
    if (ev.status && onStatus) onStatus(ev.status);
    if (ev.t) onTokens(ev.t);
    if (ev.error) error = ev.error;
    if (ev.done) usage = ev.usage;
    if (ev.content) return onText(ev.content);
  });
  if (error) throw new Error(error);
  return { usage };
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

// ---------- /share: publish a session at an unlisted link ----------
async function share(session) {
  return json("/api/share", { method: "POST", body: session });
}

module.exports = { cfg, save, baseUrl, DIR, me, login, logout, models, warmup, chat, startMedia, pollMedia, cancelMedia, downloadVideo, share };
