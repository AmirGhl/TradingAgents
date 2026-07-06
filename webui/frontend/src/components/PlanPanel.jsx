import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { STRATEGIES, CATEGORIES, analyze, scanAll } from "../strategies.js";
import AnimatedNumber from "./AnimatedNumber.jsx";
import MTFStrip from "./MTFStrip.jsx";
import { beep, notify } from "../utils.js";

// timeframe → [yfinance range, poll ms]. Longer ranges than the chart tab so
// slow strategies (SMA200, Ichimoku) have enough bars.
const TF_FETCH = {
  "1m": ["1d", 10_000],
  "5m": ["5d", 30_000],
  "15m": ["1mo", 30_000],
  "1h": ["3mo", 60_000],
  "1d": ["2y", null],
  "1wk": ["5y", null],
};
const INTRADAY = new Set(["1m", "5m", "15m", "1h"]);

const LS_STRAT = "ta_plan_strategy";
const LS_CALC = "ta_plan_calc";

const CAT_CLS = {
  trend: "cat-trend",
  momentum: "cat-momentum",
  reversal: "cat-reversal",
  breakout: "cat-breakout",
  scalp: "cat-scalp",
};

function dp(v) {
  const a = Math.abs(v ?? 0);
  return a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : 5;
}
const fmt = (v, d) =>
  v == null || isNaN(v)
    ? "—"
    : Number(v).toLocaleString("en-US", { maximumFractionDigits: d ?? dp(v), minimumFractionDigits: 0 });

function fmtTime(unix, intraday, lang) {
  try {
    return new Date(unix * 1000).toLocaleString(lang === "fa" ? "fa-IR" : "en-US", {
      month: "short",
      day: "numeric",
      ...(intraday ? { hour: "2-digit", minute: "2-digit" } : {}),
    });
  } catch {
    return String(unix);
  }
}

// MT5-style contract sizes for the lot calculator.
function contractSizeFor(ticker) {
  if (ticker === "SI=F") return 5000; // XAGUSD: 5000 oz per lot
  if (/=F$/.test(ticker)) return 100; // XAU/XPT/XPD: 100 oz per lot
  if (/=X$/.test(ticker)) return 100000; // forex standard lot
  return 1; // stocks, crypto, ETFs
}

function loadCalc() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CALC));
    if (c && typeof c === "object") return { balance: c.balance ?? 10000, riskPct: c.riskPct ?? 1 };
  } catch { /* defaults */ }
  return { balance: 10000, riskPct: 1 };
}

const DIR_CLS = { BUY: "buy", SELL: "sell", WAIT: "hold" };
const DIR_FA = { BUY: "خرید", SELL: "فروش" };

/** Cumulative-R equity sparkline for the backtest results. */
function EquityCurve({ results }) {
  const closed = results.filter((x) => x.r != null);
  if (closed.length < 2) return null;
  let sum = 0;
  const pts = [0, ...closed.map((x) => (sum += x.r))];
  const min = Math.min(0, ...pts);
  const max = Math.max(0, ...pts);
  const H = 64, W = 100;
  const y = (v) => H - ((v - min) / Math.max(max - min, 1e-9)) * (H - 8) - 4;
  const x = (i) => (i / (pts.length - 1)) * W;
  const path = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const final = pts[pts.length - 1];
  const color = final >= 0 ? "#2fd67b" : "#ff5d6c";
  return (
    <div className="equity" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="rgba(143,161,194,0.35)" strokeDasharray="2 2" strokeWidth="0.5" />
        <path d={path} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="equity-final" style={{ color }}>
        {final >= 0 ? "+" : ""}{final.toFixed(1)}R
      </span>
    </div>
  );
}

