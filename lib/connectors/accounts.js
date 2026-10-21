// The connections tied to a person's own accounts: GitHub and Spotify (signed in with OAuth), Google Drive and Docs
// (through the Google connection), YouTube, UWaterloo LEARN (its calendar feed), and webhooks.
// Tools marked write: true change something, so they only run after the person says yes (a button on the website,
// an approval card in yAI Code).

const { fetchJson, fetchText, ToolError, clip, stripHtml, publicUrl } = require("./util");

// ---------- GitHub ----------
const GH = "https://api.github.com";
const gh = async (ctx, path, opts = {}) => fetchJson(`${GH}${path}`, { ...opts, headers: { Authorization: `Bearer ${await ctx.token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.body && { "Content-Type": "application/json" }), ...opts.headers } });
// "yai" -> "<login>/yai"; "owner/name" as is; a github.com URL -> owner/name
async function repoOf(ctx, r) {
  let s = String(r || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").split("/").slice(0, 2).join("/");
  if (!s) throw new ToolError("Which repository? (owner/name)");
  if (!s.includes("/")) s = `${(await gh(ctx, "/user")).login}/${s}`;
  return s;
}
const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
const github = {
  id: "github", label: "GitHub", desc: "Your repositories, pull requests and issues", kind: "oauth",
  oauth: {
    id: "github", label: "GitHub", authUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:user"], idEnv: "GITHUB_CLIENT_ID", secretEnv: "GITHUB_CLIENT_SECRET",
    profile: async (t) => (await fetchJson(`${GH}/user`, { headers: { Authorization: `Bearer ${t}` } })).login,
  },
  tools: [
    {
      name: "github.repos", params: {}, desc: "the user's repositories, most recently pushed first",
      async run(a, ctx) {
        const list = await gh(ctx, "/user/repos?sort=pushed&per_page=25");
        return { text: list.map((r) => `- ${r.full_name}${r.private ? " (private)" : ""}: ${r.description || ""} · ${r.language || ""} · pushed ${r.pushed_at.slice(0, 10)} · ${r.open_issues_count} open issues`).join("\n") };
      },
    },
    {
      name: "github.activity", params: { repo: "owner/name", days: "default 7" }, desc: "what changed in a repository lately: commits, pull requests and issues",
      async run(a, ctx) {
        const repo = await repoOf(ctx, a.repo);
        const since = ago(Math.min(90, parseInt(a.days, 10) || 7));
        const [commits, pulls, issues] = await Promise.all([
          gh(ctx, `/repos/${repo}/commits?since=${since}&per_page=40`).catch(() => []),
          gh(ctx, `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=15`).catch(() => []),
          gh(ctx, `/repos/${repo}/issues?state=all&since=${since}&per_page=20`).catch(() => []),
        ]);
        return {
          text: [`${repo} since ${since.slice(0, 10)}:`, `Commits (${commits.length}):`, ...commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.commit.author?.date?.slice(0, 10)} ${c.commit.author?.name}: ${clip(c.commit.message.split("\n")[0], 120)}`),
            "Pull requests:", ...pulls.filter((p) => p.updated_at >= since).map((p) => `- #${p.number} [${p.merged_at ? "merged" : p.state}] ${p.title} by ${p.user.login}`),
            "Issues:", ...issues.filter((i) => !i.pull_request).map((i) => `- #${i.number} [${i.state}] ${i.title}`)].join("\n"),
          sources: [{ title: repo, url: `https://github.com/${repo}`, site: "github.com" }],
        };
      },
    },
    {
      name: "github.pr", params: { repo: "owner/name", number: "the pull request number" }, desc: "a pull request: description, files changed and the diff",
      async run(a, ctx) {
        const repo = await repoOf(ctx, a.repo);
        const n = parseInt(a.number, 10);
        const [pr, files] = await Promise.all([gh(ctx, `/repos/${repo}/pulls/${n}`), gh(ctx, `/repos/${repo}/pulls/${n}/files?per_page=60`)]);
        const diff = files.map((f) => `--- ${f.filename} (+${f.additions} −${f.deletions})\n${f.patch || "(binary or too large)"}`).join("\n");
        return {
          text: `#${pr.number} ${pr.title} by ${pr.user.login} [${pr.merged_at ? "merged" : pr.state}] ${pr.head.ref} -> ${pr.base.ref}\n${clip(pr.body || "(no description)", 3000)}\nFiles (${files.length}):\n${clip(diff, 14000)}`,
          sources: [{ title: `#${pr.number} ${pr.title}`, url: pr.html_url, site: "github.com" }],
        };
      },
    },
    {
      name: "github.issues", params: { repo: "owner/name", state: "open (default), closed or all" }, desc: "a repository's issues",
      async run(a, ctx) {
        const repo = await repoOf(ctx, a.repo);
        const list = (await gh(ctx, `/repos/${repo}/issues?state=${/closed|all/.test(a.state) ? a.state : "open"}&per_page=30`)).filter((i) => !i.pull_request);
        return { text: list.map((i) => `- #${i.number} [${i.state}] ${i.title} (${i.labels.map((l) => l.name).join(", ")}) ${i.html_url}\n  ${clip((i.body || "").replace(/\s+/g, " "), 240)}`).join("\n") || "No issues." };
      },
    },
    {
      name: "github.file", params: { repo: "owner/name", path: "file path", ref: "optional branch or commit" }, desc: "read one file from a repository",
      async run(a, ctx) {
        const repo = await repoOf(ctx, a.repo);
        const f = await gh(ctx, `/repos/${repo}/contents/${String(a.path || "").replace(/^\/+/, "")}${a.ref ? `?ref=${encodeURIComponent(a.ref)}` : ""}`);
        if (Array.isArray(f)) return { text: f.map((x) => `${x.type === "dir" ? "📁" : "-"} ${x.path}`).join("\n") };
        return { text: clip(Buffer.from(f.content || "", "base64").toString("utf8"), 20000), sources: [{ title: f.path, url: f.html_url, site: "github.com" }] };
      },
    },
    {
      name: "github.create_issue", write: true, params: { repo: "owner/name", title: "issue title", body: "issue text (markdown)" }, desc: "open an issue",
      async run(a, ctx) {
        const repo = await repoOf(ctx, a.repo);
        const i = await gh(ctx, `/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title: clip(a.title, 250), body: clip(a.body || "", 60000) }) });
        return { text: `Opened issue #${i.number}: ${i.html_url}`, link: i.html_url };
      },
    },
    {
      name: "github.comment", write: true, params: { repo: "owner/name", number: "issue or PR number", body: "the comment" }, desc: "comment on an issue or pull request",
      async run(a, ctx) {
        const repo = await repoOf(ctx, a.repo);
        const c = await gh(ctx, `/repos/${repo}/issues/${parseInt(a.number, 10)}/comments`, { method: "POST", body: JSON.stringify({ body: clip(a.body, 60000) }) });
        return { text: `Commented: ${c.html_url}`, link: c.html_url };
      },
    },
    {
      name: "github.create_pr", write: true, params: { repo: "owner/name", head: "the branch with the changes", base: "the branch to merge into (default: the repo's default)", title: "PR title", body: "PR description", draft: "true or false" }, desc: "open a pull request from a pushed branch",
      async run(a, ctx) {
        const repo = await repoOf(ctx, a.repo);
        const base = a.base || (await gh(ctx, `/repos/${repo}`)).default_branch;
        const p = await gh(ctx, `/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: clip(a.title, 250), body: clip(a.body || "", 60000), head: String(a.head), base, draft: String(a.draft) === "true" }) });
        return { text: `Opened pull request #${p.number}: ${p.html_url}`, link: p.html_url };
      },
    },
  ],
};

