// What a tool call is doing, in plain words, for the live steps on the website and yAI Code's spinner (2026-10-21):
// "Checking the weather in Waterloo, ON", "Searching arXiv for mixture of experts".

const LABELS = {
  weather: "Weather", maps: "Maps", wolfram: "Wolfram Alpha", arxiv: "arXiv", scholar: "Semantic Scholar",
  youtube: "YouTube", github: "GitHub", learn: "UWaterloo LEARN", uw: "UWaterloo courses", webhook: "Webhooks", web: "Web search",
};
const short = (s, n = 60) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function describe(name, a = {}) {
  const q = short(a.query || a.input || a.place || "");
  switch (name) {
    case "web.search": return `Searching the web for “${q}”`;
    case "weather.forecast": return `Checking the weather in ${q || "that place"}`;
    case "maps.find": return `Looking up ${q || "the place"} on the map`;
    case "maps.route": return `Getting ${/walk/i.test(a.mode) ? "walking" : /bike|cycl/i.test(a.mode) ? "cycling" : /transit/i.test(a.mode) ? "transit" : "driving"} directions to ${short(a.to, 40) || "there"}`;
    case "wolfram.ask": return `Asking Wolfram Alpha: ${q}`;
    case "arxiv.search": return `Searching arXiv for “${q}”`;
    case "scholar.search": return `Searching Semantic Scholar for “${q}”`;
    case "scholar.paper": return "Reading the paper on Semantic Scholar";
    case "youtube.transcript": return "Reading the YouTube video's transcript";
    case "youtube.search": return `Searching YouTube for “${q}”`;
    case "github.repos": return "Listing your GitHub repositories";
    case "github.activity": return `Reading recent activity in ${short(a.repo, 40) || "your repo"}`;
    case "github.pr": return `Reading pull request #${a.number} in ${short(a.repo, 40)}`;
    case "github.issues": return `Reading the issues in ${short(a.repo, 40)}`;
    case "github.file": return `Reading ${short(a.path, 40)} on GitHub`;
    case "github.create_issue": return `Opening an issue in ${short(a.repo, 40)}`;
    case "github.comment": return `Commenting on #${a.number} in ${short(a.repo, 40)}`;
    case "github.create_pr": return `Opening a pull request in ${short(a.repo, 40)}`;
    case "learn.deadlines": return `Reading your LEARN calendar${a.course ? ` for ${short(a.course, 20)}` : ""}`;
    case "uw.course": return `Looking up ${short(a.code, 20)}`;
    case "webhook.send": return `Sending to ${short(a.name, 30) || "your webhook"}`;
    default: return `Using ${name}`;
  }
}
const labelOf = (name) => LABELS[String(name).split(".")[0]] || name;

module.exports = { describe, labelOf };
