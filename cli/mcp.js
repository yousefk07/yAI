"use strict";
// MCP (Model Context Protocol) servers for yAI Code (2026-10-20): their tools show up next to yAI's own, named
// mcp__<server>__<tool>. Servers are listed like Claude Code's: { "mcpServers": { "<name>": { "command", "args", "env" } } }
// for a local server spoken to over stdio, or { "url", "headers" } for a remote one over Streamable HTTP.
//
// Where servers come from:
//   ~/.yai/config.json   "mcpServers"     yours, for every folder (/mcp add saves here)
//   .mcp.json or .yai/mcp.json             the project's; they run commands, so yAI asks once per project first
// No npm dependency: JSON-RPC over the child's stdin/stdout, or fetch.

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const WIN = process.platform === "win32";
const PROTOCOL = "2025-06-18";
const TIMEOUT = 60000;

class StdioServer {
  constructor(name, cfg, cwd) {
    this.name = name;
    this.cfg = cfg;
    this.cwd = cwd;
    this.pending = new Map();
    this.seq = 0;
    this.stderr = "";
  }
  start() {
    const env = { ...process.env, ...(this.cfg.env || {}) };
    // npx, uvx and friends are .cmd files on Windows, which only start through a shell; the line is quoted by hand.
    const quote = (a) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);
    const opts = { cwd: this.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
    this.child = WIN
      ? spawn([this.cfg.command, ...(this.cfg.args || [])].map(quote).join(" "), { ...opts, shell: true })
      : spawn(this.cfg.command, this.cfg.args || [], opts);
    let buf = "";
    this.child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // servers sometimes log to stdout
        }
        this.onMessage(msg);
      }
    });
    this.child.stderr.on("data", (d) => (this.stderr = (this.stderr + d.toString("utf8")).slice(-4000)));
    this.child.on("error", (err) => this.failAll(err.message));
    this.child.on("close", (code) => {
      this.closed = true;
      this.failAll(`the server exited (code ${code})${this.stderr ? `: ${this.stderr.trim().replace(/\s+/g, " ").slice(-200)}` : ""}`);
    });
  }
  onMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message || "MCP error")) : resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      // A request from the server (sampling, roots…): not supported, so answer politely instead of leaving it hanging.
      this.write({ jsonrpc: "2.0", id: msg.id, ...(msg.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Not supported by yAI Code" } }) });
    }
  }
  failAll(message) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    this.pending.clear();
  }
  write(obj) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(obj) + "\n");
  }
  request(method, params, timeout = TIMEOUT) {
    if (this.closed) return Promise.reject(new Error("the server isn't running"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer after ${Math.round(timeout / 1000)}s`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, ...(params && { params }) });
  }
  stop() {
    if (this.closed || !this.child) return;
    try {
      if (WIN) spawnSync("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { windowsHide: true });
      else this.child.kill();
    } catch {}
  }
}

class HttpServer {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.seq = 0;
    this.session = null;
  }
  start() {}
  async post(body, timeout) {
    const r = await fetch(this.cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL,
        ...(this.session && { "Mcp-Session-Id": this.session }), ...(this.cfg.headers || {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    return r;
  }
  async request(method, params, timeout = TIMEOUT) {
    const id = ++this.seq;
    const r = await this.post({ jsonrpc: "2.0", id, method, params }, timeout);
    if (r.status === 401) throw new Error("the server wants you to sign in (add an Authorization header in its config)");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = r.headers.get("content-type") || "";
    let msg;
    if (type.includes("text/event-stream")) {
      // The answer is one of the events in the stream.
      const text = await r.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data) continue;
        try {
          const m = JSON.parse(data);
          if (m.id === id) msg = m;
        } catch {}
      }
    } else msg = await r.json();
    if (!msg) throw new Error("no answer in the server's reply");
    if (msg.error) throw new Error(msg.error.message || "MCP error");
    return msg.result;
  }
  notify(method, params) {
    this.post({ jsonrpc: "2.0", method, ...(params && { params }) }, 10000).catch(() => {});
  }
  stop() {}
}

const safeName = (s) => String(s).replace(/[^\w-]/g, "_").slice(0, 48);

// Turns the model's text arguments into the types the tool's schema asks for.
function coerce(args, schema) {
  const props = (schema && schema.properties) || {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const type = Array.isArray(props[k]?.type) ? props[k].type[0] : props[k]?.type;
    const s = String(v).trim();
    if (type === "number" || type === "integer") out[k] = Number(s);
    else if (type === "boolean") out[k] = /^(true|yes|1)$/i.test(s);
    else if (type === "object" || type === "array") {
      try {
        out[k] = JSON.parse(s);
      } catch {
        out[k] = type === "array" ? s.split(/\s*,\s*/) : s;
      }
    } else out[k] = v;
  }
  return out;
}

// A tool result as text for the model (images and other media are named, not sent).
function resultText(result) {
  const parts = (result.content || []).map((c) => {
    if (c.type === "text") return c.text;
    if (c.type === "resource") return c.resource?.text || `[resource ${c.resource?.uri || ""}]`;
    if (c.type === "resource_link") return `[link: ${c.name || ""} ${c.uri || ""}]`;
    return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}]`;
  });
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 1));
  const text = parts.join("\n").trim() || "(no output)";
  return result.isError ? `Error from the tool: ${text}` : text;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// create({ root, api, T, version }) -> the MCP manager index.js uses.
