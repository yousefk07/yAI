// Data analysis worker (2026-10-20): Python (Pyodide) with pandas and matplotlib, running in the browser, off the
// page's thread so a slow script can't freeze the chat and can be stopped. Messages: { id, type: "load", name, bytes,
// varName } puts a data file in /data and loads it as a DataFrame; { id, type: "run", code } runs code and returns its
// output, any error, and the charts it drew.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
importScripts(PYODIDE + "pyodide.js");

let py;
let ready;
async function init() {
  py = await loadPyodide({ indexURL: PYODIDE });
  await py.loadPackage(["pandas", "matplotlib"]);
  py.runPython(`
import io, sys, json, base64, traceback
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
pd.set_option("display.width", 120)
pd.set_option("display.max_columns", 30)
pd.set_option("display.max_rows", 60)

def _yai_load(path, var):
    p = path.lower()
    if p.endswith((".xlsx", ".xls")):
        df = pd.read_excel(path)
    elif p.endswith(".json"):
        try:
            df = pd.read_json(path)
        except ValueError:
            df = pd.read_json(path, lines=True)
    elif p.endswith(".tsv"):
        df = pd.read_csv(path, sep="\\t")
    else:
        df = pd.read_csv(path, sep=None, engine="python")
    globals()[var] = df
    cols = [f"{c} ({t})" for c, t in zip(df.columns, df.dtypes.astype(str))]
    return json.dumps({"rows": int(df.shape[0]), "cols": int(df.shape[1]), "columns": cols[:80],
                       "head": df.head(5).to_string(max_cols=30, max_colwidth=40)})

def _yai_run(code):
    buf = io.StringIO()
    old = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = buf
    plt.show = lambda *a, **k: None
    err = None
    try:
        exec(compile(code, "<analysis>", "exec"), globals())
    except Exception:
        err = traceback.format_exc(limit=4)
    finally:
        sys.stdout, sys.stderr = old
    imgs = []
    for n in plt.get_fignums()[:4]:
        f = plt.figure(n)
        b = io.BytesIO()
        f.savefig(b, format="png", dpi=110, bbox_inches="tight")
        imgs.append("data:image/png;base64," + base64.b64encode(b.getvalue()).decode())
    plt.close("all")
    return json.dumps({"stdout": buf.getvalue()[-8000:], "images": imgs, "error": err})
`);
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (!ready) ready = init();
    await ready;
    if (type === "ping") return self.postMessage({ id, ok: true });
    if (type === "load") {
      const { name, bytes, varName } = e.data;
      py.FS.mkdirTree("/data");
      py.FS.writeFile("/data/" + name, new Uint8Array(bytes));
      if (/\.xlsx?$/i.test(name)) await py.loadPackage("openpyxl");
      const out = py.globals.get("_yai_load")("/data/" + name, varName);
      return self.postMessage({ id, ok: true, result: JSON.parse(out) });
    }
    if (type === "run") {
      const out = py.globals.get("_yai_run")(e.data.code);
      return self.postMessage({ id, ok: true, result: JSON.parse(out) });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
