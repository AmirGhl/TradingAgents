import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  AreaSeries,
  CrosshairMode,
  LineStyle,
  createSeriesMarkers,
} from "lightweight-charts";
import {
  maSeries,
  emaSeries,
  bollinger,
  rsi,
  macd,
  stochastic,
  vwap,
  fibLevels,
  supportResistance,
  crossMarkers,
  technicalRating,
  ichimoku,
  supertrend,
  donchian,
  adxSeries,
  pivotPoints,
} from "../indicators.js";
import { strategyMarkers, byId as strategyById, STRATEGIES, analyze } from "../strategies.js";
import TechRating from "./TechRating.jsx";

// TradingView-style timeframes; poll = live refresh cadence (null = static).
const TIMEFRAMES = [
  { tf: "1m", interval: "1m", range: "1d", poll: 5_000, intraday: true },
  { tf: "5m", interval: "5m", range: "5d", poll: 15_000, intraday: true },
  { tf: "15m", interval: "15m", range: "5d", poll: 15_000, intraday: true },
  { tf: "1h", interval: "1h", range: "1mo", poll: 60_000, intraday: true },
  { tf: "1d", interval: "1d", range: "6mo", poll: null, intraday: false },
  { tf: "1wk", interval: "1wk", range: "2y", poll: null, intraday: false },
];
const STYLES = ["candles", "line", "area"];

const IND_KEYS = ["ma20", "ma50", "ema10", "boll", "ichi", "st", "don", "fib", "sr", "piv", "rsi", "macd", "stoch", "adx", "vol", "vwap"];
const IND_DEFAULT = ["ma20", "ma50", "boll", "rsi", "macd", "vol"];
const LS_KEY = "ta_chart_indicators";
const LS_TF = "ta_chart_tf";

// Default to the 1-minute chart (scalping-first); the last choice persists.
const loadTfIdx = () => {
  const saved = Number(localStorage.getItem(LS_TF));
  return Number.isInteger(saved) && saved >= 0 && saved < TIMEFRAMES.length ? saved : 0;
};

const loadInds = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY));
    if (Array.isArray(saved)) return saved.filter((k) => IND_KEYS.includes(k));
  } catch { /* first visit */ }
  return IND_DEFAULT;
};

const fmt = (v, dp = 2) =>
  v == null ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: dp });

/** Pro chart: TradingView-style timeframes with live polling, three chart
 *  styles, crosshair OHLC legend, 11 indicators across panes, crossover
 *  markers, fullscreen/log-scale, and an automatic technical rating. */
