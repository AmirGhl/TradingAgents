import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { scanAll, STRATEGIES } from "../strategies.js";
import { Gauge } from "./TechRating.jsx";

/** Aggregate strategy gauge for the chart page: every strategy compatible
 *  with the current timeframe votes through the SAME analyze() engine the
 *  Plan tab uses. Only FRESH signals vote (weighted by their strength);
 *  a WAIT strategy adds neutral weight that pulls the needle to the middle.
 *  Clicking a row selects that strategy on the chart.
 *
 *  Directly under the needle sits `children` — the selected strategy's own
 *  one-click trade block. It only exists while that strategy has a FRESH
 *  signal; on a neutral strategy the caller passes nothing and we say so
 *  instead of offering an entry. */
export default function StrategyGauge({ bars, intraday, tf, t, activeId, onPick, live, children }) {
  const G = t.stratGauge;
  // Scanning all ~12 strategies (each with a backtest) is far too heavy to run
  // on every 7 Hz stream tick, so throttle the forming-bar refresh to ~1 s
  // while still re-running instantly when a new bar closes (last.time change).
  // The selected strategy's own signal, shown under the needle, is NOT
  // throttled — it comes from `live` and updates on every tick.
  const [slow, setSlow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSlow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const last = bars?.[bars.length - 1];
  const scanKey = bars ? `${bars.length}:${last?.time}:${tf}:${intraday}:${slow}` : "";
  const rows = useMemo(
    () => (bars ? scanAll(bars, intraday, tf).filter((x) => x.a && !x.a.error) : []),
    [scanKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (!rows.length) return null;

  let buy = 0, sell = 0, wait = 0, wsum = 0, wtot = 0;
  for (const { a } of rows) {
    const w = (a.strength ?? 50) / 100;
    if (a.signal === "BUY") { buy += 1; wsum += w; wtot += w; }
    else if (a.signal === "SELL") { sell += 1; wsum -= w; wtot += w; }
    else { wait += 1; wtot += 0.5; }
  }
  const score = Math.max(-1, Math.min(1, wsum / Math.max(wtot, 1e-9)));
  const bucket =
    score >= 0.5 ? "strongBuy" : score >= 0.15 ? "buy" :
    score > -0.15 ? "neutral" : score > -0.5 ? "sell" : "strongSell";

  const lang = t.dir === "rtl" ? "fa" : "en";
  return (
    <motion.div className="panel panel-pad rating" initial={false} style={{ marginBottom: 18 }}>
      <h3>{G.title}</h3>
      <div className="sub">
        {G.sub.replace("{n}", rows.length).replace("{tf}", t.timeframes[tf] || tf)}
      </div>

      <div className="rating-grid">
        <div className="rating-gauge">
          <Gauge score={score} bucket={bucket} label={t.ratings[bucket]} />
          <div className="vote-counts" dir="ltr">
            <span className="vc down">{sell} {G.sell}</span>
            <span className="vc mid">{wait} {G.wait}</span>
            <span className="vc up">{buy} {G.buy}</span>
          </div>
        </div>

        <div className="vote-list sg-list">
          {rows.map(({ id, icon, a }) => {
            const m = STRATEGIES.find((s) => s.id === id).meta[lang];
            const sig = a.signal;
            return (
              <button
                key={id}
                type="button"
                className={`vote-row sg-row ${id === activeId ? "on" : ""}`}
                onClick={() => onPick?.(id)}
                title={G.pick}
              >
                <span className="vname">{icon} {m.name}</span>
                <span className={`vbadge ${sig === "BUY" ? "up" : sig === "SELL" ? "down" : "mid"}`}>
                  {sig === "WAIT" ? t.plan.dirWait : sig}
                  {sig !== "WAIT" && a.strength != null ? ` · ${a.strength}%` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* The selected strategy's one-click trade block, right under the needle.
          `children` is only passed while that strategy has a fresh signal — a
          neutral strategy gets the "no entry" note instead of a Send button. */}
      {children ? (
        <div className="sg-trade">{children}</div>
      ) : (
        live?.strat && live.analysis && !live.analysis.error && (
          <div className="sg-trade">
            <div className="hint">
              ⏸ {t.plan.waitNoTrade}
              {live.analysis.last
                ? ` · ${live.analysis.last.dir} ${t.plan.barsAgo.replace("{n}", live.analysis.barsSince)}`
                : ""}
            </div>
          </div>
        )
      )}

      <div className="hint" style={{ marginTop: 8 }}>{G.hint}</div>
    </motion.div>
  );
}
