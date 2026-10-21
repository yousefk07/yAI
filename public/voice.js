// Voice mode (2026-10-20): speak instead of typing (the mic), hear answers read aloud (Listen under each answer), and
// voice chat, a hands-free conversation (listen → answer → speak → listen). Natural voices and transcription come
// from the site (lib/voice.js: ElevenLabs or OpenAI); without them the browser's own voice and recognition are used.
(function () {
  let cfg = { provider: null, voices: [] };
  let voiceId = store.get("voiceId", "");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

  async function loadConfig() {
    try {
      const r = await fetch("/api/hub?op=voice", { cache: "no-store" });
      if (r.ok) cfg = await r.json();
    } catch {}
    if (!cfg.voices.some((v) => v.id === voiceId)) voiceId = cfg.voices[0]?.id || "";
    const premium = cfg.provider && canRecord;
    $("micBtn").hidden = !premium && !SR;
    $("voiceBtn").hidden = !premium && !SR;
  }

  // ---------- Recording (for the site's transcription) ----------
  // Records until stop() or, with autoStop, until about 1.3 s of quiet after speech. onLevel gets 0..1.
  async function record({ autoStop = false, onLevel, maxMs = 60000 } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = ac.createAnalyser();
    an.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    let spoke = false, quietSince = 0, stopTimer = null, raf = 0;
    const started = Date.now();
    const done = new Promise((resolve) => {
      rec.onstop = () => {
        cancelAnimationFrame(raf);
        clearTimeout(stopTimer);
        stream.getTracks().forEach((t) => t.stop());
        ac.close().catch(() => {});
        resolve({ blob: new Blob(chunks, { type: rec.mimeType || "audio/webm" }), spoke, ms: Date.now() - started });
      };
    });
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += (v - 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / buf.length) / 40);
      onLevel?.(level);
      if (level > 0.18) { spoke = true; quietSince = 0; }
      else if (spoke && !quietSince) quietSince = Date.now();
      if (autoStop && spoke && quietSince && Date.now() - quietSince > 1300) return stop();
      if (rec.state === "recording") raf = requestAnimationFrame(tick);
    };
    const stop = () => { if (rec.state === "recording") rec.stop(); };
    rec.start(250);
    tick();
    stopTimer = setTimeout(stop, maxMs);
    return { stop, done };
  }
  const toDataUrl = (blob) => new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsDataURL(blob); });
  async function transcribe(blob) {
    const r = await api("/api/hub?op=stt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: await toDataUrl(blob), lang: (navigator.language || "").slice(0, 2) }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Couldn't understand that");
    return d.text || "";
  }
  // The browser's recognition: one phrase, with words shown as they're heard.
  function recognizeOnce({ onInterim } = {}) {
    return new Promise((resolve, reject) => {
      const rec = new SR();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      let final = "";
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) (e.results[i].isFinal ? (final += e.results[i][0].transcript) : (interim += e.results[i][0].transcript));
        onInterim?.(final + interim);
      };
      rec.onerror = (e) => (e.error === "no-speech" ? resolve("") : reject(new Error(e.error === "not-allowed" ? "The microphone is blocked for this site" : e.error)));
      rec.onend = () => resolve(final.trim());
      rec.start();
      recognizeOnce.current = rec;
    });
  }

  // ---------- The mic: dictate into the message box ----------
  let micRec = null;
  $("micBtn").addEventListener("click", async () => {
    const btn = $("micBtn");
    if (micRec) return micRec.stop();
    if (btn.classList.contains("on")) { recognizeOnce.current?.stop(); return; }
    const before = input.value.trim();
    const put = (t) => { input.value = (before ? before + " " : "") + t; autosize(); };
    btn.classList.add("on");
    btn.title = "Stop";
    try {
      if (cfg.provider && canRecord) {
        micRec = await record({ onLevel: (l) => btn.style.setProperty("--lvl", l.toFixed(2)) });
        const { blob, ms } = await micRec.done;
        micRec = null;
        if (ms < 400) return;
        btn.classList.add("busy");
        const text = await transcribe(blob);
        if (text) put(text);
      } else {
        const text = await recognizeOnce({ onInterim: put });
        if (text) put(text);
      }
      input.focus();
    } catch (err) {
      if (!err.locked) toast(err.name === "NotAllowedError" ? "Allow the microphone for this site to talk to yAI." : err.message);
    } finally {
      micRec = null;
      btn.classList.remove("on", "busy");
      btn.title = "Speak your message";
    }
  });

  // ---------- Reading aloud ----------
  let playing = null; // { stop, el }
  const speakable = (t) => String(t || "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/\$\$[\s\S]*?\$\$/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\[\d+\]/g, "").replace(/[*_`#>|~]+/g, "").replace(/\s+/g, " ").trim();
  // Splits long text at sentence ends, so the first part starts playing quickly.
  function parts(text) {
    const out = [];
    let rest = text;
    let size = 280;
    while (rest.length > size) {
      let cut = rest.lastIndexOf(". ", size);
      if (cut < size / 3) cut = rest.lastIndexOf(" ", size);
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1);
      size = 1400;
    }
    if (rest.trim()) out.push(rest.trim());
    return out;
  }
  async function fetchAudio(text) {
    const r = await fetch("/api/hub?op=tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice: voiceId }) });
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || "No voice"), { fallback: true });
    return URL.createObjectURL(await r.blob());
  }
  // The browser's own voice. Chrome has three traps, all handled here: speech queued right after cancel() is
  // dropped (so it starts a moment later), an utterance can be garbage-collected mid-sentence so onend never fires
  // (so they're kept in `held`), and its online voices stop after about 15 s (so text goes a sentence or two at a
  // time, on a voice installed on the device when there is one).
  const held = [];
  function pickVoice() {
    const all = speechSynthesis.getVoices();
    const lang = (navigator.language || "en-US").toLowerCase();
    const same = all.filter((v) => v.lang.toLowerCase() === lang);
    const base = all.filter((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)));
    return same.find((v) => v.localService) || base.find((v) => v.localService) || same[0] || base[0] || null;
  }
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};
  function browserSpeak(text, onEnd) {
    const chunks = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)?.reduce((out, s) => {
      if (out.length && (out[out.length - 1] + s).length < 220) out[out.length - 1] += s;
      else out.push(s);
      return out;
    }, []) || [text];
    let stopped = false, i = 0;
    const voice = pickVoice();
    const next = () => {
      if (stopped) return;
      if (i >= chunks.length) { held.length = 0; return onEnd(); }
      const u = new SpeechSynthesisUtterance(chunks[i++].trim());
      if (voice) u.voice = voice;
      u.lang = voice?.lang || navigator.language || "en-US";
      u.rate = 1.03;
      u.onend = next;
      u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") next(); };
      held.push(u);
      speechSynthesis.speak(u);
      speechSynthesis.resume(); // Chrome sometimes leaves the queue paused
    };
    speechSynthesis.cancel();
    setTimeout(next, 60);
    return () => { stopped = true; speechSynthesis.cancel(); held.length = 0; onEnd(); };
  }
  // Speaks text; resolves when it ends or is stopped.
  function speak(text, { onStart } = {}) {
    stopSpeaking();
    const clean = speakable(text);
    if (!clean) return Promise.resolve();
    return new Promise((resolve) => {
      let stopped = false, audio = null, cancel = null;
      const finish = () => { if (playing?.token === token) playing = null; resolve(); };
      const token = {};
      playing = { token, stop() { stopped = true; audio?.pause(); cancel?.(); finish(); } };
      const useBrowser = () => { if (!("speechSynthesis" in window)) return finish(); onStart?.(); cancel = browserSpeak(clean, finish); };
      if (!cfg.provider) return useBrowser();
      const list = parts(clean);
      let next = fetchAudio(list[0]);
      (async () => {
        try {
          for (let i = 0; i < list.length && !stopped; i++) {
            const url = await next;
            if (i + 1 < list.length) next = fetchAudio(list[i + 1]);
            if (stopped) break;
            audio = new Audio(url);
            if (i === 0) onStart?.();
            await new Promise((res) => { audio.onended = audio.onerror = res; audio.play().catch(res); });
            URL.revokeObjectURL(url);
          }
          if (!stopped) finish();
        } catch (err) {
          if (!stopped) useBrowser(); // past the daily voice allowance, or not set up: the browser reads it
        }
      })();
    });
  }
  function stopSpeaking() { playing?.stop(); speechSynthesis?.cancel?.(); }

  // A Listen button under each finished answer
  window.yaiVoiceAfterFill = (el, visible, done) => {
    const actions = el.querySelector(".actions");
    if (!done || !visible.trim() || !actions || actions.querySelector(".listen")) return;
    actions.querySelector(".copy").insertAdjacentHTML("afterend",
      `<button type="button" class="action listen" title="Read aloud"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Listen</span></button>`);
  };
  messagesEl.addEventListener("click", async (e) => {
    const b = e.target.closest(".listen");
    if (!b) return;
    const label = b.querySelector("span");
    if (b.classList.contains("on")) { stopSpeaking(); return; }
    document.querySelectorAll(".listen.on").forEach((x) => { x.classList.remove("on"); x.querySelector("span").textContent = "Listen"; });
    b.classList.add("on");
    label.textContent = "Loading";
    await speak(b.closest(".msg").dataset.text, { onStart: () => (label.textContent = "Stop") });
    b.classList.remove("on");
    label.textContent = "Listen";
  });

  // ---------- Voice chat ----------
  let vc = null; // { paused, ended, rec }
  const ov = $("voiceOverlay");
  const state = (t) => ($("voiceState").textContent = t);
  const orb = (lvl, mode) => { $("voiceOrb").style.setProperty("--lvl", lvl.toFixed(2)); $("voiceOrb").dataset.mode = mode; };
  async function voiceLoop() {
    while (vc && !vc.ended) {
      if (vc.paused) { state("Paused"); orb(0, "idle"); await new Promise((r) => (vc.resume = r)); continue; }
      state("Listening");
      $("voiceHeard").textContent = "";
      orb(0, "listen");
      let text = "";
      try {
        if (cfg.provider && canRecord) {
          vc.rec = await record({ autoStop: true, maxMs: 45000, onLevel: (l) => orb(l, "listen") });
          const { blob, spoke } = await vc.rec.done;
          vc.rec = null;
          if (!vc || vc.ended || vc.paused) continue;
          if (!spoke) continue;
          state("Thinking");
          orb(0.2, "think");
          text = await transcribe(blob);
        } else {
          text = await recognizeOnce({ onInterim: (t) => ($("voiceHeard").textContent = t) });
        }
      } catch (err) {
        if (err.locked) return endVoice();
        state(err.name === "NotAllowedError" ? "Allow the microphone to use voice chat" : err.message);
        await new Promise((r) => setTimeout(r, 2500));
        if (err.name === "NotAllowedError") return endVoice();
        continue;
      }
      if (!vc || vc.ended) return;
      if (!text.trim()) continue;
      $("voiceHeard").textContent = `“${text}”`;
      state("Thinking");
      orb(0.2, "think");
      const before = chat.history.length;
      await send(text, []);
      if (!vc || vc.ended) return;
      const last = chat.history[chat.history.length - 1];
      if (chat.history.length > before && last?.role === "assistant") {
        state("Speaking");
        orb(0.5, "speak");
        await speak(last.content);
      }
    }
  }
  function startVoice() {
    if (controller) return;
    if (mode !== "chat") setMode("chat");
    vc = { paused: false, ended: false };
    ov.hidden = false;
    $("voiceMute").textContent = "Pause";
    voiceLoop();
  }
  function endVoice() {
    if (!vc) return;
    vc.ended = true;
    vc.rec?.stop();
    vc.resume?.();
    recognizeOnce.current?.abort?.();
    stopSpeaking();
    vc = null;
    ov.hidden = true;
  }
  $("voiceBtn").addEventListener("click", startVoice);
  $("voiceEnd").addEventListener("click", endVoice);
  $("voiceMute").addEventListener("click", () => {
    if (!vc) return;
    vc.paused = !vc.paused;
    $("voiceMute").textContent = vc.paused ? "Resume" : "Pause";
    if (vc.paused) { vc.rec?.stop(); stopSpeaking(); recognizeOnce.current?.abort?.(); }
    else vc.resume?.();
  });
  // Tapping the orb while yAI speaks: interrupt and listen.
  $("voiceOrb").addEventListener("click", () => { if (playing) stopSpeaking(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && vc) endVoice(); });

  window.yaiVoice = {
    config: () => cfg,
    voiceId: () => voiceId,
    setVoice(id) { voiceId = id; store.set("voiceId", id); },
    preview(id) { const old = voiceId; voiceId = id; speak("Hi, I'm yAI. This is how I sound.").finally(() => (voiceId = old)); },
    load: loadConfig,
  };
  loadConfig();
})();
