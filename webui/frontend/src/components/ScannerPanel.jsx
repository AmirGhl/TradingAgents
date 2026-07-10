import { useRef, useState } from "react";
import { STRATEGIES, scanAll } from "../strategies.js";

// timeframe → yfinance range for the on-demand scan (mirrors PlanPanel's table).
const TF_RANGE = { "1m": "1d", "5m": "5d", "15m": "1mo", "1h": "3mo" };

/** A+ watchlist scanner: ON DEMAND (the scan button — deliberately not
 *  automatic), sweep every watchlist symbol through all compatible strategies
 *  (the same client-side engine the Plan tab uses) and surface only the
 *  actionable, high-conviction setups — ranked. */
export default function ScannerPanel({ t, lang, watchlist, onPick }) {
  const S = t.scanner;
  const [tf, setTf] = useState("5m");
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(0);
  const busyRef = useRef(false);

  const scan = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const syms = [...new Set((watchlist || []).filter(Boolean))].slice(0, 24);
    if (!syms.length) { setRows([]); busyRef.current = false; return; }
    setBusy(true);
    setRows(null);
    setProg(0);
    const out = [];
    let done = 0;
    const intraday = tf !== "1d";
    await Promise.all(
      syms.map(async (sym) => {
        try {
          const r = await fetch(
            `/api/chart?ticker=${encodeURIComponent(sym)}&range=${TF_RANGE[tf] || "5d"}&interval=${tf}`,
          );
          const data = await r.json();
          if (data.bars?.length) {
            const best = scanAll(data.bars, intraday, tf)
              .filter((x) => x.a && !x.a.error && x.a.last && x.a.signal !== "WAIT")
              .sort((p, q) => (q.a.strength || 0) - (p.a.strength || 0))[0];
            if (best) {
              const a = best.a;
              const st = a.bt?.stats;
              out.push({
                sym,
                stratId: best.id,
                icon: best.icon,
                dir: a.last.dir,
                strength: a.strength,
                barsSince: a.barsSince,
                rr: Math.abs(a.last.tp2 - a.last.entry) / Math.max(Math.abs(a.last.entry - a.last.sl), 1e-9),
                avgR: st?.avgR ?? null,
                winRate: st?.winRate ?? null,
              });
            }
          }
        } catch { /* skip unreachable symbol */ }
        done += 1;
        setProg(Math.round((done / syms.length) * 100));
      }),
    );
    // A+ ranking: conviction first, then a positive backtest edge.
    out.sort((p, q) => (q.strength || 0) - (p.strength || 0) || (q.avgR ?? -9) - (p.avgR ?? -9));
    setRows(out);
    setBusy(false);
    busyRef.current = false;
  };

  return (
    <div className="panel panel-pad plan-sect">
      <div className="pos-head">
        <div>
          <h3>{S.title}</h3>
          <div className="sub" style={{ marginBottom: 0 }}>{S.sub}</div>
        </div>
        <div className="chips" role="group">
          {["1m", "5m", "15m", "1h"].map((x) => (
            <button key={x} className={`chip sm ${tf === x ? "on" : ""}`} onClick={() => setTf(x)}>
              {t.timeframes[x] || x}
            </button>
          ))}
          <button className="rtab on" disabled={busy} onClick={scan}>
            {busy ? `${prog}%` : S.scan}
          </button>
        </div>
      </div>

      {rows && rows.length === 0 && <div className="hint" style={{ padding: "14px 0" }}>{S.none}</div>}
      {rows && rows.length > 0 && (
        <div className="scan-wrap">
          <table className="scan-table" dir="ltr">
            <thead>
              <tr className="scan-head">
                <th>{S.symbol}</th><th>{S.strategy}</th><th>{S.signal}</th>
                <th>{S.strength}</th><th>RR</th><th>{S.avgR}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sym + r.stratId} className="scan-row">
                  <td className="scan-name">{r.sym}</td>
                  <td>{r.icon} {STRATEGIES.find((s) => s.id === r.stratId)?.meta[lang === "fa" ? "fa" : "en"].name}</td>
                  <td><span className={`vbadge ${r.dir === "BUY" ? "up" : "down"}`}>{r.dir}</span></td>
                  <td className="mono">{r.strength}%</td>
                  <td className="mono">{r.rr != null ? r.rr.toFixed(1) : "—"}</td>
                  <td className="mono" style={{ color: r.avgR > 0 ? "var(--green)" : r.avgR != null ? "var(--red)" : undefined }}>
                    {r.avgR != null ? r.avgR.toFixed(2) : ""}
                  </td>
                  <td><button className="rtab xs" onClick={() => onPick?.(r.sym, r.stratId)}>{S.open}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint" style={{ marginTop: 10 }}>{S.note}</div>
    </div>
  );
}
