// Data analysis on the chat page (2026-10-20): data files (CSV, TSV, Excel, JSON) are loaded into Python in a worker
// (data-worker.js), the model writes pandas / matplotlib code, and it runs here in the browser. The files stay on this
// device, in memory for this visit (a reload means attaching them again).
//   yaiData.isDataFile(file)  yaiData.load(file) -> { name, varName, rows, cols, columns, head }
//   yaiData.run(code) -> { stdout, images, error, ms }   yaiData.files() -> [{ name, varName, rows, cols }]
(function () {
  const DATA_RE = /\.(csv|tsv|xlsx|xls|json)$/i;
  const RUN_LIMIT_MS = 60000;
  let worker = null;
  let seq = 0;
  const pending = new Map();
  const loaded = new Map(); // name -> { name, varName, bytes, rows, cols, columns, head }

  function start() {
    worker = new Worker("/data-worker.js");
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "Python stopped"));
      pending.clear();
    };
  }
  function call(msg, transfer, timeout) {
    if (!worker) start();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = timeout && setTimeout(() => {
        // A script that runs too long: the worker is stopped and started again, with the files reloaded.
        pending.delete(id);
        worker.terminate();
        worker = null;
        reject(new Error(`The code ran for over ${Math.round(timeout / 1000)} s and was stopped.`));
        reloadAll();
      }, timeout);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (err) => (clearTimeout(timer), reject(err)),
      });
      worker.postMessage({ id, ...msg }, transfer || []);
    });
  }
  function reloadAll() {
    for (const f of loaded.values()) call({ type: "load", name: f.name, bytes: f.bytes.slice(0), varName: f.varName }).catch(() => {});
  }

  const safeName = (n) => n.replace(/[^\w.-]+/g, "_").slice(0, 80);
  window.yaiData = {
    isDataFile: (file) => DATA_RE.test(file.name || ""),
    files: () => [...loaded.values()].map(({ name, varName, rows, cols }) => ({ name, varName, rows, cols })),
    hasFiles: () => loaded.size > 0,
    clear() {
      loaded.clear();
      if (worker) worker.terminate();
      worker = null;
    },
    warm: () => call({ type: "ping" }),
    async load(file) {
      if (file.size > 50e6) throw new Error("Too large (50 MB max)");
      const name = safeName(file.name);
      const existing = loaded.get(name);
      const varName = existing ? existing.varName : loaded.size === 0 ? "df" : `df${loaded.size + 1}`;
      const bytes = await file.arrayBuffer();
      const info = await call({ type: "load", name, bytes: bytes.slice(0), varName }, null, 120000);
      loaded.set(name, { name, varName, bytes, ...info });
      return { name, varName, ...info };
    },
    async run(code) {
      const t0 = performance.now();
      const r = await call({ type: "run", code }, null, RUN_LIMIT_MS);
      return { ...r, ms: Math.round(performance.now() - t0) };
    },
  };
})();