export default function ChartPanel({ ticker, signal, t, strategyId, onStrategyChange }) {
  const hostRef = useRef(null);
  const wrapRef = useRef(null);
  const barsByTime = useRef(new Map());
  const [tfIdx, setTfIdx] = useState(loadTfIdx);
  useEffect(() => localStorage.setItem(LS_TF, String(tfIdx)), [tfIdx]);
  const [style, setStyle] = useState("candles");
  const [inds, setInds] = useState(loadInds);
  const [showMarkers, setShowMarkers] = useState(true);
  const [logScale, setLogScale] = useState(false);
  const [bars, setBars] = useState(null);
  const [spotInfo, setSpotInfo] = useState(null); // {spot, pair} for futures
  const [legend, setLegend] = useState(null);
  const [error, setError] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const [tick, setTick] = useState(0); // heartbeat for the live dot

  useEffect(() => localStorage.setItem(LS_KEY, JSON.stringify(inds)), [inds]);
  const toggle = (k) =>
    setInds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const TF = TIMEFRAMES[tfIdx];

  // ---- data fetch + live polling ----
  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    const load = () => {
      fetch(`/api/chart?ticker=${encodeURIComponent(ticker)}&range=${TF.range}&interval=${TF.interval}`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          if (data.error || !data.bars?.length) setError(data.error || "no data");
          else {
            setError(null);
            setBars(data.bars);
            setTick((n) => n + 1);
          }
        })
        .catch((e) => !cancelled && setError(String(e)));
      // Futures ↔ spot spread (GC=F/SI=F → XAUUSD/XAGUSD), refreshed together.
      fetch(`/api/spot?ticker=${encodeURIComponent(ticker)}`)
        .then((r) => r.json())
        .then((d) => !cancelled && setSpotInfo(d.pair ? d : null))
        .catch(() => {});
    };
    setError(null);
    setBars(null);
    setSpotInfo(null);
    load();
    const timer = TF.poll ? setInterval(load, TF.poll) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [ticker, tfIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  const on = (k) => inds.includes(k);
  const subPanes = ["rsi", "macd", "stoch", "adx"].filter(on).length;
  const chartHeight = 440 + subPanes * 120;

  const lastBar = bars?.[bars.length - 1];
  const prevBar = bars?.[bars.length - 2];
  const change = lastBar && prevBar ? ((lastBar.close - prevBar.close) / prevBar.close) * 100 : null;
  const rating = useMemo(() => (bars ? technicalRating(bars, TF.intraday) : null), [bars, TF.intraday]);

  // Live analysis of the selected strategy on this timeframe (banner + levels).
  const strat = strategyId ? strategyById(strategyId) : null;
  const stratAnalysis = useMemo(
    () => (strategyId && bars ? analyze(strategyId, bars, TF.intraday) : null),
    [strategyId, bars, TF.intraday],
  );

  // ---- chart build ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !bars?.length) return;
    barsByTime.current = new Map(bars.map((b) => [b.time, b]));

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { color: "#0a1120" },
        textColor: "#8fa1c2",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
        panes: { separatorColor: "#1c2942", separatorHoverColor: "#2c3f63" },
      },
      grid: {
        vertLines: { color: "rgba(28,41,66,0.55)" },
        horzLines: { color: "rgba(28,41,66,0.55)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1c2942", mode: logScale ? 1 : 0 },
      timeScale: { borderColor: "#1c2942", timeVisible: TF.intraday, secondsVisible: false },
    });

    let main;
    if (style === "candles") {
      main = chart.addSeries(CandlestickSeries, {
        upColor: "#2fd67b",
        downColor: "#ff5d6c",
        wickUpColor: "#2fd67b",
        wickDownColor: "#ff5d6c",
        borderVisible: false,
      });
      main.setData(bars);
    } else if (style === "line") {
      main = chart.addSeries(LineSeries, { color: "#e8b64c", lineWidth: 2 });
      main.setData(bars.map((b) => ({ time: b.time, value: b.close })));
    } else {
      main = chart.addSeries(AreaSeries, {
        lineColor: "#e8b64c",
        topColor: "rgba(232,182,76,0.35)",
        bottomColor: "rgba(232,182,76,0.02)",
        lineWidth: 2,
      });
      main.setData(bars.map((b) => ({ time: b.time, value: b.close })));
    }

    const overlay = (data, options) =>
      chart.addSeries(LineSeries, {
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        ...options,
      }).setData(data);

    if (on("ma20")) overlay(maSeries(bars, 20), { color: "#4dc6ff", title: "MA20" });
    if (on("ma50")) overlay(maSeries(bars, 50), { color: "#b78cff", title: "MA50" });
    if (on("ema10")) overlay(emaSeries(bars, 10), { color: "#ff9f43", title: "EMA10" });
    if (on("vwap"))
      overlay(vwap(bars, TF.intraday), { color: "#e8b64c", title: "VWAP", lineStyle: LineStyle.Dashed });
    if (on("boll")) {
      const b = bollinger(bars);
      const opt = { color: "rgba(143,161,194,0.65)", lineStyle: LineStyle.Dotted };
      overlay(b.upper, { ...opt, title: "BB+" });
      overlay(b.mid, { ...opt, lineStyle: LineStyle.Solid, color: "rgba(143,161,194,0.4)" });
      overlay(b.lower, { ...opt, title: "BB-" });
    }
    if (on("ichi")) {
      const ic = ichimoku(bars);
      overlay(ic.tenkan, { color: "#4dc6ff", title: "Tenkan" });
      overlay(ic.kijun, { color: "#ff5d6c", title: "Kijun" });
      overlay(ic.spanA, { color: "rgba(47,214,123,0.5)", title: "SpanA" });
      overlay(ic.spanB, { color: "rgba(255,93,108,0.5)", title: "SpanB" });
      overlay(ic.chikou, { color: "rgba(183,140,255,0.6)", title: "Chikou", lineStyle: LineStyle.Dotted });
    }
    if (on("st")) {
      const stx = supertrend(bars);
      overlay(stx.upLine, { color: "#2fd67b", title: "ST", lineWidth: 2 });
      overlay(stx.downLine, { color: "#ff5d6c", lineWidth: 2 });
    }
    if (on("don")) {
      const dc = donchian(bars);
      const opt = { color: "rgba(232,182,76,0.55)", lineStyle: LineStyle.Dashed };
      overlay(dc.upper, { ...opt, title: "DC+" });
      overlay(dc.mid, { ...opt, color: "rgba(232,182,76,0.25)", lineStyle: LineStyle.Dotted });
      overlay(dc.lower, { ...opt, title: "DC-" });
    }

    const priceLine = (price, color, title, styleL = LineStyle.Dashed) =>
      price != null &&
      !isNaN(price) &&
      main.createPriceLine({ price: Number(price), color, lineWidth: 1, lineStyle: styleL, title });

    if (on("fib"))
      for (const f of fibLevels(bars))
        priceLine(f.price, "rgba(183,140,255,0.55)", `Fib ${f.ratio}`, LineStyle.SparseDotted);
    if (on("sr")) {
      const sr = supportResistance(bars);
      if (sr) {
        priceLine(sr.resistance, "rgba(255,93,108,0.7)", "R");
        priceLine(sr.support, "rgba(47,214,123,0.7)", "S");
      }
    }
    if (on("piv")) {
      const pv = pivotPoints(bars, TF.intraday);
      if (pv) {
        priceLine(pv.p, "rgba(232,182,76,0.8)", "P", LineStyle.Solid);
        priceLine(pv.r1, "rgba(255,93,108,0.55)", "R1");
        priceLine(pv.r2, "rgba(255,93,108,0.4)", "R2");
        priceLine(pv.r3, "rgba(255,93,108,0.25)", "R3");
        priceLine(pv.s1, "rgba(47,214,123,0.55)", "S1");
        priceLine(pv.s2, "rgba(47,214,123,0.4)", "S2");
        priceLine(pv.s3, "rgba(47,214,123,0.25)", "S3");
      }
    }
    if (signal) {
      priceLine(signal.entry, "#e8b64c", t.entry, LineStyle.Solid);
      priceLine(signal.stop_loss, "#ff5d6c", "SL", LineStyle.Solid);
      priceLine(signal.take_profit_1, "#2fd67b", "TP1", LineStyle.Solid);
      priceLine(signal.take_profit_2, "#2fd67b", "TP2", LineStyle.Solid);
    }

    // Levels of the selected strategy's latest signal, so entry/SL/TP are
    // readable straight off the chart.
    const se = stratAnalysis && !stratAnalysis.error ? stratAnalysis.last : null;
    if (se) {
      priceLine(se.entry, "#e8b64c", `⚡${t.entry}`, LineStyle.Dashed);
      priceLine(se.sl, "#ff5d6c", "⚡SL", LineStyle.Dashed);
      priceLine(se.tp1, "#2fd67b", "⚡TP1", LineStyle.Dashed);
      priceLine(se.tp2, "#2fd67b", "⚡TP2", LineStyle.Dashed);
    }

    if (style === "candles") {
      const stratMarks = strategyId ? strategyMarkers(bars, strategyId, TF.intraday) : [];
      const marks = [...(showMarkers ? crossMarkers(bars) : []), ...stratMarks]
        .sort((a, b) => a.time - b.time);
      if (marks.length) createSeriesMarkers(main, marks);
    }

    if (on("vol")) {
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
        priceLineVisible: false,
        lastValueVisible: false,
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volume.setData(
        bars.map((b) => ({
          time: b.time,
          value: b.volume,
          color: b.close >= b.open ? "rgba(47,214,123,0.3)" : "rgba(255,93,108,0.3)",
        })),
      );
    }

    let pane = 0;
    const subLine = (data, options, paneIdx) => {
      const s = chart.addSeries(
        LineSeries,
        { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, ...options },
        paneIdx,
      );
      s.setData(data);
      return s;
    };
    const zone = (series, hi, lo) => {
      const opt = { color: "rgba(143,161,194,0.45)", lineWidth: 1, lineStyle: LineStyle.Dotted };
      series.createPriceLine({ ...opt, price: hi, title: String(hi) });
      series.createPriceLine({ ...opt, price: lo, title: String(lo) });
    };

    if (on("rsi")) {
      pane += 1;
      zone(subLine(rsi(bars), { color: "#4dc6ff", title: "RSI" }, pane), 70, 30);
    }
    if (on("macd")) {
      pane += 1;
      const m = macd(bars);
      const h = chart.addSeries(
        HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false },
        pane,
      );
      h.setData(m.hist);
      subLine(m.macdLine, { color: "#4dc6ff", title: "MACD" }, pane);
      subLine(m.signalLine, { color: "#e8b64c", title: "Signal" }, pane);
    }
    if (on("stoch")) {
      pane += 1;
      const st = stochastic(bars);
      zone(subLine(st.k, { color: "#4dc6ff", title: "%K" }, pane), 80, 20);
      subLine(st.d, { color: "#e8b64c", title: "%D" }, pane);
    }
    if (on("adx")) {
      pane += 1;
      const ax = adxSeries(bars);
      const s = subLine(ax.adx, { color: "#e8b64c", title: "ADX", lineWidth: 2 }, pane);
      s.createPriceLine({ price: 25, color: "rgba(143,161,194,0.45)", lineWidth: 1,
                          lineStyle: LineStyle.Dotted, title: "25" });
      subLine(ax.pdi, { color: "#2fd67b", title: "+DI" }, pane);
      subLine(ax.mdi, { color: "#ff5d6c", title: "-DI" }, pane);
    }

    try {
      const panes = chart.panes();
      panes[0]?.setStretchFactor(300);
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(100);
    } catch { /* default pane heights */ }

    // Crosshair legend (falls back to the latest bar).
    chart.subscribeCrosshairMove((param) => {
      const b = (param.time && barsByTime.current.get(param.time)) || null;
      setLegend(b);
    });

    chart.timeScale().fitContent();
    chart.__fit = () => chart.timeScale().fitContent();
    host.__chart = chart;
    return () => {
      delete host.__chart;
      chart.remove();
    };
  }, [bars, inds, signal, style, showMarkers, logScale, tfIdx, t.entry, strategyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const lg = legend || lastBar;
  const lgChg = lg && barsByTime.current ? (() => {
    const arr = bars || [];
    const i = arr.findIndex((b) => b.time === lg.time);
    const p = i > 0 ? arr[i - 1] : null;
    return p ? ((lg.close - p.close) / p.close) * 100 : null;
  })() : null;

  const guideEntries = useMemo(() => IND_KEYS.map((k) => [k, t.indGuide[k]]), [t]);

  return (
    <>
      <div className="panel panel-pad chart-wrap" ref={wrapRef}>
        <div className="chart-head">
          <h3 style={{ direction: "ltr", fontFamily: "var(--font-mono)" }}>{ticker || "—"}</h3>
          {lastBar && (
            <div className="last-price" dir="ltr">
              <span className="px">{fmt(lastBar.close, 4)}</span>
              {change != null && (
                <span className={`chg ${change >= 0 ? "up" : "down"}`}>
                  {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
                </span>
              )}
              {spotInfo?.spot != null && (
                <span className="spot-chip" title={t.spot}>
                  {spotInfo.pair} {fmt(spotInfo.spot, 2)}
                  <em> · {t.spread} {fmt(lastBar.close - spotInfo.spot, 2)}</em>
                </span>
              )}
            </div>
          )}
          {TF.poll && (
            <motion.span
              key={tick}
              className="live-badge"
              initial={{ opacity: 0.55 }}
              animate={{ opacity: 1 }}
            >
              <motion.i
                animate={{ opacity: [1, 0.25, 1] }}
                transition={{ duration: 1.6, repeat: Infinity }}
              />
              {t.live}
            </motion.span>
          )}
          <div className="spacer" />
          <button className="rtab" onClick={() => wrapRef.current?.requestFullscreen?.()}>⛶ {t.fullscreen}</button>
          <button className="rtab" onClick={() => hostRef.current?.__chart?.__fit()}>{t.fitChart}</button>
          <button className={`rtab ${logScale ? "on" : ""}`} onClick={() => setLogScale(!logScale)}>{t.logScale}</button>
          <button className="rtab" onClick={() => setShowGuide(true)}>{t.guide}</button>
        </div>

        <div className="chart-controls">
          {TIMEFRAMES.map((x, i) => (
            <button key={x.tf} className={`rtab ${i === tfIdx ? "on" : ""}`} onClick={() => setTfIdx(i)}>
              {t.timeframes[x.tf]}
            </button>
          ))}
          <span className="ctrl-sep" />
          {STYLES.map((s) => (
            <button key={s} className={`rtab ${style === s ? "on" : ""}`} onClick={() => setStyle(s)}>
              {t.styles[s]}
            </button>
          ))}
          <span className="ctrl-sep" />
          <button
            className={`rtab ${showMarkers ? "on" : ""}`}
            onClick={() => setShowMarkers(!showMarkers)}
            title="MA20×MA50 + MACD"
          >
            ⇅ {t.signals}
          </button>
          <select
            className="strat-select"
            value={strategyId || ""}
            onChange={(e) => onStrategyChange?.(e.target.value || null)}
            title={t.plan?.pick}
          >
            <option value="">🎯 —</option>
            {STRATEGIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.icon} {s.meta[t.dir === "rtl" ? "fa" : "en"].name}
              </option>
            ))}
          </select>
        </div>

        <div className="chart-controls inds" role="group" aria-label={t.indicators}>
          {IND_KEYS.map((k) => (
            <button key={k} className={`chip sm ${on(k) ? "on" : ""}`} aria-pressed={on(k)} onClick={() => toggle(k)}>
              {t.indGuide[k][0]}
            </button>
          ))}
        </div>

        {error && <div className="error-banner">{String(error)}</div>}

        {strat && stratAnalysis && !stratAnalysis.error && (() => {
          const m = strat.meta[t.dir === "rtl" ? "fa" : "en"];
          const last = stratAnalysis.last;
          const sig = stratAnalysis.signal;
          const dpB = last ? (Math.abs(last.entry) >= 1000 ? 1 : Math.abs(last.entry) >= 10 ? 2 : 4) : 2;
          return (
            <motion.div
              className={`strat-banner ${sig === "BUY" ? "buy" : sig === "SELL" ? "sell" : "wait"}`}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <span className="sb-name">{strat.icon} {m.name}</span>
              <span className={`verdict-badge sm ${sig === "BUY" ? "buy" : sig === "SELL" ? "sell" : "hold"}`}>
                {sig === "WAIT" ? t.plan.dirWait : sig}
              </span>
              {last ? (
                <>
                  <span className="sb-meta" dir="ltr">
                    {last.dir} ·{" "}
                    {stratAnalysis.barsSince === 0
                      ? t.plan.justNow
                      : t.plan.barsAgo.replace("{n}", stratAnalysis.barsSince)}
                  </span>
                  <span className="sb-levels" dir="ltr">
                    <b className="e">{last.entry.toFixed(dpB)}</b>
                    <i className="sl">SL {last.sl.toFixed(dpB)}</i>
                    <i className="tp">TP1 {last.tp1.toFixed(dpB)}</i>
                    <i className="tp">TP2 {last.tp2.toFixed(dpB)}</i>
                  </span>
                  {stratAnalysis.strength != null && (
                    <span className="sb-strength" title={t.plan.strength}>
                      💪 {stratAnalysis.strength}%
                    </span>
                  )}
                </>
              ) : (
                <span className="sb-meta">{t.plan.noSignalYet}</span>
              )}
            </motion.div>
          );
        })()}
        {strat && stratAnalysis?.error === "notEnoughBars" && (
          <div className="strat-banner wait">
            <span className="sb-name">{strat.icon}</span>
            <span className="sb-meta">
              {t.plan.notEnoughBars.replace("{need}", stratAnalysis.need).replace("{have}", stratAnalysis.have)}
            </span>
          </div>
        )}

        <div className="chart-box">
          {lg && (
            <div className="ohlc-legend" dir="ltr">
              <span>O <b>{fmt(lg.open, 4)}</b></span>
              <span>H <b>{fmt(lg.high, 4)}</b></span>
              <span>L <b>{fmt(lg.low, 4)}</b></span>
              <span>C <b className={lgChg >= 0 ? "up" : "down"}>{fmt(lg.close, 4)}</b></span>
              {lgChg != null && (
                <span className={lgChg >= 0 ? "up" : "down"}>{lgChg >= 0 ? "+" : ""}{lgChg.toFixed(2)}%</span>
              )}
              <span>V <b>{fmt(lg.volume, 0)}</b></span>
            </div>
          )}
          <div ref={hostRef} style={{ width: "100%", height: chartHeight, transition: "height 0.25s" }} />
        </div>
      </div>

      <div style={{ height: 18 }} />
      <TechRating rating={rating} t={t} spotInfo={spotInfo} futuresLast={lastBar?.close} ticker={ticker} />

      <AnimatePresence>
        {showGuide && (
          <motion.div
            className="modal-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowGuide(false)}
          >
            <motion.div
              className="modal"
              dir={t.dir}
              initial={{ opacity: 0, y: 30, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 220, damping: 22 }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={t.guideTitle}
            >
              <h3>{t.guideTitle}</h3>
              <div className="guide-list">
                {guideEntries.map(([k, [name, desc]]) => (
                  <div key={k} className="guide-item">
                    <span className="gname">{name}</span>
                    <span className="gdesc">{desc}</span>
                  </div>
                ))}
              </div>
              <button className="rtab on" style={{ marginTop: 14 }} onClick={() => setShowGuide(false)}>
                {t.close}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
