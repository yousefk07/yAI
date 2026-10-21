// Voice mode (2026-10-20): natural voices read answers aloud, and speech is turned into text, through ElevenLabs
// (ELEVENLABS_API_KEY) or OpenAI (OPENAI_API_KEY), whichever is set. Without either the page falls back to the
// browser's own voices and speech recognition, so voice mode always works.
//
//   GET  ?op=voice                 { provider, voices: [{ id, name }], limit, used }
//   POST ?op=tts   { text, voice } audio/mpeg (counts toward the daily voice characters)
//   POST ?op=stt   { audio: data URL (webm/ogg/mp4/wav), lang? }  { text }

const store = require("./store");
const policy = require("./policy");
const { sendJson } = require("./handlers");

const ELEVEN = process.env.ELEVENLABS_API_KEY || "";
const OPENAI = process.env.OPENAI_API_KEY || "";
const PROVIDER = ELEVEN ? "elevenlabs" : OPENAI ? "openai" : null;
const VOICES = {
  elevenlabs: [
    { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel · calm" }, { id: "pNInz6obpgDQGcFmaJgB", name: "Adam · deep" },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah · soft" }, { id: "ErXwobaYiN019PkySvjV", name: "Antoni · warm" },
    { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh · young" }, { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli · bright" },
  ],
  openai: ["coral", "alloy", "ash", "ballad", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"].map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1) })),
};
const MAX_TTS = 4000; // characters per request (the page reads long answers in parts)

const day = () => new Date().toISOString().slice(0, 10);
const voiceKey = (user) => `count:voice:u:${user}:${day()}`;

// Markdown and code read badly aloud: code blocks are left out and formatting removed.
function speakable(text) {
  return String(text || "")
    .replace(/```[\s\S]*?(```|$)/g, " (code shown on screen) ")
    .replace(/\$\$[\s\S]*?\$\$/g, " (an equation) ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\d+\]/g, "")
    .replace(/[*_`#>|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function tts(text, voice) {
  if (PROVIDER === "elevenlabs") {
    const id = VOICES.elevenlabs.some((v) => v.id === voice) ? voice : VOICES.elevenlabs[0].id;
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_128`, {
      method: "POST", headers: { "xi-api-key": ELEVEN, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }), signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`ElevenLabs returned ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const id = VOICES.openai.some((v) => v.id === voice) ? voice : "coral";
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: id, input: text, response_format: "mp3", instructions: "Speak naturally and warmly, at a relaxed pace." }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`OpenAI returned ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function stt(buf, mime, lang) {
  const form = new FormData();
  const ext = /ogg/.test(mime) ? "ogg" : /mp4|m4a|aac/.test(mime) ? "mp4" : /wav/.test(mime) ? "wav" : "webm";
  form.append("file", new Blob([buf], { type: mime }), `speech.${ext}`);
  if (PROVIDER === "elevenlabs") {
    form.append("model_id", "scribe_v1");
    if (lang) form.append("language_code", lang);
    const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": ELEVEN }, body: form, signal: AbortSignal.timeout(45000) });
    if (!r.ok) throw new Error(`ElevenLabs returned ${r.status}`);
    return (await r.json()).text || "";
  }
  form.append("model", "gpt-4o-mini-transcribe");
  if (lang) form.append("language", lang);
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI}` }, body: form, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`OpenAI returned ${r.status}`);
  return (await r.json()).text || "";
}

const ops = {
  "GET voice": async ({ res, user, noStore }) => {
    const limit = (await policy.limitsFor(user)).voiceChars;
    const used = Number(await store.redis("GET", voiceKey(user)).catch(() => 0)) || 0;
    return sendJson(res, 200, { provider: PROVIDER, voices: PROVIDER ? VOICES[PROVIDER] : [], limit, used }, noStore);
  },
  "POST tts": async ({ res, user, body }) => {
    if (!PROVIDER) return sendJson(res, 503, { error: "Natural voices aren't set up, so the browser's voice is used.", fallback: true });
    const b = await body();
    const text = speakable(b.text).slice(0, MAX_TTS);
    if (!text) return sendJson(res, 400, { error: "Nothing to read" });
    const limit = (await policy.limitsFor(user)).voiceChars;
    const [used] = await store.pipeline([["INCRBY", voiceKey(user), text.length], ["EXPIRE", voiceKey(user), 172800]]);
    if (limit !== null && used > limit) {
      await policy.flag(user, "limits", `voice: ${limit.toLocaleString()} characters a day`, 86400);
      return sendJson(res, 429, { error: "You've used today's natural voice, so the browser's voice is used until tomorrow.", fallback: true });
    }
    const audio = await tts(text, String(b.voice || ""));
    store.trackUsage(user, { voiceChars: text.length }).catch(() => {});
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": audio.length });
    return res.end(audio);
  },
  "POST stt": async ({ res, user, body }) => {
    if (!PROVIDER) return sendJson(res, 503, { error: "Speech recognition isn't set up on the site.", fallback: true });
    const b = await body();
    const m = /^data:(audio\/[\w.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.audio || ""));
    if (!m) return sendJson(res, 400, { error: "Invalid audio" });
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 700_000) return sendJson(res, 413, { error: "That recording is too long. Keep it under a minute." });
    const text = await stt(buf, m[1], /^[a-z]{2}$/.test(b.lang || "") ? b.lang : "");
    store.trackUsage(user, { voiceInputs: 1 }).catch(() => {});
    return sendJson(res, 200, { text: text.trim() });
  },
};

module.exports = { ops, speakable };
