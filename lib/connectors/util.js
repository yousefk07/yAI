// Shared pieces for the connections (2026-10-21): encryption for tokens and saved URLs, fetch with a timeout, and a
// guard so a URL a person saves (a webhook, a calendar feed) can't point the server at itself or a private network.

const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const KEY = crypto.createHash("sha256").update(`${process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "yai"}:connectors`).digest();
const UA = "yAI/1.0 (+https://yousef-llmai.vercel.app)";

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const out = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), out].map((b) => b.toString("base64url")).join(".");
}
function decrypt(blob) {
  const [iv, tag, data] = String(blob).split(".").map((s) => Buffer.from(s, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}
const sign = (s) => crypto.createHmac("sha256", KEY).update(s).digest("base64url");

class ToolError extends Error {}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, Accept: "application/json", ...opts.headers }, signal: opts.signal || AbortSignal.timeout(opts.timeout || 12000) });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || data?.error_description || (typeof data?.error === "string" ? data.error : "") || text.slice(0, 200);
    throw new ToolError(`${new URL(url).hostname} returned ${r.status}${msg ? `: ${msg}` : ""}`);
  }
  return data;
}
async function fetchText(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...opts.headers }, signal: opts.signal || AbortSignal.timeout(opts.timeout || 12000) });
  const text = await r.text();
  if (!r.ok) throw new ToolError(`${new URL(url).hostname} returned ${r.status}`);
  return text;
}

// Private, loopback and link-local addresses (IPv4 and IPv6).
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s.startsWith("::ffff:")) return privateIp(s.slice(7));
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb");
}
// A URL someone saved: https only, and its host must resolve to public addresses.
async function publicUrl(raw, { hosts } = {}) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new ToolError("That isn't a valid link."); }
  if (u.protocol !== "https:") throw new ToolError("The link has to start with https://.");
  if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) throw new ToolError(`The link has to be on ${hosts.join(" or ")}.`);
  if (net.isIP(u.hostname)) { if (privateIp(u.hostname)) throw new ToolError("That address is private."); }
  else {
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new ToolError(`Couldn't find ${u.hostname}.`);
    if (addrs.some((a) => privateIp(a.address))) throw new ToolError("That address is private.");
  }
  return u.toString();
}

const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const stripHtml = (s) => String(s || "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const site = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

module.exports = { encrypt, decrypt, sign, ToolError, fetchJson, fetchText, publicUrl, privateIp, clip, stripHtml, site, UA };
