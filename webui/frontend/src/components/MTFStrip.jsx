import { useEffect, useState } from "react";
import { technicalRating } from "../indicators.js";

// Multi-timeframe confluence: the 11-rule technical rating on five
// timeframes at once (1m first — scalping focus). Alignment across
// timeframes = higher-quality setups.
const TFS = [
  { tf: "1m", range: "1d", intraday: true },
  { tf: "5m", range: "5d", intraday: true },
  { tf: "15m", range: "5d", intraday: true },
  { tf: "1h", range: "1mo", intraday: true },
  { tf: "1d", range: "1y", intraday: false },
];

const BUCKET_COLOR = {
  strongBuy: "#2fd67b",
  buy: "#7ddf9a",
  neutral: "#e8b64c",
  sell: "#ff9aa4",
  strongSell: "#ff5d6c",
};

export default function MTFStrip({ ticker, t }) {
  const P = t.plan;
  const [cells, setCells] = useState(null); // [{tf, rating}] | null loading
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setCells(null);
    Promise.all(
      TFS.map(({ tf, range, intraday }) =>
        fetch(`/api/chart?ticker=${encodeURIComponent(ticker)}&range=${range}&interval=${tf}`)
          .then((r) => r.json())
          .then((d) => ({ tf, rating: d.bars?.length ? technicalRating(d.bars, intraday) : null }))
          .catch(() => ({ tf, rating: null })),
      ),
    ).then((res) => !cancelled && setCells(res));
    return () => {
      cancelled = true;
    };
  }, [ticker, nonce]);

  const scores = (cells || []).flatMap((c) => (c.rating ? [c.rating.score] : []));
  const mean = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
  const consensus =
    mean == null
      ? null
      : mean >= 0.5 ? "strongBuy" : mean >= 0.15 ? "buy" : mean > -0.15 ? "neutral" : mean > -0.5 ? "sell" : "strongSell";

  return (
    <div className="panel panel-pad plan-sect">
      <div className="plan-sig-head">
        <div>
          <h3>{P.mtfTitle}</h3>
          <div className="sub" style={{ marginBottom: 0 }}>{P.mtfSub}</div>
        </div>
        <button className="rtab" onClick={() => setNonce((n) => n + 1)}>⟳ {P.refresh}</button>
      </div>

      {!cells && <div className="plan-loading">⏳</div>}

      {cells && (
        <div className="mtf-grid" dir="ltr">
          {cells.map(({ tf, rating }) => (
            <div key={tf} className="mtf-cell">
              <div className="mtf-tf">{t.timeframes[tf] || tf}</div>
              {rating ? (
                <>
                  <div className="mtf-bucket" style={{ color: BUCKET_COLOR[rating.bucket] }}>
                    {t.ratings[rating.bucket]}
                  </div>
                  <div className="mtf-bar">
                    <i
                      style={{
                        width: `${Math.round(((rating.score + 1) / 2) * 100)}%`,
                        background: BUCKET_COLOR[rating.bucket],
                      }}
                    />
                  </div>
                  <div className="mtf-counts">
                    <span className="up">{rating.counts.buy}</span>·
                    <span className="mid">{rating.counts.neutral}</span>·
                    <span className="down">{rating.counts.sell}</span>
                  </div>
                </>
              ) : (
                <div className="mtf-bucket" style={{ color: "var(--faint)" }}>—</div>
              )}
            </div>
          ))}
          {consensus && (
            <div className="mtf-cell consensus">
              <div className="mtf-tf">{P.mtfConsensus}</div>
              <div className="mtf-bucket big" style={{ color: BUCKET_COLOR[consensus] }}>
                {t.ratings[consensus]}
              </div>
              <div className="mtf-bar">
                <i
                  style={{
                    width: `${Math.round(((mean + 1) / 2) * 100)}%`,
                    background: BUCKET_COLOR[consensus],
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )}
      <div className="hint" style={{ marginTop: 10 }}>{P.mtfHint}</div>
    </div>
  );
}
