// Headless strategy engine — the server's half of the signal brain.
//
// It imports the EXACT SAME strategies.js the chart runs in the browser, so a
// signal the auto-engine fires on can never disagree with the one the user
// sees. (A parallel Python re-implementation was the obvious design and the
// wrong one: two implementations drift, and the whole point of the recent
// unification work was to have one source of truth.)
//
// Protocol: line-delimited JSON on stdin/stdout, one request per line, so the
// server keeps a single long-lived process instead of paying node's startup
// cost on every evaluation.
//
//   in : {"id":1,"strategy":"ema-cross","intraday":true,"bars":[...]}
//   out: {"id":1,"ok":true,"signal":"BUY","barsSince":0,"strength":61,
//         "last":{...},"stats":{...}}
//   out: {"id":1,"ok":false,"error":"..."}
//
// Run: node webui/signal_engine.mjs [/abs/path/to/strategies.js]
// The path is passed by the server so this works both from the source tree and
// from an installed copy, without ever duplicating the strategy code.

import readline from "node:readline";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || path.join(here, "frontend", "src", "strategies.js");
const { analyze, scanAll } = await import(pathToFileURL(target).href);

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function handle(req) {
  const { id, strategy, bars, intraday, mode } = req;
  if (!Array.isArray(bars) || !bars.length) return out({ id, ok: false, error: "no bars" });

  // "scan" evaluates every strategy compatible with the timeframe (watchlist
  // scanning); the default evaluates the one strategy that is armed.
  if (mode === "scan") {
    const rows = scanAll(bars, !!intraday, req.tf).map(({ id: sid, a }) => ({
      id: sid,
      signal: a && !a.error ? a.signal : null,
      strength: a && !a.error ? a.strength : null,
      barsSince: a && !a.error ? a.barsSince : null,
      last: a && !a.error && a.last ? a.last : null,
    }));
    return out({ id, ok: true, rows });
  }

  const a = analyze(strategy, bars, !!intraday);
  if (!a) return out({ id, ok: false, error: `unknown strategy ${strategy}` });
  if (a.error) return out({ id, ok: false, error: a.error, need: a.need, have: a.have });
  out({
    id,
    ok: true,
    signal: a.signal,             // "BUY" | "SELL" | "WAIT"
    barsSince: a.barsSince,
    strength: a.strength,
    last: a.last,                 // {i,time,dir,entry,sl,tp1,tp2}
    stats: a.bt?.stats ?? null,
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let req;
  try {
    req = JSON.parse(s);
  } catch {
    return out({ id: null, ok: false, error: "bad json" });
  }
  try {
    handle(req);
  } catch (e) {
    out({ id: req?.id ?? null, ok: false, error: String(e?.message || e) });
  }
});

// Announce readiness so the server can wait for a live process.
out({ ready: true });
