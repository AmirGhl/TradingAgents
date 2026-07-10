import { motion, useReducedMotion } from "motion/react";
import AnimatedNumber from "./AnimatedNumber.jsx";
import AutoTrade from "./AutoTrade.jsx";

const BUCKET_COLOR = {
  strongBuy: "#2fd67b",
  buy: "#7ddf9a",
  neutral: "#e8b64c",
  sell: "#ff9aa4",
  strongSell: "#ff5d6c",
};

/** TradingView-style gauge: needle sweeps a semicircle from strong-sell
 *  (left) to strong-buy (right) according to the vote score.
 *
 *  The needle tip is computed with trig and animated via the SVG line's
 *  x2/y2 attributes. (A CSS rotate with a pixel transform-origin breaks
 *  here: the SVG is scaled — viewBox 200 wide, rendered at 230px — so CSS
 *  pixels and viewBox units disagree and the pivot lands off-center,
 *  which pinned the needle visually on the buy side even for sell.) */
export function Gauge({ score, bucket, label }) {
  const reduce = useReducedMotion();
  const clamped = Math.max(-1, Math.min(1, score ?? 0));
  const angle = clamped * 82; // -82° … 82°
  const arcs = [
    ["#ff5d6c", -90, -54],
    ["#ff9aa4", -54, -18],
    ["#e8b64c", -18, 18],
    ["#7ddf9a", 18, 54],
    ["#2fd67b", 54, 90],
  ];
  const polar = (deg, r) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [100 + r * Math.cos(rad), 100 + r * Math.sin(rad)];
  };
  const [tipX, tipY] = polar(angle, 68);
  return (
    <div className="gauge">
      <svg viewBox="0 0 200 118" width="230" role="img" aria-label={label}>
        {arcs.map(([color, a0, a1]) => {
          const [x0, y0] = polar(a0, 82);
          const [x1, y1] = polar(a1, 82);
          return (
            <path
              key={color + a0}
              d={`M ${x0} ${y0} A 82 82 0 0 1 ${x1} ${y1}`}
              fill="none"
              stroke={color}
              strokeWidth="13"
              strokeLinecap="round"
              opacity="0.85"
            />
          );
        })}
        <motion.line
          x1="100"
          y1="100"
          initial={false}
          animate={{ x2: tipX, y2: tipY }}
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 55, damping: 14 }}
          stroke="#e9eef9"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <circle cx="100" cy="100" r="7" fill="#e9eef9" />
      </svg>
      <motion.div
        key={bucket}
        className="gauge-label"
        style={{ color: BUCKET_COLOR[bucket] }}
        initial={false}
        animate={{ opacity: 1, y: 0 }}
      >
        {label}
      </motion.div>
    </div>
  );
}

const VOTE_TXT = { 1: "voteBuy", 0: "voteNeutral", "-1": "voteSell" };
const VOTE_CLS = { 1: "up", 0: "mid", "-1": "down" };

export default function TechRating({ rating, t, spotInfo, futuresLast, ticker, mt5 }) {
  if (!rating) return null;
  const { bucket, score, votes, counts, levels } = rating;
  const lv = [
    { label: t.entry, value: levels.entry, cls: "entry" },
    { label: t.stopLoss, value: levels.sl, cls: "sl" },
    { label: t.tp1, value: levels.tp1, cls: "tp" },
    { label: t.tp2, value: levels.tp2, cls: "tp" },
    { label: t.rr, value: levels.rr, cls: "rr", decimals: 1 },
    { label: t.atr, value: levels.atr, cls: "" },
  ];

  // Futures → spot (MT5) conversion: shift levels by the live spread. On the
  // live broker feed the levels already ARE the broker's own prices (spotInfo
  // carries only the resolved symbol), so there is nothing to shift.
  const spread =
    !mt5 && spotInfo?.spot != null && futuresLast != null ? futuresLast - spotInfo.spot : null;
  const spotLv =
    spread != null
      ? [
          { label: t.entry, value: levels.entry - spread, cls: "entry" },
          { label: t.stopLoss, value: levels.sl - spread, cls: "sl" },
          { label: t.tp1, value: levels.tp1 - spread, cls: "tp" },
          { label: t.tp2, value: levels.tp2 - spread, cls: "tp" },
        ]
      : null;
  return (
    // No entrance animation: the rating must stay visible even if JS
    // animation frames stall (headless, reduced-power, background tabs).
    <motion.div className="panel panel-pad rating" initial={false}>
      <h3>{t.techRating}</h3>
      <div className="sub">{t.techRatingSub}</div>

      <div className="rating-grid">
        <div className="rating-gauge">
          <Gauge score={score} bucket={bucket} label={t.ratings[bucket]} />
          <div className="vote-counts" dir="ltr">
            <span className="vc down">{counts.sell} {t.voteSell}</span>
            <span className="vc mid">{counts.neutral} {t.voteNeutral}</span>
            <span className="vc up">{counts.buy} {t.voteBuy}</span>
          </div>
        </div>

        <div className="vote-list">
          {votes.map((v) => (
            <div key={v.key} className="vote-row">
              <span className="vname">{t.ruleNames[v.key]}</span>
              <span className={`vbadge ${VOTE_CLS[v.vote]}`}>{t[VOTE_TXT[v.vote]]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="levels" style={{ marginTop: 16 }}>
        {lv.map((x) => (
          <div key={x.label} className={`level ${x.cls}`}>
            <div className="k">{x.label}</div>
            <div className="v">
              <AnimatedNumber value={x.value} decimals={x.decimals ?? 2} />
            </div>
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        {t.suggestedLevels}
        {levels.dir === "HOLD" ? ` — ${t.condPlan}` : ""}
      </div>

      <AutoTrade t={t} ticker={ticker} levels={levels} spotInfo={spotInfo} spread={spread} />

      {spotLv && (
        <div className="spot-levels">
          <div className="spot-title">
            {t.spotLevels.replace("{pair}", spotInfo.pair)}
            <span className="spot-spread" dir="ltr">
              {t.spread}: {spread.toFixed(2)}
            </span>
          </div>
          <div className="levels">
            {spotLv.map((x) => (
              <div key={x.label} className={`level ${x.cls}`}>
                <div className="k">{x.label}</div>
                <div className="v">
                  <AnimatedNumber value={x.value} decimals={2} />
                </div>
              </div>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {t.spotNote.replace("{pair}", spotInfo.pair)}
          </div>
        </div>
      )}
      {!mt5 && spotInfo?.pair && spotInfo.spot == null && (
        <div className="hint" style={{ marginTop: 8, color: "var(--gold)" }}>
          ⚠ {t.spotUnavailable}
        </div>
      )}
    </motion.div>
  );
}