// ---------- Spotify ----------
const SP = "https://api.spotify.com/v1";
const sp = async (ctx, path, opts = {}) => {
  const r = await fetch(`${SP}${path}`, { ...opts, headers: { Authorization: `Bearer ${await ctx.token()}`, ...(opts.body && { "Content-Type": "application/json" }) }, signal: AbortSignal.timeout(12000) });
  if (r.status === 204) return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ToolError(`Spotify: ${d.error?.message || r.status}${r.status === 403 ? " (the app may still be in development mode; the site owner has to add your Spotify email in the Spotify dashboard)" : ""}`);
  return d;
};
const track = (t) => `${t.name} by ${t.artists.map((x) => x.name).join(", ")} (${t.album?.name || ""}) ${t.external_urls?.spotify || ""}`;
const spotify = {
  id: "spotify", label: "Spotify", desc: "What you listen to, search, and making playlists", kind: "oauth",
  oauth: {
    id: "spotify", label: "Spotify", authUrl: "https://accounts.spotify.com/authorize", tokenUrl: "https://accounts.spotify.com/api/token", basicAuth: true,
    scopes: ["user-read-currently-playing", "user-read-recently-played", "user-top-read", "playlist-read-private", "playlist-modify-private", "playlist-modify-public"],
    idEnv: "SPOTIFY_CLIENT_ID", secretEnv: "SPOTIFY_CLIENT_SECRET",
    profile: async (t) => (await fetchJson(`${SP}/me`, { headers: { Authorization: `Bearer ${t}` } })).display_name || "",
  },
  tools: [
    {
      name: "spotify.search", params: { query: "song, artist or album", type: "track (default), artist, album or playlist" }, desc: "search Spotify",
      async run(a, ctx) {
        const type = /artist|album|playlist/.test(a.type) ? a.type.match(/artist|album|playlist/)[0] : "track";
        const d = await sp(ctx, `/search?${new URLSearchParams({ q: String(a.query || ""), type, limit: "8" })}`);
        const items = d[`${type}s`]?.items?.filter(Boolean) || [];
        return { text: items.map((x) => `- ${type === "track" ? track(x) : `${x.name} ${x.external_urls?.spotify || ""}${x.genres?.length ? ` (${x.genres.slice(0, 3).join(", ")})` : ""}`}`).join("\n") || "Nothing found." };
      },
    },
    {
      name: "spotify.now", params: {}, desc: "what the user is playing now and played recently",
      async run(a, ctx) {
        const [now, recent] = await Promise.all([sp(ctx, "/me/player/currently-playing").catch(() => null), sp(ctx, "/me/player/recently-played?limit=15").catch(() => null)]);
        return { text: `Now playing: ${now?.item ? track(now.item) : "nothing"}\nRecently played:\n${(recent?.items || []).map((x) => `- ${track(x.track)}`).join("\n")}` };
      },
    },
    {
      name: "spotify.top", params: { kind: "tracks or artists", range: "short (4 weeks), medium (6 months) or long (years)" }, desc: "the user's top tracks or artists",
      async run(a, ctx) {
        const kind = /artist/.test(a.kind) ? "artists" : "tracks";
        const range = /short/.test(a.range) ? "short_term" : /long/.test(a.range) ? "long_term" : "medium_term";
        const d = await sp(ctx, `/me/top/${kind}?limit=20&time_range=${range}`);
        return { text: (d.items || []).map((x, i) => `${i + 1}. ${kind === "tracks" ? track(x) : `${x.name} (${(x.genres || []).slice(0, 3).join(", ")})`}`).join("\n") };
      },
    },
    {
      name: "spotify.create_playlist", write: true, params: { name: "playlist name", description: "short description", tracks: 'JSON list like ["Song - Artist", …], up to 50', public: "true or false (default false)" }, desc: "make a playlist in the user's Spotify from a list of songs",
      async run(a, ctx) {
        let list = a.tracks;
        if (typeof list === "string") { try { list = JSON.parse(list); } catch { list = list.split(/\n|;/); } }
        list = (Array.isArray(list) ? list : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
        if (!list.length) throw new ToolError("The playlist needs some songs.");
        const uris = [], missing = [];
        for (const q of list) {
          const d = await sp(ctx, `/search?${new URLSearchParams({ q: q.replace(/\s+-\s+/, " "), type: "track", limit: "1" })}`).catch(() => null);
          const t = d?.tracks?.items?.[0];
          t ? uris.push(t.uri) : missing.push(q);
        }
        const pl = await sp(ctx, "/me/playlists", { method: "POST", body: JSON.stringify({ name: clip(a.name || "yAI playlist", 100), description: clip(a.description || "Made with yAI", 300), public: String(a.public) === "true" }) });
        if (uris.length) await sp(ctx, `/playlists/${pl.id}/tracks`, { method: "POST", body: JSON.stringify({ uris }) });
        return { text: `Made "${pl.name}" with ${uris.length} songs: ${pl.external_urls.spotify}${missing.length ? `\nNot found: ${missing.join("; ")}` : ""}`, link: pl.external_urls.spotify };
      },
    },
  ],
};

// ---------- YouTube ----------
const videoId = (s) => (/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/.exec(String(s)) || /^([\w-]{11})$/.exec(String(s).trim()) || [])[1];
// The captions, through YouTube's player API as its Android app asks for them (the web page's caption links now need
// a token a server can't get).
async function transcript(id) {
  const p = await fetchJson("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST", timeout: 15000,
    headers: { "Content-Type": "application/json", "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)" },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en" } }, videoId: id }),
  });
  const title = p.videoDetails?.title || "", author = p.videoDetails?.author || "";
  const tracks = p.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const t = tracks.find((x) => /^en/.test(x.languageCode) && x.kind !== "asr") || tracks.find((x) => /^en/.test(x.languageCode)) || tracks[0];
  if (!t) return { title, author, text: "" };
  const xml = await fetchText(t.baseUrl, { timeout: 15000 }).catch(() => "");
  const text = [...xml.matchAll(/<p t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)].map(([, ms, w]) => {
    const sec = Math.floor(+ms / 1000);
    return `[${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}] ${stripHtml(w.replace(/&#39;/g, "'"))}`;
  }).filter((l) => !/\]\s*$/.test(l)).join("\n");
  return { title, author, text, lang: t.languageCode };
}
const youtube = {
  id: "youtube", label: "YouTube", desc: "Search videos and read a video's transcript to summarise it", kind: "open",
  tools: [
    {
      name: "youtube.transcript", params: { url: "the video link or id" }, desc: "a YouTube video's title and transcript, to summarise it or answer questions about it",
      async run(a) {
        const id = videoId(a.url);
        if (!id) throw new ToolError("That isn't a YouTube link.");
        const t = await transcript(id);
        const url = `https://www.youtube.com/watch?v=${id}`;
        if (!t.text) return { text: `"${t.title || id}"${t.author ? ` by ${t.author}` : ""} has no transcript that can be read (captions off, or YouTube blocked the request). Say so.`, sources: [{ title: t.title || "YouTube video", url, site: "youtube.com" }] };
        return { text: `"${t.title}" by ${t.author} (transcript, ${t.lang}):\n${clip(t.text, 30000)}`, sources: [{ title: t.title, url, site: "youtube.com" }] };
      },
    },
    {
      name: "youtube.search", params: { query: "what to look for" }, desc: "search YouTube videos",
      async run(a) {
        if (!process.env.YOUTUBE_API_KEY) {
          return { text: `YouTube search needs a YouTube API key on this site. Search link: https://www.youtube.com/results?search_query=${encodeURIComponent(a.query || "")}` };
        }
        const d = await fetchJson(`https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({ part: "snippet", type: "video", maxResults: "8", q: String(a.query || ""), key: process.env.YOUTUBE_API_KEY })}`);
        const items = d.items || [];
        return {
          text: items.map((v) => `- "${stripHtml(v.snippet.title)}" by ${v.snippet.channelTitle} (${v.snippet.publishedAt.slice(0, 10)}) https://www.youtube.com/watch?v=${v.id.videoId}`).join("\n") || "Nothing found.",
          sources: items.slice(0, 4).map((v) => ({ title: stripHtml(v.snippet.title), url: `https://www.youtube.com/watch?v=${v.id.videoId}`, site: "youtube.com" })),
        };
      },
    },
  ],
};

