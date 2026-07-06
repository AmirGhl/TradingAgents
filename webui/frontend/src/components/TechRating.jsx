import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import AnimatedNumber from "./AnimatedNumber.jsx";

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
function Gauge({ score, bucket, label }) {
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

/** yfinance ticker → best-guess MT5 symbol (editable in the UI). */
function brokerSymbol(tk) {
  const up = (tk || "").toUpperCase();
  if (up.endsWith("=X")) return up.slice(0, -2); // EURUSD=X → EURUSD
  if (up.endsWith("-USD")) return up.slice(0, -4) + "USD"; // BTC-USD → BTCUSD
  return up.replace(/[=^.\-]/g, "");
}

/** One-click MT5 execution of the automatic rating's levels. The account
 *  lives in server settings; this block only picks symbol/lot/TP and confirms. */
function AutoTrade({ t, ticker, levels, spotInfo, spread }) {
  const A = t.autoTrade;
  const [st, setSt] = useState(null); // /api/mt5/status payload
  const [lot, setLot] = useState(null); // null → server default
  const [tp, setTp] = useState("tp1");
  const [symOverride, setSymOverride] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {ok, error, ...}

  useEffect(() => {
    let cancelled = false;
    setSymOverride(null);
    setResult(null);
    fetch("/api/mt5/status")
      .then((r) => r.json())
      .then((d) => !cancelled && setSt(d))
      .catch(() => !cancelled && setSt({ enabled: false }));
    return () => { cancelled = true; };
  }, [ticker]);

  if (!st) return null;
  if (!st.enabled)
    return (
      <div className="autotrade off">
        <div className="at-head">🤖 {A.title}</div>
        <div className="hint">{A.notConfigured}</div>
      </div>
    );

  const dir = levels.dir;
  // MT5 trades the spot pair for futures charts → shift levels by the spread.
  const shift = spread != null ? spread : 0;
  const symbol = symOverride ?? (spotInfo?.pair || brokerSymbol(ticker));
  const entry = levels.entry - shift;
  const sl = levels.sl - shift;
  const tpPrice = (tp === "tp1" ? levels.tp1 : levels.tp2) - shift;
  const effLot = lot ?? st.lot ?? 0.01;

  const send = () => {
    if (dir === "HOLD" || busy) return;
    const msg = A.confirm
      .replace("{dir}", dir)
      .replace("{symbol}", symbol)
      .replace("{lot}", String(effLot))
      .replace("{sl}", sl.toFixed(2))
      .replace("{tp}", tpPrice.toFixed(2));
    if (!window.confirm(msg)) return;
    setBusy(true);
    setResult(null);
    fetch("/api/mt5/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        dir,
        lot: effLot,
        sl: Number(sl.toFixed(2)),
        tp: Number(tpPrice.toFixed(2)),
        comment: "TA-webui auto",
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        setResult(d);
        if (d.account) setSt((p) => ({ ...p, account: d.account }));
      })
      .catch((e) => setResult({ ok: false, error: String(e) }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="autotrade">
      <div className="at-head">
        🤖 {A.title}
        {st.account ? (
          <span className="at-acct" dir="ltr">
            #{st.account.login} · {A.balance} {Number(st.account.balance).toLocaleString("en-US")}{" "}
            {st.account.currency}
          </span>
        ) : (
          <span className="at-acct warn">{A.disconnected}</span>
        )}
      </div>

      <div className="at-row" dir="ltr">
        <span className={`vbadge ${dir === "BUY" ? "up" : dir === "SELL" ? "down" : "mid"}`}>
          {dir}
        </span>
        <input
          className="at-sym-input"
          type="text"
          value={symbol}
          dir="ltr"
          spellCheck={false}
          onChange={(e) => setSymOverride(e.target.value.toUpperCase())}
        />
        <label className="at-field">
          {A.lot}
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={effLot}
            onChange={(e) => setLot(Number(e.target.value))}
          />
        </label>
        <label className="at-field">
          TP
          <select value={tp} onChange={(e) => setTp(e.target.value)}>
            <option value="tp1">TP1 {levels.tp1 != null ? (levels.tp1 - shift).toFixed(2) : ""}</option>
            <option value="tp2">TP2 {levels.tp2 != null ? (levels.tp2 - shift).toFixed(2) : ""}</option>
          </select>
        </label>
        <button
          className={`at-btn ${dir === "BUY" ? "buy" : dir === "SELL" ? "sell" : ""}`}
          disabled={dir === "HOLD" || busy || !symbol}
          onClick={send}
        >
          {busy ? A.sending : dir === "HOLD" ? A.holdNoTrade : A.send.replace("{dir}", dir)}
        </button>
      </div>

      <div className="hint at-note" dir="ltr">
        SL {sl.toFixed(2)} · TP {tpPrice.toFixed(2)}
        {spread != null && ` · ${t.spread} ${spread.toFixed(2)}`}
      </div>

      {result && (
        <div className={`at-result ${result.ok ? "ok" : "err"}`}>
          {result.ok
            ? `✅ ${A.sent} — #${result.order ?? ""} @ ${result.price ?? ""}`
            : `✖ ${A.fail}: ${result.error}`}
        </div>
      )}
      <div className="hint">{A.riskNote}</div>
    </div>
  );
}

export default function TechRating({ rating, t, spotInfo, futuresLast, ticker }) {
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

  // Futures → spot (MT5) conversion: shift levels by the live spread.
  const spread =
    spotInfo?.spot != null && futuresLast != null ? futuresLast - spotInfo.spot : null;
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
      {spotInfo?.pair && spotInfo.spot == null && (
        <div className="hint" style={{ marginTop: 8, color: "var(--gold)" }}>
          ⚠ {t.spotUnavailable}
        </div>
      )}
    </motion.div>
  );
}
