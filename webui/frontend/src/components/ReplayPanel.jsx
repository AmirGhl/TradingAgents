import { useEffect, useRef, useState } from "react";

/** Paper-forward replay: steps through the strategy's historical trades one by
 *  one on a timer, revealing a running R and win-rate — watch how the system
 *  would have traded, without any live order. Pure client-side over the
 *  backtest results already computed for this strategy/timeframe. */
export default function ReplayPanel({ results, t }) {
  const R = t.replay;
  const closed = (results || []).filter((x) => x.r != null);
  const [i, setI] = useState(0); // trades revealed so far
  const [playing, setPlaying] = useState(false);
  const timer = useRef(null);

  // Reset when the underlying trade set changes (strategy/timeframe switch).
  useEffect(() => {
    setI(0);
    setPlaying(false);
  }, [results]);

  useEffect(() => {
    if (!playing) return;
    if (i >= closed.length) {
      setPlaying(false);
      return;
    }
    timer.current = setTimeout(() => setI((n) => n + 1), 420);
    return () => clearTimeout(timer.current);
  }, [playing, i, closed.length]);

  if (closed.length < 2) return null;

  const shown = closed.slice(0, i);
  const cumR = shown.reduce((s, x) => s + x.r, 0);
  const wins = shown.filter((x) => x.r > 0).length;

  return (
    <div style={{ marginTop: 16 }}>
      <div className="plan-h">{R.title}</div>
      <div className="plan-actions" style={{ alignItems: "center", gap: 10 }}>
        <button
          className="rtab on"
          onClick={() => {
            if (i >= closed.length) setI(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? R.pause : i >= closed.length ? R.restart : R.play}
        </button>
        <span className="hint" dir="ltr">{i}/{closed.length}</span>
        <span
          className={cumR >= 0 ? "up" : "down"}
          dir="ltr"
          style={{ fontWeight: 700, fontFamily: "var(--font-mono)" }}
        >
          {cumR >= 0 ? "+" : ""}{cumR.toFixed(1)}R
        </span>
        {i > 0 && (
          <span className="hint" dir="ltr">
            {R.winrate}: {Math.round((wins / i) * 100)}%
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 8 }}>
        {closed.map((x, idx) => (
          <span
            key={idx}
            title={`${x.r > 0 ? "+" : ""}${x.r.toFixed(1)}R`}
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              background:
                idx < i
                  ? x.r > 0
                    ? "var(--green)"
                    : "var(--red)"
                  : "rgba(143,161,194,0.18)",
              transition: "background .2s",
            }}
          />
        ))}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>{R.note}</div>
    </div>
  );
}
