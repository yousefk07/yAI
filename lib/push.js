// Phone and browser notifications (Web Push, 2026-10-21), with no dependencies: VAPID signing (ES256) and the
// aes128gcm payload encryption of RFC 8291, both from Node's crypto. The VAPID keys come from VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY, or are made once and kept in Redis, so it works without any setup.
//
//   GET    ?op=push-key              { publicKey }
//   POST   ?op=push-subscribe        { subscription }   this browser or phone gets notifications
//   DELETE ?op=push-subscribe&endpoint=…
//   POST   ?op=push-test             sends a test notification to every device of yours
//
//   push:<name>   hash  sha1(endpoint) -> JSON subscription

const crypto = require("crypto");
const store = require("./store");
const { sendJson } = require("./handlers");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");
const lower = (u) => String(u).toLowerCase();
const subId = (endpoint) => crypto.createHash("sha1").update(String(endpoint)).digest("hex").slice(0, 20);

let vapid = null;
async function keys() {
  if (vapid) return vapid;
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const saved = store.parse(await store.redis("GET", "vapid:keys").catch(() => null));
    if (saved) ({ pub, priv } = saved);
    else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = privateKey.export({ format: "jwk" });
      pub = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
      priv = jwk.d;
      void publicKey;
      // Only the first one wins, so two servers starting at once agree on the keys.
      await store.redis("SET", "vapid:keys", JSON.stringify({ pub, priv }), "NX");
      ({ pub, priv } = store.parse(await store.redis("GET", "vapid:keys")) || { pub, priv });
    }
  }
  const raw = fromB64u(pub);
  const key = crypto.createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)), d: priv } });
  vapid = { publicKey: pub, key };
  return vapid;
}

function vapidHeader(endpoint, v) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:yousefkkamel@gmail.com" }));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: v.key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.publicKey}`;
}

// RFC 8291: the message encrypted for this one subscription.
function encrypt(sub, payload) {
  const uaPublic = fromB64u(sub.keys.p256dh), authSecret = fromB64u(sub.keys.auth);
  const ecdh = crypto.createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}

// Sends { title, body, url } to every device the person turned notifications on for. Returns how many got it.
async function notify(user, message) {
  if (!store.STORE_ON) return 0;
  const flat = (await store.redis("HGETALL", `push:${lower(user)}`).catch(() => [])) || [];
  if (!flat.length) return 0;
  const v = await keys();
  const payload = JSON.stringify({ title: String(message.title || "yAI").slice(0, 120), body: String(message.body || "").slice(0, 300), url: message.url || "/", tag: message.tag });
  let sent = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const sub = store.parse(flat[i + 1]);
    if (!sub?.endpoint || !sub.keys) continue;
    try {
      const r = await fetch(sub.endpoint, {
        method: "POST",
        headers: { TTL: "86400", Urgency: "normal", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: vapidHeader(sub.endpoint, v) },
        body: encrypt(sub, payload),
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 404 || r.status === 410) await store.redis("HDEL", `push:${lower(user)}`, flat[i]); // that device unsubscribed
      else if (r.ok) sent++;
    } catch {}
  }
  return sent;
}

const ops = {
  "GET push-key": async ({ res, noStore }) => sendJson(res, 200, { publicKey: (await keys()).publicKey }, noStore),
  "POST push-subscribe": async ({ res, user, body }) => {
    const sub = (await body()).subscription;
    if (!sub || !/^https:\/\//.test(sub.endpoint || "") || !sub.keys?.p256dh || !sub.keys?.auth) return sendJson(res, 400, { error: "Invalid subscription" });
    if (((await store.redis("HLEN", `push:${lower(user)}`)) || 0) >= 10) return sendJson(res, 400, { error: "Too many devices. Turn notifications off on one first." });
    await store.redis("HSET", `push:${lower(user)}`, subId(sub.endpoint), JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }));
    return sendJson(res, 200, { ok: true });
  },
  "DELETE push-subscribe": async ({ res, user, url }) => {
    await store.redis("HDEL", `push:${lower(user)}`, subId(url.searchParams.get("endpoint") || ""));
    return sendJson(res, 200, { ok: true });
  },
  "POST push-test": async ({ res, user }) => {
    const n = await notify(user, { title: "yAI", body: "Notifications are on. Your scheduled tasks will show up here.", url: "/scheduled", tag: "test" });
    return n ? sendJson(res, 200, { sent: n }) : sendJson(res, 400, { error: "No device has notifications on yet." });
  },
};

module.exports = { ops, notify, encrypt, keys };