module.exports = function create({ root, api, T, version }) {
  const servers = new Map(); // name -> { name, source, cfg, client, state, error, tools: [] }

  function configured() {
    const list = [];
    for (const [name, cfg] of Object.entries(api.cfg.mcpServers || {})) list.push({ name, cfg, source: "you" });
    for (const file of [".mcp.json", path.join(".yai", "mcp.json")]) {
      const data = readJson(path.join(root, file));
      for (const [name, cfg] of Object.entries((data && data.mcpServers) || {})) {
        if (!list.some((s) => s.name === name)) list.push({ name, cfg, source: file.replace(/\\/g, "/") });
      }
    }
    return list.filter((s) => s.cfg && (s.cfg.command || s.cfg.url) && !s.cfg.disabled);
  }

  async function connect(s) {
    const entry = { ...s, state: "starting", tools: [], error: "" };
    servers.set(s.name, entry);
    const client = s.cfg.url ? new HttpServer(s.name, s.cfg) : new StdioServer(s.name, s.cfg, root);
    entry.client = client;
    try {
      client.start();
      const init = await client.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "yai-code", version } }, 30000);
      client.notify("notifications/initialized");
      entry.serverInfo = init.serverInfo;
      let cursor;
      do {
        const page = await client.request("tools/list", cursor ? { cursor } : {});
        entry.tools.push(...(page.tools || []));
        cursor = page.nextCursor;
      } while (cursor && entry.tools.length < 500);
      for (const tool of entry.tools) register(entry, tool);
      entry.state = "ready";
    } catch (err) {
      entry.state = "failed";
      entry.error = err.message;
      client.stop();
    }
    return entry;
  }

  // Each MCP tool becomes a yAI tool: its parameters are the schema's properties, written as tags like any other.
  function register(entry, tool) {
    // a /team agent gets only the tools its server marks read-only (2026-10-22): it works without anyone watching,
    // and servers like GitHub or n8n can change things outside the project
    if (process.env.YAI_MCP_READONLY && !(tool.annotations && tool.annotations.readOnlyHint)) return;
    const name = `mcp__${safeName(entry.name)}__${safeName(tool.name)}`;
    const props = (tool.inputSchema && tool.inputSchema.properties) || {};
    const required = new Set((tool.inputSchema && tool.inputSchema.required) || []);
    const paramDocs = Object.entries(props).map(([k, p]) => `<${k}>${required.has(k) ? "" : " (optional)"} ${p.type || "string"}${p.description ? `: ${String(p.description).slice(0, 120)}` : ""}`);
    T.tools[name] = {
      params: Object.keys(props),
      describe: `[MCP server "${entry.name}"] ${String(tool.description || tool.title || tool.name).replace(/\s+/g, " ").slice(0, 400)}` +
        (paramDocs.length ? ` Parameters: ${paramDocs.join("; ")}. Objects and arrays are written as JSON.` : ""),
      kind: "mcp",
      readOnly: false,
      readOnlyHint: !!(tool.annotations && tool.annotations.readOnlyHint),
      server: entry.name,
      tool: tool.name,
      async call(args) {
        const result = await entry.client.request("tools/call", { name: tool.name, arguments: coerce(args, tool.inputSchema) }, 120000);
        return resultText(result || {});
      },
    };
  }

  function unregister(name) {
    for (const k of Object.keys(T.tools)) if (T.tools[k].kind === "mcp" && T.tools[k].server === name) delete T.tools[k];
  }

  // Starts every configured server. Project servers need the user's OK once (approve(list) asks and returns the names).
  async function startAll({ approve } = {}) {
    let list = configured();
    const fromProject = list.filter((s) => s.source !== "you");
    if (fromProject.length && approve) {
      const ok = await approve(fromProject);
      list = list.filter((s) => s.source === "you" || ok.includes(s.name));
    } else if (fromProject.length) list = list.filter((s) => s.source === "you");
    return Promise.all(list.map(connect));
  }

  function stopAll() {
    for (const s of servers.values()) s.client && s.client.stop();
  }

  async function restart(name) {
    const s = servers.get(name);
    if (!s) return null;
    s.client && s.client.stop();
    unregister(name);
    return connect(s);
  }

  function remove(name) {
    const s = servers.get(name);
    if (s) {
      s.client && s.client.stop();
      unregister(name);
      servers.delete(name);
    }
  }

  return { servers, configured, connect, startAll, stopAll, restart, remove, unregister };
};
