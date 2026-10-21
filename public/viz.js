// Diagrams and charts in answers (2026-10-21). md.js turns ```mermaid and ```chart blocks into placeholders; this draws
// them once the block is complete: Mermaid for diagrams, Chart.js for charts (both loaded the first time they're needed).
// Charts follow the dataviz method: a validated categorical palette in fixed order (light and dark steps), thin marks,
// rounded bar ends, a legend only for two or more series, hover tooltips, and a table view for every chart.
//
// A chart block is JSON: { "type": "bar" | "line" | "area" | "pie" | "scatter", "title": "…", "labels": [...],
//   "series": [{ "name": "…", "data": [...] }], "unit": "%", "stacked": false, "horizontal": false }
// (Chart.js-style { data: { labels, datasets: [{ label, data }] } } is accepted too.)
(function () {
  const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js";
  const CHARTJS = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
  // The reference categorical palette (dataviz skill): eight hues, light and dark steps, used in this order.
  const PALETTE = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
    dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  };
  const loads = {};
  const load = (src) => (loads[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { loads[src] = null; reject(new Error("Couldn't load the drawing library")); };
    document.head.appendChild(s);
  }));
  const isDark = () => {
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255];
    return (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.5;
  };
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let seq = 0;

  // ---------- Mermaid ----------
  let mermaidTheme = null;
  async function drawMermaid(box, src) {
    await load(MERMAID);
    const dark = isDark();
    if (mermaidTheme !== dark) {
      mermaidTheme = dark;
      window.mermaid.initialize({
        startOnLoad: false, securityLevel: "strict", theme: "base", fontFamily: "Geist, system-ui, sans-serif",
        themeVariables: {
          darkMode: dark, background: "transparent", fontSize: "14px",
          primaryColor: dark ? "#2a2a28" : "#f4f3ef", primaryBorderColor: dark ? "#55544f" : "#c9c8c2", primaryTextColor: token("--text") || (dark ? "#ecebe7" : "#1c1c1a"),
          secondaryColor: dark ? "#31254d" : "#efe9fb", tertiaryColor: dark ? "#1f1f1d" : "#fbfaf8",
          lineColor: dark ? "#8f8e88" : "#86857f", textColor: token("--text") || (dark ? "#ecebe7" : "#1c1c1a"),
          edgeLabelBackground: token("--surface") || (dark ? "#1b1b1a" : "#ffffff"), clusterBkg: dark ? "#1f1f1d" : "#fbfaf8",
          noteBkgColor: dark ? "#31254d" : "#f1ebff", noteBorderColor: dark ? "#6a55a8" : "#b9a6ee",
        },
      });
    }
    const { svg } = await window.mermaid.render(`yai-mm-${++seq}`, src);
    box.querySelector(".viz-out").innerHTML = svg;
    box.dataset.svg = svg;
  }

  // ---------- charts ----------
  function normalize(spec) {
    if (spec.data && Array.isArray(spec.data.datasets)) {
      spec = { type: spec.type, title: spec.options?.plugins?.title?.text || spec.title, labels: spec.data.labels, series: spec.data.datasets.map((d) => ({ name: d.label, data: d.data })) };
    }
    const type = String(spec.type || "bar").toLowerCase().replace("doughnut", "pie");
    const series = (Array.isArray(spec.series) ? spec.series : spec.data ? [{ name: spec.title || "", data: spec.data }] : []).slice(0, 8)
      .map((s, i) => ({ name: String(s.name ?? s.label ?? `Series ${i + 1}`), data: (s.data || []).map((v) => (v && typeof v === "object" ? v : Number(v))) }));
    if (!series.length) throw new Error("The chart has no data");
    return { type: ["bar", "line", "area", "pie", "scatter"].includes(type) ? type : "bar", title: spec.title ? String(spec.title) : "", labels: (spec.labels || []).map(String), series, unit: spec.unit ? String(spec.unit) : "", stacked: !!spec.stacked, horizontal: !!spec.horizontal };
  }
  // Currency goes in front ($12, $3M); other units after (12%, 40 km).