export default function PlanPanel({ ticker, t, lang, onShowOnChart }) {
  const P = t.plan;
  const [stratId, setStratId] = useState(() => {
    const q = new URLSearchParams(location.search).get("strategy");
    if (STRATEGIES.some((s) => s.id === q)) return q;
    const saved = localStorage.getItem(LS_STRAT);
    return STRATEGIES.some((s) => s.id === saved) ? saved : null;
  });
  const strat = STRATEGIES.find((s) => s.id === stratId) || null;
  const [cat, setCat] = useState("all");
  // Default timeframe: 1m (scalping-first) unless the saved strategy says otherwise.
  const [tf, setTf] = useState(strat?.defaultTf || "1m");
  const [bars, setBars] = useState(null);
  const [error, setError] = useState(null);
  const [spotInfo, setSpotInfo] = useState(null);
  const [checks, setChecks] = useState(() => P.checklist.map(() => false));
  const [calc, setCalc] = useState(loadCalc);
  const [copied, setCopied] = useState(false);
  const [chartMsg, setChartMsg] = useState(false);

  useEffect(() => {
    if (stratId) localStorage.setItem(LS_STRAT, stratId);
    else localStorage.removeItem(LS_STRAT);
  }, [stratId]);
  useEffect(() => localStorage.setItem(LS_CALC, JSON.stringify(calc)), [calc]);

  const pickStrategy = (id) => {
    const s = STRATEGIES.find((x) => x.id === id);
    setStratId(id);
    setChecks(P.checklist.map(() => false));
    setCopied(false);
    if (s && !s.tfs.includes(tf)) setTf(s.defaultTf);
  };

  // ---- data fetch + polling ----
  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    const [range, poll] = TF_FETCH[tf] || ["1y", null];
    const load = () => {
      fetch(`/api/chart?ticker=${encodeURIComponent(ticker)}&range=${range}&interval=${tf}`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          if (data.error || !data.bars?.length) setError(data.error || "no data");
          else {
            setError(null);
            setBars(data.bars);
          }
        })
        .catch((e) => !cancelled && setError(String(e)));
      fetch(`/api/spot?ticker=${encodeURIComponent(ticker)}`)
        .then((r) => r.json())
        .then((d) => !cancelled && setSpotInfo(d.pair ? d : null))
        .catch(() => {});
    };
    setBars(null);
    setError(null);
    load();
    const timer = poll ? setInterval(load, poll) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [ticker, tf]);

  const intraday = INTRADAY.has(tf);
  const analysis = useMemo(
    () => (strat && bars ? analyze(strat.id, bars, intraday) : null),
    [strat, bars, intraday],
  );
  // Leaderboard: every compatible strategy ranked by backtest expectancy.
  const scan = useMemo(() => {
    if (!bars) return [];
    const rows = scanAll(bars, intraday, tf);
    const score = (x) =>
      x.a && !x.a.error && x.a.bt?.stats?.avgR != null && x.a.bt.stats.closed >= 1
        ? x.a.bt.stats.avgR
        : -Infinity;
    return rows.sort((p, q) => score(q) - score(p));
  }, [bars, intraday, tf]);
  const bestId = scan.find(
    (x) => x.a && !x.a.error && (x.a.bt?.stats?.closed ?? 0) >= 3 && x.a.bt.stats.avgR > 0,
  )?.id;

  // Fresh strategy signal while the tab is open → beep + notification.
  const lastNotified = useRef(null);
  useEffect(() => {
    if (!analysis || analysis.error || analysis.signal === "WAIT" || !analysis.last) return;
    const key = `${strat?.id}:${ticker}:${tf}:${analysis.last.time}:${analysis.last.dir}`;
    if (lastNotified.current === null) {
      lastNotified.current = key; // ignore whatever is fresh on first load
      return;
    }
    if (lastNotified.current !== key) {
      lastNotified.current = key;
      beep(660);
      notify("TradingAgents", `${analysis.last.dir} · ${ticker} · ${tf}`);
    }
  }, [analysis, strat, ticker, tf]);

  const meta = strat?.meta[lang === "fa" ? "fa" : "en"];
  const last = analysis?.last || null;
  const sigDir = analysis?.signal || "WAIT";
  const rr = last ? Math.abs(last.tp2 - last.entry) / Math.max(Math.abs(last.entry - last.sl), 1e-9) : null;
  const lastClose = bars?.[bars.length - 1]?.close;
  const spread = spotInfo?.spot != null && lastClose != null ? lastClose - spotInfo.spot : null;

  // ---- position calculator ----
  const cSize = contractSizeFor(ticker);
  const riskAmount = (calc.balance * calc.riskPct) / 100;
  const slDist = last ? Math.abs(last.entry - last.sl) : null;
  const units = slDist ? riskAmount / slDist : null;
  const lots = units != null ? units / cSize : null;

  const copySignal = () => {
    if (!last || !meta) return;
    const d = dp(last.entry);
    const lines = [
      `${ticker} — ${meta.name} (${tf})`,
      `${last.dir} @ ${last.entry.toFixed(d)}`,
      `SL ${last.sl.toFixed(d)} · TP1 ${last.tp1.toFixed(d)} · TP2 ${last.tp2.toFixed(d)} · RR ${rr?.toFixed(1)}`,
      ...(spread != null
        ? [`${spotInfo.pair}: entry ${(last.entry - spread).toFixed(2)} SL ${(last.sl - spread).toFixed(2)} TP1 ${(last.tp1 - spread).toFixed(2)} TP2 ${(last.tp2 - spread).toFixed(2)}`]
        : []),
      new Date().toISOString().slice(0, 16).replace("T", " "),
    ];
    navigator.clipboard?.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const levelRows = last
    ? [
        { label: t.entry, value: last.entry, cls: "entry" },
        { label: t.stopLoss, value: last.sl, cls: "sl" },
        { label: t.tp1, value: last.tp1, cls: "tp" },
        { label: t.tp2, value: last.tp2, cls: "tp" },
        { label: t.rr, value: rr, cls: "rr", decimals: 1 },
      ]
    : [];

  const cards = STRATEGIES.filter((s) => cat === "all" || s.category === cat);

  return (
    <div className="plan">
      {/* ---------- strategy picker ---------- */}
      <div className="panel panel-pad">
        <h3>{P.title}</h3>
        <div className="sub">{P.sub}</div>

        <div className="chips" style={{ marginBottom: 14 }}>
          <button className={`chip sm ${cat === "all" ? "on" : ""}`} onClick={() => setCat("all")}>
            {P.all}
          </button>
          {CATEGORIES.map((c) => (
            <button key={c} className={`chip sm ${cat === c ? "on" : ""}`} onClick={() => setCat(c)}>
              {P.categories[c]}
            </button>
          ))}
        </div>

        <div className="strat-grid">
          {cards.map((s) => {
            const m = s.meta[lang === "fa" ? "fa" : "en"];
            const onCard = s.id === stratId;
            return (
              <motion.button
                key={s.id}
                className={`strat-card ${onCard ? "on" : ""}`}
                onClick={() => pickStrategy(onCard ? null : s.id)}
                whileHover={{ y: -3 }}
                whileTap={{ scale: 0.985 }}
                layout
              >
                <div className="sc-head">
                  <span className="sc-icon">{s.icon}</span>
                  <span className={`badge ${CAT_CLS[s.category]}`}>{P.categories[s.category]}</span>
                  <span className={`badge risk-${s.risk}`}>{P.riskLabel}: {P.risks[s.risk]}</span>
                </div>
                <div className="sc-name">{m.name}</div>
                <div className="sc-tag">{m.tagline}</div>
                <div className="sc-tfs" dir="ltr">
                  {s.tfs.map((x) => (
                    <span key={x}>{t.timeframes[x] || x}</span>
                  ))}
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* ---------- selected strategy ---------- */}
      <AnimatePresence mode="wait">
        {strat && meta && (
          <motion.div
            key={strat.id}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
          >
            {/* about */}
            <div className="panel panel-pad plan-sect">
              <h3>
                {strat.icon} {meta.name}
              </h3>
              <div className="sub">{meta.tagline}</div>
              <p className="plan-desc">{meta.desc}</p>
              <div className="plan-best">
                <b>{P.bestFor}:</b> {meta.best}
              </div>
              <div className="plan-cols">
                <div>
                  <div className="plan-h">{P.rulesTitle}</div>
                  <ul className="plan-list rules">
                    {meta.rules.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="plan-h">{P.tipsTitle}</div>
                  <ul className="plan-list tips">
                    {meta.tips.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            {/* live signal */}
            <div className="panel panel-pad plan-sect">
              <div className="plan-sig-head">
                <div>
                  <h3>{P.liveSignal}</h3>
                  <div className="sub" dir="ltr" style={{ marginBottom: 0 }}>
                    {ticker} · {tf}
                  </div>
                </div>
                <div className="chips" role="group" aria-label={P.timeframe}>
                  {strat.tfs.map((x) => (
                    <button key={x} className={`chip sm ${tf === x ? "on" : ""}`} onClick={() => setTf(x)}>
                      {t.timeframes[x] || x}
                    </button>
                  ))}
                </div>
              </div>

              {error && <div className="error-banner">{String(error)}</div>}
              {!error && !bars && <div className="plan-loading">⏳</div>}

              {analysis?.error === "notEnoughBars" && (
                <div className="hint" style={{ fontSize: 13, padding: "20px 0" }}>
                  {P.notEnoughBars.replace("{need}", analysis.need).replace("{have}", analysis.have)}
                </div>
              )}

              {analysis && !analysis.error && (
                <>
                  <div className="verdict" style={{ marginTop: 6 }}>
                    <motion.div
                      key={sigDir + (last?.time ?? "")}
                      className={`verdict-badge ${DIR_CLS[sigDir]}`}
                      initial={{ scale: 0.7, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 240, damping: 15 }}
                    >
                      {sigDir === "WAIT" ? P.dirWait : sigDir}
                      {lang === "fa" && sigDir !== "WAIT" && (
                        <span style={{ fontFamily: "var(--font-fa)", fontSize: 15, fontWeight: 700, marginInlineStart: 10 }}>
                          {DIR_FA[sigDir]}
                        </span>
                      )}
                    </motion.div>
                    <div className="sig-meta">
                      {last ? (
                        <>
                          <span className={`sig-fresh ${sigDir !== "WAIT" ? "on" : ""}`}>
                            {sigDir !== "WAIT" ? `⚡ ${P.freshSignal}` : P.waitDesc}
                          </span>
                          <span dir="ltr">
                            {last.dir} · {fmtTime(last.time, intraday, lang)} ·{" "}
                            {analysis.barsSince === 0 ? P.justNow : P.barsAgo.replace("{n}", analysis.barsSince)}
                          </span>
                        </>
                      ) : (
                        <span>{P.noSignalYet}</span>
                      )}
                    </div>
                  </div>

                  {analysis.strength != null && (
                    <div className="strength">
                      <div className="strength-label">
                        {P.strength}
                        <b>{analysis.strength}%</b>
                      </div>
                      <div className="strength-bar">
                        <motion.i
                          initial={{ width: 0 }}
                          animate={{ width: `${analysis.strength}%` }}
                          transition={{ type: "spring", stiffness: 60, damping: 18 }}
                          style={{
                            background:
                              analysis.strength >= 65
                                ? "linear-gradient(90deg,#2fd67b,#7ddf9a)"
                                : analysis.strength >= 40
                                  ? "linear-gradient(90deg,#e8b64c,#ffd76e)"
                                  : "linear-gradient(90deg,#ff5d6c,#ff9aa4)",
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {analysis.state?.reasons?.length > 0 && (
                    <ul className="plan-list reasons">
                      {analysis.state.reasons.map((x, i) => (
                        <li key={i}>{lang === "fa" ? x.fa : x.en}</li>
                      ))}
                    </ul>
                  )}

                  {last && (
                    <>
                      <div className="plan-h" style={{ marginTop: 16 }}>{P.levels}</div>
                      <div className="levels" style={{ marginTop: 8 }}>
                        {levelRows.map((lv) => (
                          <div key={lv.label} className={`level ${lv.cls}`}>
                            <div className="k">{lv.label}</div>
                            <div className="v">
                              <AnimatedNumber value={lv.value} decimals={lv.decimals ?? dp(lv.value)} />
                            </div>
                          </div>
                        ))}
                      </div>

                      {spread != null && (
                        <div className="spot-levels">
                          <div className="spot-title">
                            {t.spotLevels.replace("{pair}", spotInfo.pair)}
                            <span className="spot-spread" dir="ltr">
                              {t.spread}: {spread.toFixed(2)}
                            </span>
                          </div>
                          <div className="levels">
                            {[
                              { label: t.entry, value: last.entry - spread, cls: "entry" },
                              { label: t.stopLoss, value: last.sl - spread, cls: "sl" },
                              { label: t.tp1, value: last.tp1 - spread, cls: "tp" },
                              { label: t.tp2, value: last.tp2 - spread, cls: "tp" },
                            ].map((x) => (
                              <div key={x.label} className={`level ${x.cls}`}>
                                <div className="k">{x.label}</div>
                                <div className="v">
                                  <AnimatedNumber value={x.value} decimals={2} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="plan-actions">
                        <button className="rtab on" onClick={copySignal}>
                          {copied ? P.copied : P.copy}
                        </button>
                        <button
                          className="rtab"
                          onClick={() => {
                            onShowOnChart?.(strat.id);
                            setChartMsg(true);
                            setTimeout(() => setChartMsg(false), 2500);
                          }}
                        >
                          {P.showOnChart}
                        </button>
                        {chartMsg && <span className="hint">{P.onChartOn}</span>}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            <div className="plan-row2">
              {/* checklist */}
              <div className="panel panel-pad plan-sect">
                <h3>{P.checklistTitle}</h3>
                <div className="sub">
                  {checks.filter(Boolean).length}/{checks.length}
                </div>
                <div className="checklist">
                  {P.checklist.map((c, i) => (
                    <label key={i} className={`check-item ${checks[i] ? "ok" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checks[i]}
                        onChange={() =>
                          setChecks((prev) => prev.map((v, j) => (j === i ? !v : v)))
                        }
                      />
                      <span className="box">{checks[i] ? "✓" : ""}</span>
                      {c}
                    </label>
                  ))}
                </div>
              </div>

              {/* position calculator */}
              <div className="panel panel-pad plan-sect">
                <h3>{P.calcTitle}</h3>
                <div className="sub">{P.calcSub}</div>
                <div className="row2">
                  <div className="field">
                    <label>{P.balance}</label>
                    <input
                      type="number"
                      min="0"
                      value={calc.balance}
                      dir="ltr"
                      onChange={(e) => setCalc((c) => ({ ...c, balance: Number(e.target.value) }))}
                    />
                  </div>
                  <div className="field">
                    <label>{P.riskPct}</label>
                    <input
                      type="number"
                      min="0.1"
                      max="100"
                      step="0.25"
                      value={calc.riskPct}
                      dir="ltr"
                      onChange={(e) => setCalc((c) => ({ ...c, riskPct: Number(e.target.value) }))}
                    />
                  </div>
                </div>
                <div className="levels" style={{ marginTop: 4 }}>
                  <div className="level">
                    <div className="k">{P.riskAmount}</div>
                    <div className="v">${fmt(riskAmount, 0)}</div>
                  </div>
                  <div className="level">
                    <div className="k">{P.contractSize}</div>
                    <div className="v">{fmt(cSize, 0)}</div>
                  </div>
                  <div className="level entry">
                    <div className="k">{P.units}</div>
                    <div className="v">{units != null ? fmt(units, units < 10 ? 3 : 1) : "—"}</div>
                  </div>
                  <div className="level rr">
                    <div className="k">{P.lots}</div>
                    <div className="v">{lots != null ? fmt(lots, lots < 1 ? 3 : 2) : "—"}</div>
                  </div>
                </div>
                <div className="hint" style={{ marginTop: 8 }}>{P.calcNote}</div>
              </div>
            </div>

            {/* backtest */}
            {analysis && !analysis.error && analysis.bt?.stats?.signals > 0 && (
              <div className="panel panel-pad plan-sect">
                <h3>{P.backtestTitle}</h3>
                <div className="sub">{P.backtestSub}</div>
                <div className="levels">
                  <div className="level">
                    <div className="k">{P.btSignals}</div>
                    <div className="v">{analysis.bt.stats.signals}</div>
                  </div>
                  <div className="level entry">
                    <div className="k">{P.btWinRate}</div>
                    <div className="v">
                      {analysis.bt.stats.winRate != null ? `${analysis.bt.stats.winRate.toFixed(0)}%` : "—"}
                    </div>
                  </div>
                  <div className={`level ${analysis.bt.stats.avgR > 0 ? "tp" : "sl"}`}>
                    <div className="k">{P.btAvgR}</div>
                    <div className="v">
                      {analysis.bt.stats.avgR != null ? analysis.bt.stats.avgR.toFixed(2) : "—"}
                    </div>
                  </div>
                  <div className="level rr">
                    <div className="k">{P.btPF}</div>
                    <div className="v">
                      {analysis.bt.stats.profitFactor == null
                        ? "—"
                        : analysis.bt.stats.profitFactor === Infinity
                          ? "∞"
                          : analysis.bt.stats.profitFactor.toFixed(2)}
                    </div>
                  </div>
                  <div className="level">
                    <div className="k">{P.btOpen}</div>
                    <div className="v">{analysis.bt.stats.open}</div>
                  </div>
                </div>

                <EquityCurve results={analysis.bt.results} />

                <div className="plan-h" style={{ marginTop: 18 }}>{P.recentSignals}</div>
                <div className="scan-wrap">
                  <table className="scan-table" dir="ltr">
                    <tbody>
                      {analysis.bt.results
                        .slice(-8)
                        .reverse()
                        .map((x) => (
                          <tr key={x.time + x.dir}>
                            <td>{fmtTime(x.time, intraday, lang)}</td>
                            <td>
                              <span className={`vbadge ${x.dir === "BUY" ? "up" : "down"}`}>{x.dir}</span>
                            </td>
                            <td className="mono">{fmt(x.entry)}</td>
                            <td>
                              <span
                                className={`vbadge ${
                                  x.outcome === "sl" ? "down" : x.outcome === "open" ? "mid" : "up"
                                }`}
                              >
                                {P.outcome[x.outcome]}
                              </span>
                            </td>
                            <td className="mono">{x.r != null ? `${x.r > 0 ? "+" : ""}${x.r.toFixed(1)}R` : ""}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <div className="hint" style={{ marginTop: 10 }}>⚠ {P.btDisclaimer}</div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------- multi-timeframe confluence ---------- */}
      <MTFStrip ticker={ticker} t={t} />

      {/* ---------- strategy leaderboard ---------- */}
      {bars && scan.length > 0 && (
        <div className="panel panel-pad plan-sect">
          <h3>{P.scannerTitle}</h3>
          <div className="sub">{P.scannerSub.replace("{ticker}", ticker)}</div>
          <div className="scan-wrap">
            <table className="scan-table">
              <thead>
                <tr className="scan-head">
                  <th>{P.lbStrategy}</th>
                  <th>{P.scanSignal}</th>
                  <th>{P.scanLast}</th>
                  <th>{P.scanStrength}</th>
                  <th>{P.lbTrades}</th>
                  <th>{P.lbWinRate}</th>
                  <th>{P.lbAvgR}</th>
                  <th>{P.lbPF}</th>
                </tr>
              </thead>
              <tbody>
                {scan.map(({ id, icon, a }) => {
                  const m = STRATEGIES.find((s) => s.id === id).meta[lang === "fa" ? "fa" : "en"];
                  const sig = a && !a.error ? a.signal : null;
                  const st = a && !a.error ? a.bt?.stats : null;
                  return (
                    <tr
                      key={id}
                      className={`scan-row ${id === stratId ? "on" : ""}`}
                      onClick={() => pickStrategy(id)}
                    >
                      <td className="scan-name">
                        {id === bestId && <span title={P.lbBest}>🏆 </span>}
                        {icon} {m.name}
                      </td>
                      <td>
                        {a?.error ? (
                          <span className="vbadge mid">{P.scanNone}</span>
                        ) : (
                          <span className={`vbadge ${sig === "BUY" ? "up" : sig === "SELL" ? "down" : "mid"}`}>
                            {sig === "WAIT" ? P.dirWait : sig}
                          </span>
                        )}
                      </td>
                      <td className="scan-last" dir="ltr">
                        {a?.last
                          ? `${a.last.dir} · ${a.barsSince === 0 ? P.justNow : P.barsAgo.replace("{n}", a.barsSince)}`
                          : P.scanNone}
                      </td>
                      <td className="mono">{a?.strength != null ? `${a.strength}%` : ""}</td>
                      <td className="mono">{st ? st.closed : ""}</td>
                      <td className="mono" style={{ color: st?.winRate >= 50 ? "var(--green)" : st?.winRate != null ? "var(--red)" : undefined }}>
                        {st?.winRate != null ? `${st.winRate.toFixed(0)}%` : ""}
                      </td>
                      <td className="mono" style={{ color: st?.avgR > 0 ? "var(--green)" : st?.avgR != null ? "var(--red)" : undefined }}>
                        {st?.avgR != null ? st.avgR.toFixed(2) : ""}
                      </td>
                      <td className="mono">
                        {st?.profitFactor == null ? "" : st.profitFactor === Infinity ? "∞" : st.profitFactor.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>{P.lbHint}</div>
        </div>
      )}
    </div>
  );
}
