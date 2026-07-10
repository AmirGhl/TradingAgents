import { useCallback, useEffect, useRef, useState } from "react";

const money = (v, ccy) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}${ccy ? " " + ccy : ""}`;
const fmtT = (unix, lang) => {
  try {
    return new Date(unix * 1000).toLocaleString(lang === "fa" ? "fa-IR" : "en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return String(unix);
  }
};

/** Realized-equity sparkline from the journal's cumulative curve. */
function Curve({ curve }) {
  if (!curve || curve.length < 2) return null;
  const ys = curve.map((p) => p.equity);
  const min = Math.min(0, ...ys), max = Math.max(0, ...ys);
  const H = 70, W = 220;
  const y = (v) => H - ((v - min) / Math.max(max - min, 1e-9)) * (H - 8) - 4;
  const x = (i) => (i / (curve.length - 1)) * W;
  const path = curve.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
  const final = ys[ys.length - 1];
  const color = final >= 0 ? "#2fd67b" : "#ff5d6c";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 70 }} aria-hidden="true">
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="rgba(143,161,194,0.35)" strokeDasharray="2 2" strokeWidth="0.5" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Trade journal + performance dashboard from the broker's real closed deals:
 *  realized P/L, winrate, an equity curve and per-strategy stats. */
export default function JournalPanel({ t, lang }) {
  const J = t.journal;
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const reqRef = useRef(0);
  const load = useCallback((d) => {
    const seq = ++reqRef.current; // ignore an out-of-order response for an old window
    setLoading(true);
    fetch(`/api/mt5/journal?days=${d}`)
      .then((r) => r.json())
      .then((res) => { if (seq === reqRef.current) setData(res); })
      .catch(() => { if (seq === reqRef.current) setData({ ok: false, error: "server unreachable" }); })
      .finally(() => { if (seq === reqRef.current) setLoading(false); });
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  const ccy = data?.account?.currency || "";
  const sum = data?.summary;

  return (
    <div className="panel panel-pad plan-sect">
      <div className="pos-head">
        <div>
          <h3>{J.title}</h3>
          <div className="sub" style={{ marginBottom: 0 }}>{J.sub}</div>
        </div>
        <div className="chips" role="group">
          {[7, 30, 90].map((d) => (
            <button key={d} className={`chip sm ${days === d ? "on" : ""}`} onClick={() => setDays(d)}>
              {J.days.replace("{n}", d)}
            </button>
          ))}
          <button className="rtab pos-refresh" onClick={() => load(days)} title={J.refresh}>⟳</button>
        </div>
      </div>

      {loading && !data && <div className="plan-loading">⏳</div>}
      {data && !data.ok && <div className="ticket-warn">⚠ {data.error || J.disabled}</div>}

      {data && data.ok && (
        <>
          <div className="levels" style={{ marginTop: 8 }}>
            <div className="level"><div className="k">{J.trades}</div><div className="v">{sum.count}</div></div>
            <div className="level entry">
              <div className="k">{J.winRate}</div>
              <div className="v">{sum.winRate != null ? `${sum.winRate}%` : "—"}</div>
            </div>
            <div className={`level ${sum.profit >= 0 ? "tp" : "sl"}`}>
              <div className="k">{J.netProfit}</div>
              <div className="v">{money(sum.profit, ccy)}</div>
            </div>
          </div>

          {data.curve?.length > 1 && (
            <div style={{ marginTop: 12 }}>
              <div className="plan-h">{J.equityCurve}</div>
              <Curve curve={data.curve} />
            </div>
          )}

          {data.perStrategy?.length > 0 && (
            <>
              <div className="plan-h" style={{ marginTop: 14 }}>{J.perStrategy}</div>
              <div className="scan-wrap">
                <table className="scan-table" dir="ltr">
                  <thead>
                    <tr className="scan-head">
                      <th>{J.strategy}</th><th>{J.trades}</th><th>{J.winRate}</th><th>{J.pf}</th><th>{J.profit}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perStrategy.map((p) => (
                      <tr key={p.tag}>
                        <td className="scan-name">{p.tag}</td>
                        <td className="mono">{p.trades}</td>
                        <td className="mono" style={{ color: p.winRate >= 50 ? "var(--green)" : p.winRate != null ? "var(--red)" : undefined }}>
                          {p.winRate != null ? `${p.winRate}%` : "—"}
                        </td>
                        <td className="mono">{p.profitFactor == null ? "—" : p.profitFactor}</td>
                        <td className={`mono ${p.profit >= 0 ? "up" : "down"}`}>{money(p.profit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {data.trades?.length > 0 ? (
            <>
              <div className="plan-h" style={{ marginTop: 14 }}>{J.recent}</div>
              <div className="scan-wrap">
                <table className="scan-table pos-table" dir="ltr">
                  <thead>
                    <tr className="scan-head">
                      <th>{J.time}</th><th>{J.symbol}</th><th>{J.dir}</th><th>{J.volume}</th><th>{J.exit}</th><th>{J.pnl}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.trades.map((r, i) => (
                      <tr key={`${r.position}-${r.time}-${i}`}>
                        <td className="scan-last">{fmtT(r.time, lang)}</td>
                        <td className="scan-name">{r.symbol}</td>
                        <td><span className={`vbadge ${r.dir === "BUY" ? "up" : "down"}`}>{r.dir}</span></td>
                        <td className="mono">{Number(r.volume).toFixed(2)}</td>
                        <td className="mono">{r.price}</td>
                        <td className={`mono ${r.profit >= 0 ? "up" : "down"}`}>{money(r.profit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="hint" style={{ padding: "16px 0" }}>{J.empty}</div>
          )}
          <div className="hint" style={{ marginTop: 10 }}>{J.note}</div>
        </>
      )}
    </div>
  );
}