const fmt = (v, unit) => {
    const n = typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v);
    const cur = /^[$€£¥₹]/.exec(unit || "");
    if (cur) return (v < 0 ? "-" : "") + cur[0] + n.replace(/^-/, "") + unit.slice(1);
    return n + (unit === "%" ? "%" : unit ? ` ${unit}` : "");
  };
  async function drawChart(box, src) {
    const spec = normalize(JSON.parse(src));
    box._spec = spec;
    await load(CHARTJS);
    const dark = isDark();
    const colors = PALETTE[dark ? "dark" : "light"];
    const text = token("--text-2") || (dark ? "#a4a39d" : "#5c5c57"), grid = token("--border") || (dark ? "#2a2a27" : "#e6e5e1");
    const out = box.querySelector(".viz-out");
    out.innerHTML = `${spec.title ? `<div class="viz-title">${esc(spec.title)}</div>` : ""}<div class="viz-canvas"><canvas role="img" aria-label="${esc(spec.title || "Chart")}"></canvas></div>`;
    const pie = spec.type === "pie";
    const many = spec.series.length >= 2;
    const datasets = pie
      ? [{ label: spec.series[0].name, data: spec.series[0].data, backgroundColor: spec.labels.map((_, i) => colors[i % 8]), borderColor: token("--surface") || (dark ? "#1b1b1a" : "#fff"), borderWidth: 2, hoverOffset: 4 }]
      : spec.series.map((s, i) => {
        const c = colors[i % 8];
        const line = spec.type === "line" || spec.type === "area";
        return {
          label: s.name, data: s.data, borderColor: c, backgroundColor: spec.type === "area" ? c + "33" : c,
          fill: spec.type === "area" ? (spec.stacked ? (i ? "-1" : "origin") : "origin") : false,
          borderWidth: line ? 2 : 0, pointRadius: spec.type === "scatter" ? 4 : 0, pointHoverRadius: 5, pointBackgroundColor: c, tension: 0.25,
          borderRadius: line ? 0 : { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 }, borderSkipped: "start",
          maxBarThickness: 40, categoryPercentage: 0.8, barPercentage: 0.9,
        };
      });
    const Chart = window.Chart;
    Chart.defaults.font.family = "Geist, system-ui, sans-serif";
    Chart.defaults.color = text;
    box._chart?.destroy();
    box._chart = new Chart(out.querySelector("canvas"), {
      type: pie ? "doughnut" : spec.type === "area" ? "line" : spec.type,
      data: { labels: spec.labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, indexAxis: spec.horizontal && spec.type === "bar" ? "y" : "x",
        interaction: { mode: pie || spec.type === "scatter" ? "nearest" : "index", intersect: pie || spec.type === "scatter" },
        cutout: pie ? "58%" : undefined,
        plugins: {
          legend: { display: pie || many, position: "bottom", labels: { usePointStyle: true, pointStyle: "rectRounded", boxWidth: 10, boxHeight: 10, padding: 14, color: text } },
          tooltip: {
            backgroundColor: token("--ink") || "#1c1c1a", titleColor: token("--on-ink") || "#fff", bodyColor: token("--on-ink") || "#fff",
            padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
            callbacks: { label: (ctx) => `${pie ? ctx.label : ctx.dataset.label}: ${fmt(ctx.parsed?.y ?? ctx.parsed?.x ?? ctx.parsed ?? ctx.raw, spec.unit)}`.replace(/^:\s/, "") },
          },
        },
        scales: pie ? {} : {
          x: { stacked: spec.stacked, grid: { display: spec.horizontal, color: grid, drawTicks: false }, border: { color: grid }, ticks: { color: text, maxRotation: 0, autoSkipPadding: 12, padding: 6 } },
          y: { stacked: spec.stacked, beginAtZero: spec.type !== "line" && spec.type !== "scatter", grid: { display: !spec.horizontal, color: grid, drawTicks: false }, border: { display: false }, ticks: { color: text, padding: 8, callback: (v) => fmt(v, spec.unit) } },
        },
      },
    });
  }
  function tableHtml(spec) {
    const rows = spec.labels.length ? spec.labels : spec.series[0].data.map((_, i) => String(i + 1));
    return `<div class="viz-table"><table><thead><tr><th></th>${spec.series.map((s) => `<th>${esc(s.name)}</th>`).join("")}</tr></thead><tbody>${rows.map((l, i) =>
      `<tr><th>${esc(l)}</th>${spec.series.map((s) => `<td>${esc(fmt(typeof s.data[i] === "object" ? s.data[i]?.y : s.data[i], spec.unit))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  // ---------- drawing the blocks in an answer ----------
  async function render(root) {
    for (const box of root.querySelectorAll(".viz:not([data-drawn])")) {
      if (box.classList.contains("writing")) continue;
      box.dataset.drawn = "1";
      const src = box.querySelector(".viz-src").textContent;
      try {
        if (box.dataset.kind === "mermaid") await drawMermaid(box, src);
        else await drawChart(box, src);
        box.classList.add("ok");
      } catch (err) {
        box.classList.add("failed");
        box.querySelector(".viz-out").innerHTML = `<div class="viz-err">Couldn't draw this ${box.dataset.kind === "mermaid" ? "diagram" : "chart"} (${esc(String(err.message || err).split("\n")[0].slice(0, 120))}). The code is below.</div>`;
        box.querySelector(".viz-code").hidden = false;
      }
    }
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".viz-btn");
    if (!b) return;
    const box = b.closest(".viz");
    const act = b.dataset.act;
    if (act === "code") { const c = box.querySelector(".viz-code"); c.hidden = !c.hidden; b.setAttribute("aria-pressed", String(!c.hidden)); }
    else if (act === "table" && box._spec) {
      let t = box.querySelector(".viz-table");
      if (t) { t.remove(); b.setAttribute("aria-pressed", "false"); }
      else { box.querySelector(".viz-out").insertAdjacentHTML("beforeend", tableHtml(box._spec)); b.setAttribute("aria-pressed", "true"); }
    } else if (act === "download") {
      const a = document.createElement("a");
      if (box._chart) { a.href = box._chart.toBase64Image("image/png", 1); a.download = "yai-chart.png"; }
      else if (box.dataset.svg) { a.href = URL.createObjectURL(new Blob([box.dataset.svg], { type: "image/svg+xml" })); a.download = "yai-diagram.svg"; }
      else return;
      a.click();
    }
  });
  window.yaiViz = { render };
})();
