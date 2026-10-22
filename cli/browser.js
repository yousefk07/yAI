"use strict";
// A small headless browser for /look and /showcase: the user's own Chrome (or Edge) driven over the
// DevTools protocol, a static file server for projects that are plain HTML, and ffmpeg for videos.
// No npm dependencies: Node's built-in WebSocket and http are enough.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");

const WIN = process.platform === "win32";

function firstExisting(list) {
  return list.find((p) => p && fs.existsSync(p)) || "";
}
function which(name) {
  try {
    return execSync(WIN ? `where ${name}` : `command -v ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().split(/\r?\n/)[0].trim();
  } catch {
    return "";
  }
}

// Chrome, Edge or Chromium; YAI_CHROME overrides.
function findChrome() {
  const env = process.env;
  return (
    firstExisting([
      env.YAI_CHROME,
      ...(WIN
        ? [
            path.join(env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
            path.join(env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
            path.join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
            path.join(env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
            path.join(env.ProgramFiles || "", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]),
    ]) || ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"].map(which).find(Boolean) || ""
  );
}

// ffmpeg on the PATH, or where winget puts it; YAI_FFMPEG overrides.
function findFfmpeg() {
  if (process.env.YAI_FFMPEG && fs.existsSync(process.env.YAI_FFMPEG)) return process.env.YAI_FFMPEG;
  const onPath = which("ffmpeg");
  if (onPath) return onPath;
  if (!WIN) return "";
  const base = path.join(process.env.LOCALAPPDATA || "", "Microsoft/WinGet/Packages");
  try {
    for (const pkg of fs.readdirSync(base).filter((d) => /ffmpeg/i.test(d))) {
      for (const sub of fs.readdirSync(path.join(base, pkg))) {
        const exe = path.join(base, pkg, sub, "bin", "ffmpeg.exe");
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch {}
  return "";
}

// Serves a folder over http://127.0.0.1:<port>/ for pages that are plain files (no dev server).
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".woff": "font/woff", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".txt": "text/plain",
};
function serveFolder(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const file = path.normalize(path.join(dir, p));
      if (!file.startsWith(path.normalize(dir))) return res.writeHead(403).end();
      fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end("Not found");
        res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

// Opens a headless browser. Returns { send(method, params), waitFor(event), close() } for one page.
async function launch({ width = 1280, height = 720 } = {}) {
  const exe = findChrome();
  if (!exe) throw new Error("No Chrome or Edge found. Install Chrome, or set YAI_CHROME to the browser's path.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "yai-browser-"));
  const proc = spawn(exe, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--mute-audio", "--disable-extensions", `--window-size=${width},${height}`, "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  const close = () => {
    try { proc.kill(); } catch {}
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 1500);
  };
  try {
    // Chrome writes the port it picked into DevToolsActivePort.
    const portFile = path.join(profile, "DevToolsActivePort");
    const until = Date.now() + 20000;
    // On Windows the file can be locked for a moment while Chrome writes it (EBUSY), so a failed read just waits.
    const readPort = () => {
      try {
        return fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
      } catch {
        return "";
      }
    };
    let port;
    while (!(port = readPort())) {
      if (Date.now() > until) throw new Error("The browser didn't start.");
      await new Promise((r) => setTimeout(r, 100));
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("Couldn't connect to the browser.")); });
    let id = 0;
    const pending = new Map(), waiters = [], listeners = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const w of waiters.filter((x) => x.method === msg.method)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
        for (const l of listeners) if (l.method === msg.method) { try { l.fn(msg.params); } catch {} }
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    const waitFor = (method, ms = 15000) => new Promise((resolve) => {
      const w = { method, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
    });
    await send("Page.enable");
    await send("Runtime.enable");
    // on(): every time an event comes (console errors, failed loads; /team's browser check, 2026-10-21)
    const on = (method, fn) => listeners.push({ method, fn });
    return { send, waitFor, on, close: () => { try { ws.close(); } catch {} close(); } };
  } catch (err) {
    close();
    throw err;
  }
}

// Page helpers on top of a launched browser.
async function setViewport(b, width, height, mobile = false) {
  await b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
}
async function open(b, url) {
  const loaded = b.waitFor("Page.loadEventFired", 20000);
  await b.send("Page.navigate", { url });
  await loaded;
  await new Promise((r) => setTimeout(r, 700)); // fonts, images, first animations
}
async function evaluate(b, expression) {
  const r = await b.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result ? r.result.value : undefined;
}
async function screenshot(b, { quality = 70 } = {}) {
  const r = await b.send("Page.captureScreenshot", { format: "jpeg", quality });
  return Buffer.from(r.data, "base64");
}

module.exports = { findChrome, findFfmpeg, serveFolder, launch, setViewport, open, evaluate, screenshot };
