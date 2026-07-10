import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { STRATEGIES, CATEGORIES, scanAll, consensus } from "../strategies.js";
import AnimatedNumber from "./AnimatedNumber.jsx";
import MTFStrip from "./MTFStrip.jsx";
import PositionsPanel from "./PositionsPanel.jsx";
import JournalPanel from "./JournalPanel.jsx";
import ScannerPanel from "./ScannerPanel.jsx";
import ArmPanel from "./ArmPanel.jsx";
import CalibrationPanel from "./CalibrationPanel.jsx";
import ReplayPanel from "./ReplayPanel.jsx";
import { loadTape } from "./TickerTape.jsx";
import TradeTicket, { mt5Symbol } from "./TradeTicket.jsx";
import AutoTrade from "./AutoTrade.jsx";
import { beep, notify, useLiveQuote, useMt5Status } from "../utils.js";
import { useStrategyLive } from "../livesignal.js";

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

export default function PlanPanel({ ticker, t, lang, onShowOnChart, onPickSymbol, aiSignal,
                                    strategyId, onStrategyChange }) {
  const P = t.plan;
  // Selection is owned by App (shared with the chart) — one strategy app-wide.
  const stratId = strategyId ?? null;
  const strat = STRATEGIES.find((s) => s.id === stratId) || null;
  const [cat, setCat] = useState("all");
  const [spotInfo, setSpotInfo] = useState(null);
  const [checks, setChecks] = useState(() => P.checklist.map(() => false));
  const [calc, setCalc] = useState(loadCalc);
  const [copied, setCopied] = useState(false);
  const [chartMsg, setChartMsg] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [tgState, setTgState] = useState(null); // null | "sending" | "ok" | "fail"

  useEffect(() => localStorage.setItem(LS_CALC, JSON.stringify(calc)), [calc]);

  const pickStrategy = (id) => {
    onStrategyChange?.(id);
    setChecks(P.checklist.map(() => false));
    setCopied(false);
  };

  // ---- THE live signal: the exact same hook the chart banner uses (shared
  // timeframe, shared bar feed — broker candles + tick when MetaTrader is
  // open, yfinance otherwise), so Plan and Chart can never disagree. ----
  const live = useStrategyLive(ticker, stratId);
  const { tf, setTf, intraday, bars, analysis } = live;
  const mt5Active = live.source === "mt5";
  const error = live.error;

  // Futures ↔ spot spread (yfinance mode only — the broker feed IS the pair).
  useEffect(() => {
    if (!ticker || mt5Active) {
      setSpotInfo(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      fetch(`/api/spot?ticker=${encodeURIComponent(ticker)}`)
        .then((r) => r.json())
        .then((d) => !cancelled && setSpotInfo(d.pair ? d : null))
        .catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ticker, mt5Active]);

  // Leaderboard: every compatible strategy ranked by backtest expectancy.
  // Scanning ~12 strategies + backtests is too heavy for the 7 Hz stream, so
  // throttle the forming-bar refresh to ~1 s (instant on a new closed bar).
  const [scanSlow, setScanSlow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setScanSlow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const lastLive = bars?.[bars.length - 1];
  const scanKey = bars ? `${bars.length}:${lastLive?.time}:${tf}:${intraday}:${scanSlow}` : "";
  const scan = useMemo(() => {
    if (!bars) return [];
    const rows = scanAll(bars, intraday, tf);
    const score = (x) =>
      x.a && !x.a.error && x.a.bt?.stats?.avgR != null && x.a.bt.stats.closed >= 1
        ? x.a.bt.stats.avgR
        : -Infinity;
    return rows.sort((p, q) => score(q) - score(p));
  }, [scanKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const bestId = scan.find(
    (x) => x.a && !x.a.error && (x.a.bt?.stats?.closed ?? 0) >= 3 && x.a.bt.stats.avgR > 0,
  )?.id;

  // Fresh strategy signal while the tab is open → beep + notification.
  const lastNotified = useRef(null);
  const notifyCtx = useRef(null);
  useEffect(() => {
    if (!analysis || analysis.error || analysis.signal === "WAIT" || !analysis.last) return;
    const ctx = `${strat?.id}:${ticker}:${tf}`;
    const sig = `${analysis.last.time}:${analysis.last.dir}`;
    // Switching symbol/timeframe/strategy is not a new signal — re-seed silently
    // and only beep when a genuinely fresh signal forms within the same context.
    if (notifyCtx.current !== ctx) {
      notifyCtx.current = ctx;
      lastNotified.current = sig;
      return;
    }
    if (lastNotified.current !== sig) {
      lastNotified.current = sig;
      beep(660);
      notify("TradingAgents", `${analysis.last.dir} · ${ticker} · ${tf}`);
    }
  }, [analysis, strat, ticker, tf]);

  const meta = strat?.meta[lang === "fa" ? "fa" : "en"];
  const last = analysis?.last || null;
  const sigDir = analysis?.signal || "WAIT";
  const rr = last ? Math.abs(last.tp2 - last.entry) / Math.max(Math.abs(last.entry - last.sl), 1e-9) : null;
  // Near-real-time quote: live price, futures↔spot spread and distance-to-entry,
  // refreshed every ~2.5s between the slower candle polls.
  const liveQuote = useLiveQuote(mt5Active ? null : ticker);
  const barClose = bars?.[bars.length - 1]?.close;
  // On the broker feed the live price is the BID (matches MetaTrader's own
  // bid-based candles exactly), the symbol is the broker's own, and there is no
  // futures/spot basis to shift (spread = null → levels used as-is). Off it,
  // the previous yfinance/gold-api blend applies.
  const lastClose = mt5Active
    ? live.tick?.bid ?? live.tick?.mid ?? barClose
    : liveQuote?.price ?? barClose;
  const pair = mt5Active ? live.display : spotInfo?.pair || liveQuote?.pair || null;
  const spread = mt5Active
    ? null
    : pair && liveQuote?.price != null && liveQuote?.spot != null
      ? liveQuote.price - liveQuote.spot
      : pair && spotInfo?.spot != null && barClose != null
        ? barClose - spotInfo.spot
        : null;
  const toEntry = last && lastClose != null ? lastClose - last.entry : null;
  const toEntryPct =
    last && lastClose != null && last.entry ? ((lastClose - last.entry) / last.entry) * 100 : null;
  // Consensus: AI signal + this strategy + the technical rating in one number.
  const cons =
    analysis && !analysis.error
      ? consensus({
          aiDir: aiSignal?.direction ? String(aiSignal.direction).toUpperCase() : null,
          stratDir: sigDir,
          stratStrength: analysis.strength,
          ratingScore: analysis.rating?.score,
        })
      : null;

  // ---- position calculator ----
  // Live account equity (when MT5 is connected) replaces the manual balance
  // field automatically — no more typing a number that's already stale the
  // moment a trade closes. `balanceManual` is an explicit opt-out for
  // what-if planning (e.g. sizing against a hypothetical balance).
  const mt5s = useMt5Status();
  const liveEquity = mt5s?.account?.equity ?? null;
  const [balanceManual, setBalanceManual] = useState(false);
  const effBalance = !balanceManual && liveEquity != null ? liveEquity : calc.balance;

  const cSize = contractSizeFor(ticker);
  const riskAmount = (effBalance * calc.riskPct) / 100;
  const slDist = last ? Math.abs(last.entry - last.sl) : null;
  const units = slDist ? riskAmount / slDist : null;
  const lots = units != null ? units / cSize : null;

  const signalText = () => {
    if (!last || !meta) return null;
    const d = dp(last.entry);
    return [
      `${ticker} — ${meta.name} (${tf})`,
      `${last.dir} @ ${last.entry.toFixed(d)}`,
      `SL ${last.sl.toFixed(d)} · TP1 ${last.tp1.toFixed(d)} · TP2 ${last.tp2.toFixed(d)} · RR ${rr?.toFixed(1)}`,
      ...(spread != null && pair
        ? [`${pair}: entry ${(last.entry - spread).toFixed(2)} SL ${(last.sl - spread).toFixed(2)} TP1 ${(last.tp1 - spread).toFixed(2)} TP2 ${(last.tp2 - spread).toFixed(2)}`]
        : []),
      new Date().toISOString().slice(0, 16).replace("T", " "),
    ].join("\n");
  };

  const copySignal = () => {
    const text = signalText();
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const telegramSignal = async () => {
    const text = signalText();
    if (!text || tgState === "sending") return;
    setTgState("sending");
    try {
      const r = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `🎯 ${text}` }),
      });
      const d = await r.json();
      setTgState(d.ok ? "ok" : "fail");
    } catch {
      setTgState("fail");
    }
    setTimeout(() => setTgState(null), 2500);
  };

  // Levels the trade ticket should send: spot-adjusted when the futures↔spot
  // spread is known (MT5 brokers quote spot), raw chart levels otherwise.
  const tradeSymbol = pair || mt5Symbol(ticker);
  const adj = (v) => (spread != null ? v - spread : v);

  // Broker-truth sizing: ask MT5 what this exact SL actually costs per lot for
  // this exact symbol (real tick value/contract size), instead of the guessed
  // contractSizeFor() above. Only available while connected and a fresh signal
  // exists to size against.
  const [brokerCalc, setBrokerCalc] = useState(null);
  const bcKey = last ? `${tradeSymbol}:${Math.round(last.entry * 100)}:${Math.round(last.sl * 100)}` : null;
  useEffect(() => {
    if (!mt5Active || !last || !tradeSymbol) {
      setBrokerCalc(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch("/api/mt5/symbol_info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: tradeSymbol, entry: adj(last.entry), sl: adj(last.sl),
          risk_pct: calc.riskPct,
        }),
      })
        .then((r) => r.json())
        .then((d) => !cancelled && setBrokerCalc(d?.ok ? d : null))
        .catch(() => !cancelled && setBrokerCalc(null));
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [mt5Active, bcKey, calc.riskPct]); // eslint-disable-line react-hooks/exhaustive-deps

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

      {/* ---------- A+ watchlist scanner ---------- */}
      <ScannerPanel
        t={t}
        lang={lang}
        watchlist={loadTape()}
        onPick={(sym, stratId) => {
          onPickSymbol?.(sym);
          pickStrategy(stratId);
        }}
      />

      {/* ---------- open positions (live account) ---------- */}
      <PositionsPanel t={t} />

      {/* ---------- auto-execution: armed strategies + shadow journal ---------- */}
      <ArmPanel t={t} lang={lang} defaultTicker={pair || ticker} />

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
                  <div className="sub" dir="ltr" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{mt5Active ? live.display : ticker} · {tf}</span>
                    <span
                      className={`src-chip ${mt5Active ? "mt5" : "yahoo"}`}
                      title={mt5Active ? t.srcMt5Note : ""}
                    >
                      {mt5Active ? `🔌 ${t.srcMt5}` : `☁ ${t.srcYahoo}`}
                    </span>
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
                          {aiSignal?.direction && last.dir === String(aiSignal.direction).toUpperCase() && (
                            <span className="conf-badge">{P.aligned}</span>
                          )}
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

                  {last && lastClose != null && (
                    <div
                      dir="ltr"
                      style={{ display: "flex", alignItems: "center", gap: 12, margin: "10px 0", fontFamily: "var(--font-mono)", flexWrap: "wrap" }}
                    >
                      <span style={{ fontSize: 20, fontWeight: 700 }}>{fmt(lastClose, dp(lastClose))}</span>
                      <span className={toEntry >= 0 ? "up" : "down"} style={{ fontSize: 13 }}>
                        {P.priceVsEntry} {toEntry >= 0 ? "+" : ""}
                        {fmt(toEntry, dp(lastClose))}
                        {toEntryPct != null ? ` (${toEntryPct >= 0 ? "+" : ""}${toEntryPct.toFixed(2)}%)` : ""}
                      </span>
                      <span className="live-badge"><i />{t.live}</span>
                    </div>
                  )}

                  {cons && (
                    <div dir="ltr" style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0", flexWrap: "wrap" }}>
                      <span className={`verdict-badge sm ${cons.dir === "BUY" ? "buy" : cons.dir === "SELL" ? "sell" : "hold"}`}>
                        {cons.dir === "HOLD" ? P.dirWait : cons.dir}
                      </span>
                      <span className="hint">
                        {P.consensus}: <b>{cons.score}%</b> · {cons.agree}/{cons.total} {P.sourcesAgree}
                      </span>
                    </div>
                  )}

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

                  {sigDir === "WAIT" && last && (
                    // Neutral = no tradable levels, full stop. The last event
                    // stays visible above as history; entries/SL/TP and every
                    // trade button only exist while the signal is FRESH.
                    <div className="hint" style={{ margin: "12px 0", padding: "10px 12px",
                                                   border: "1px dashed var(--border)", borderRadius: 10 }}>
                      ⏸ {P.waitNoTrade}
                    </div>
                  )}

                  {sigDir !== "WAIT" && last && (
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
                            {t.spotLevels.replace("{pair}", pair)}
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
                        <button
                          className="rtab trade-btn on"
                          onClick={() => setTicketOpen(true)}
                        >
                          {P.trade}
                        </button>
                        <button className="rtab on" onClick={copySignal}>
                          {copied ? P.copied : P.copy}
                        </button>
                        <button className="rtab" onClick={telegramSignal} disabled={tgState === "sending"}>
                          {tgState === "ok" ? P.tgSent : tgState === "fail" ? P.tgFail : P.sendTg}
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

                      <TradeTicket
                        open={ticketOpen}
                        onClose={() => setTicketOpen(false)}
                        symbol={tradeSymbol}
                        dir={last.dir}
                        entry={adj(last.entry)}
                        sl={adj(last.sl)}
                        tp1={adj(last.tp1)}
                        tp2={adj(last.tp2)}
                        comment={`TA:${strat.id}`.slice(0, 26)}
                        t={t}
                      />

                      {/* One-click auto-trade for this strategy's live signal —
                          separate from the manual ⚡ ticket above and from the
                          rating's auto-trade under the chart. Fresh signals
                          only (this whole block is WAIT-gated). */}
                      <AutoTrade
                        t={t}
                        ticker={ticker}
                        levels={{ dir: last.dir, entry: last.entry, sl: last.sl, tp1: last.tp1, tp2: last.tp2 }}
                        spotInfo={mt5Active ? { pair: live.display } : spotInfo}
                        spread={spread}
                        label={`${strat.icon} ${meta.name}`}
                        tag={strat.id}
                      />
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
                    <label>
                      {P.balance}
                      {liveEquity != null && (
                        <button
                          type="button"
                          className="calc-src-toggle"
                          onClick={() => setBalanceManual((v) => !v)}
                          title={balanceManual ? P.balanceUseAuto : P.balanceUseManual}
                        >
                          {balanceManual ? `✎ ${P.manual}` : `🔌 ${P.autoAcct}`}
                        </button>
                      )}
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={balanceManual || liveEquity == null ? calc.balance : Math.round(liveEquity * 100) / 100}
                      dir="ltr"
                      disabled={!balanceManual && liveEquity != null}
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

                {/* Broker-truth sizing — the real number from MT5's own tick
                    value, replacing the guessed contract size above. Only
                    shown when it's actually available (connected + a fresh
                    signal to size against). */}
                {brokerCalc && (
                  <div className="calc-broker">
                    <div className="calc-broker-title">🔌 {P.calcBrokerTitle}</div>
                    <div className="levels" style={{ marginTop: 6 }}>
                      <div className="level">
                        <div className="k">{P.riskAmount}</div>
                        <div className="v">${fmt(brokerCalc.risk_money ?? riskAmount, 2)}</div>
                      </div>
                      <div className="level">
                        <div className="k">{P.calcRiskPerLot}</div>
                        <div className="v">${fmt(brokerCalc.risk_per_lot, 2)}</div>
                      </div>
                      <div className="level rr">
                        <div className="k">{P.lots}</div>
                        <div className="v">{brokerCalc.suggested_lot != null ? fmt(brokerCalc.suggested_lot, 2) : "—"}</div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="hint" style={{ marginTop: 8 }}>
                  {liveEquity != null && !balanceManual ? P.calcNoteAuto : P.calcNote}
                </div>
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

                {/* Spread-aware "net" numbers — what the broker's live spread
                    actually leaves on the table, which the on-chart R hides. */}
                {analysis.bt.stats.net && (
                  <div className="hint" dir="ltr" style={{ marginTop: 8 }}>
                    {P.btNet} ({t.spread} {analysis.spread?.toFixed(2)}):{" "}
                    <b style={{ color: analysis.bt.stats.net.avgR > 0 ? "var(--green)" : "var(--red)" }}>
                      {analysis.bt.stats.net.avgR != null ? `${analysis.bt.stats.net.avgR.toFixed(2)}R` : "—"}
                    </b>
                    {" · "}
                    {analysis.bt.stats.net.winRate != null ? `${analysis.bt.stats.net.winRate.toFixed(0)}% ${P.btWinRate}` : ""}
                    {" · PF "}
                    {analysis.bt.stats.net.profitFactor == null
                      ? "—"
                      : analysis.bt.stats.net.profitFactor === Infinity
                        ? "∞"
                        : analysis.bt.stats.net.profitFactor.toFixed(2)}
                  </div>
                )}

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
                <ReplayPanel results={analysis.bt.results} t={t} />
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

      {/* ---------- confidence calibration + trade journal — kept at the very
           bottom, below all the strategy content ---------- */}
      <CalibrationPanel t={t} />
      <JournalPanel t={t} lang={lang} />
    </div>
  );
}