// ---------- Google Drive and Docs (through the Google connection) ----------
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const gd = async (ctx, url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${await ctx.googleToken()}`, ...opts.headers }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new ToolError(`Google Drive: ${d.error?.message || r.status}${r.status === 403 ? " (reconnect Google under Connections to allow Drive)" : ""}`);
  }
  return opts.raw ? r.text() : r.json();
};
const fileId = (s) => (/\/d\/([\w-]{20,})/.exec(String(s)) || /[?&]id=([\w-]{20,})/.exec(String(s)) || /^([\w-]{20,})$/.exec(String(s).trim()) || [])[1];
// A small markdown -> HTML, enough for Google Docs to keep headings, lists, bold, italics, code and links.
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>").replace(/`(.+?)`/g, "<code>$1</code>").replace(/\[(.+?)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = null, code = null;
  for (const line of String(md).split(/\r?\n/)) {
    if (/^```/.test(line)) { if (code) { out.push(`<pre>${esc(code.join("\n"))}</pre>`); code = null; } else code = []; continue; }
    if (code) { code.push(line); continue; }
    const li = /^\s*([-*]|\d+\.)\s+(.*)/.exec(line);
    if (li) { const t = /\d/.test(li[1]) ? "ol" : "ul"; if (list !== t) { if (list) out.push(`</${list}>`); out.push(`<${t}>`); list = t; } out.push(`<li>${inline(li[2])}</li>`); continue; }
    if (list) { out.push(`</${list}>`); list = null; }
    const h = /^(#{1,6})\s+(.*)/.exec(line);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  if (code) out.push(`<pre>${esc(code.join("\n"))}</pre>`);
  return `<html><body>${out.join("\n")}</body></html>`;
}
const drive = {
  id: "drive", label: "Google Drive and Docs", desc: "Find and read your Drive files; save answers as Google Docs", kind: "google",
  tools: [
    {
      name: "drive.search", params: { query: "words in the file's name or text" }, desc: "find files in the user's Google Drive",
      async run(a, ctx) {
        const q = String(a.query || "").replace(/['\\]/g, " ").trim();
        const d = await gd(ctx, `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q: `(name contains '${q}' or fullText contains '${q}') and trashed = false`, pageSize: "12", fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))" })}`);
        return { text: (d.files || []).map((f) => `- ${f.name} [${f.mimeType.replace("application/vnd.google-apps.", "google ")}] modified ${f.modifiedTime.slice(0, 10)} id ${f.id} ${f.webViewLink}`).join("\n") || "No files found." };
      },
    },
    {
      name: "drive.read", params: { id: "the file id or its link" }, desc: "read a Google Doc, Sheet, Slides deck or text file from Drive",
      async run(a, ctx) {
        const id = fileId(a.id);
        if (!id) throw new ToolError("Which file? Give its link or id.");
        const meta = await gd(ctx, `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,webViewLink`);
        const EXPORT = { "application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv", "application/vnd.google-apps.presentation": "text/plain" };
        let text;
        if (EXPORT[meta.mimeType]) text = await gd(ctx, `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(EXPORT[meta.mimeType])}`, { raw: true });
        else if (/^text\/|json|csv|xml|markdown/.test(meta.mimeType)) text = await gd(ctx, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { raw: true });
        else return { text: `${meta.name} is a ${meta.mimeType} file, which can't be read as text here. Link: ${meta.webViewLink}` };
        return { text: `${meta.name}:\n${clip(text, 30000)}`, sources: [{ title: meta.name, url: meta.webViewLink, site: "docs.google.com" }] };
      },
    },
    {
      name: "drive.create_doc", write: true, params: { title: "document title", content: "the document, in markdown" }, desc: "save text as a new Google Doc in the user's Drive",
      async run(a, ctx) {
        const boundary = "yai" + Date.now();
        const body = [`--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify({ name: clip(a.title || "From yAI", 200), mimeType: "application/vnd.google-apps.document" }),
          `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "", mdToHtml(a.content || ""), `--${boundary}--`].join("\r\n");
        const f = await gd(ctx, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
        return { text: `Saved "${f.name}" to Google Docs: ${f.webViewLink}`, link: f.webViewLink };
      },
    },
  ],
};

// ---------- UWaterloo: LEARN (the calendar feed) and the Open Data API ----------
// LEARN's calendar can be subscribed to: Calendar > Subscribe gives an .ics link with the person's due dates.
function parseIcs(ics) {
  const lines = String(ics).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let ev = null;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") ev = {};
    else if (l === "END:VEVENT") { if (ev) events.push(ev); ev = null; }
    else if (ev) {
      const i = l.indexOf(":");
      if (i < 0) continue;
      const [name, ...params] = l.slice(0, i).split(";");
      const val = l.slice(i + 1).replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";");
      ev[name] = val;
      if (params.length) ev[name + "_params"] = params.join(";");
    }
  }
  return events;
}
// DTSTART as a Date: UTC (…Z), a floating or TZID time (taken as Toronto time), or a whole day.
function icsDate(v, params = "") {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(v || ""));
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", z] = m;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  // Toronto: UTC-4 in summer time, UTC-5 otherwise (good enough for due dates)
  const guess = new Date(Date.UTC(+y, +mo - 1, +d, +h + 5, +mi, +s));
  const summer = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", timeZoneName: "short" }).format(guess).includes("EDT");
  return new Date(guess.getTime() - (summer ? 3600000 : 0) + (/VALUE=DATE/.test(params) ? 0 : 0));
}
const learn = {
  id: "learn", label: "UWaterloo LEARN", desc: "Your LEARN due dates and course events (from its calendar feed)", kind: "setting", setting: "learnIcs",
  tools: [{
    name: "learn.deadlines", params: { days: "how far ahead, default 14", course: "optional course code to filter, e.g. CS 241" }, desc: "the user's upcoming LEARN due dates, quizzes and course events",
    async run(a, ctx) {
      const url = ctx.settings.learnIcs;
      if (!url) throw new ToolError("LEARN isn't connected: paste the calendar feed link under Connections.");
      const ics = await fetchText(await publicUrl(url, { hosts: ["uwaterloo.ca"] }), { timeout: 15000 });
      const days = Math.min(120, Math.max(1, parseInt(a.days, 10) || 14));
      const now = Date.now(), until = now + days * 864e5;
      const course = String(a.course || "").replace(/\s+/g, "").toLowerCase();
      const list = parseIcs(ics).map((e) => ({ ...e, at: icsDate(e.DTSTART || e.DTEND, e.DTSTART_params || "") }))
        .filter((e) => e.at && e.at >= now - 864e5 && e.at <= until && (!course || `${e.SUMMARY} ${e.LOCATION || ""} ${e.DESCRIPTION || ""}`.replace(/\s+/g, "").toLowerCase().includes(course)))
        .sort((x, y) => x.at - y.at);
      const fmt = (d) => d.toLocaleString("en-CA", { timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      return { text: list.length ? `LEARN events in the next ${days} days (Toronto time):\n${list.map((e) => `- ${fmt(e.at)}: ${e.SUMMARY}${e.LOCATION ? ` (${e.LOCATION})` : ""}${e.DESCRIPTION ? ` · ${clip(e.DESCRIPTION.replace(/\s+/g, " "), 160)}` : ""}`).join("\n")}` : `Nothing on LEARN in the next ${days} days.` };
    },
  }],
};
const UW = "https://openapi.data.uwaterloo.ca/v3";
const uwApi = (path) => fetchJson(`${UW}${path}`, { headers: { "x-api-key": process.env.UW_API_KEY } });
const uw = {
  id: "uw", label: "UWaterloo courses", desc: "Course descriptions and prerequisites (UW Open Data)", kind: "key", env: ["UW_API_KEY"],
  tools: [{
    name: "uw.course", params: { code: "course code, e.g. CS 241" }, desc: "a UWaterloo course: title, description and requirements",
    async run(a) {
      const m = /^([A-Za-z]+)\s*(\d{2,3}[A-Za-z]?)$/.exec(String(a.code || "").trim());
      if (!m) throw new ToolError("Give a course code like CS 241.");
      const term = (await uwApi("/Terms/current")).termCode;
      const list = await uwApi(`/Courses/${term}/${m[1].toUpperCase()}/${m[2].toUpperCase()}`).catch(() => []);
      const c = list[0];
      if (!c) return { text: `No ${m[1].toUpperCase()} ${m[2]} found this term.` };
      return {
        text: `${c.subjectCode} ${c.catalogNumber}: ${c.title}\n${c.description || ""}\nRequirements: ${c.requirementsDescription || "none listed"}`,
        sources: [{ title: `${c.subjectCode} ${c.catalogNumber}`, url: `https://uwflow.com/course/${(c.subjectCode + c.catalogNumber).toLowerCase()}`, site: "uwflow.com" }],
      };
    },
  }],
};

// ---------- webhooks ----------
const webhooks = {
  id: "webhooks", label: "Webhooks", desc: "Send messages to Discord, Slack, Zapier, n8n or any URL", kind: "setting", setting: "webhooks",
  tools: [{
    name: "webhook.send", write: true, params: { name: "which saved webhook", message: "what to send" }, desc: "send a message to one of the user's saved webhooks",
    async run(a, ctx) {
      const hooks = ctx.settings.webhooks || [];
      const h = hooks.find((x) => x.name.toLowerCase() === String(a.name || "").toLowerCase()) || (hooks.length === 1 ? hooks[0] : null);
      if (!h) throw new ToolError(`Which webhook? Saved: ${hooks.map((x) => x.name).join(", ") || "none"}.`);
      await sendWebhook(h, String(a.message || ""), ctx.user);
      return { text: `Sent to ${h.name}.` };
    },
  }],
};
// The body works as is for Discord (content), Slack (text) and anything that reads JSON.
async function sendWebhook(h, message, user, extra = {}) {
  const url = await publicUrl(h.url);
  const text = clip(message, 1900);
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "yAI-webhook/1.0" }, body: JSON.stringify({ content: text, text, source: "yAI", user, sentAt: new Date().toISOString(), ...extra }), redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new ToolError(`${h.name} answered ${r.status}`);
}

module.exports = { github, spotify, youtube, drive, learn, uw, webhooks, sendWebhook, DRIVE_SCOPE, mdToHtml, parseIcs, icsDate };
