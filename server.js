// Local dev server: serves ./public and the same /api handlers Vercel uses.
// Run with `npm start`; talks to LM Studio directly at LMSTUDIO_URL.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleModels, handleChat, handleWarmup, LMSTUDIO_URL } = require("./lib/handlers");
const { handleLogin, handleLogout, handleActivity } = require("./lib/admin");
const { handleAuth, handleChats } = require("./lib/accounts");
const { handleImage } = require("./lib/images");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

const ROUTES = {
  "GET /api/models": handleModels,
  "POST /api/chat": handleChat,
  "GET /api/warmup": handleWarmup,
  "POST /api/admin/login": handleLogin,
  "POST /api/admin/logout": handleLogout,
  "GET /api/admin/activity": handleActivity,
  "GET /api/auth": handleAuth,
  "POST /api/auth": handleAuth,
  "GET /api/chats": handleChats,
  "PUT /api/chats": handleChats,
  "DELETE /api/chats": handleChats,
  "POST /api/image": handleImage,
  "PUT /api/image": handleImage,
  "GET /api/image": handleImage,
  "DELETE /api/image": handleImage,
};

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  else if (!path.extname(urlPath)) urlPath += ".html"; // /admin -> admin.html, like Vercel
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  const handler = ROUTES[`${req.method} ${pathname}`];
  if (handler) return handler(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`Chat UI:   http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`Admin:     http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/admin`);
  console.log(`LM Studio: ${LMSTUDIO_URL}`);
});
