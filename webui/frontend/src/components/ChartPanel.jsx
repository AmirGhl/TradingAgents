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
import { strategyMarkers, STRATEGIES } from "../strategies.js";
import TechRating from "./TechRating.jsx";
import StrategyGauge from "./StrategyGauge.jsx";
import AutoTrade from "./AutoTrade.jsx";
import { useLiveQuote, useMt5Status, useBars } from "../utils.js";
import { useStrategyLive } from "../livesignal.js";

// TradingView-style timeframes. poll = yfinance-fallback refresh cadence (null
// = static); on the live MetaTrader feed candles stream over a WebSocket, not
// this poll. staleMs = age past which the (yfinance) feed is flagged "closed".
const TIMEFRAMES = [
  { tf: "1m", interval: "1m", range: "1d", poll: 5_000, intraday: true, staleMs: 6 * 60_000 },
  { tf: "5m", interval: "5m", range: "5d", poll: 15_000, intraday: true, staleMs: 20 * 60_000 },
  { tf: "15m", interval: "15m", range: "5d", poll: 15_000, intraday: true, staleMs: 60 * 60_000 },
  { tf: "1h", interval: "1h", range: "1mo", poll: 60_000, intraday: true, staleMs: 4 * 60 * 60_000 },
  { tf: "1d", interval: "1d", range: "6mo", poll: null, intraday: false, staleMs: 4 * 86_400_000 },
  { tf: "1wk", interval: "1wk", range: "2y", poll: null, intraday: false, staleMs: 14 * 86_400_000 },
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
  const mainRef = useRef(null); // main price series, for live-candle updates
  const [tfIdx, setTfIdx] = useState(loadTfIdx);
  useEffect(() => localStorage.setItem(LS_TF, String(tfIdx)), [tfIdx]);
  const [style, setStyle] = useState("candles");
  const [inds, setInds] = useState(loadInds);
  const [showMarkers, setShowMarkers] = useState(true);
  const [logScale, setLogScale] = useState(false);
  const [spotInfo, setSpotInfo] = useState(null); // {spot, pair} for futures
  const [legend, setLegend] = useState(null);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => localStorage.setItem(LS_KEY, JSON.stringify(inds)), [inds]);
  const toggle = (k) =>
    setInds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const TF = TIMEFRAMES[tfIdx];

  // ---- unified market data: /api/chart serves the open MetaTrader terminal's
  // own candles + live tick when it knows the symbol (source:"mt5" — the exact
  // prices trades fire on), yfinance otherwise. One door for every panel. ----
  const mt5s = useMt5Status();
  const feed = useBars(ticker, { interval: TF.interval, range: TF.range, poll: TF.poll });
  const bars = feed.bars;
  const mt5Active = feed.source === "mt5";
  const error = feed.error;

  // Futures ↔ spot spread (GC=F/SI=F → XAUUSD/XAGUSD) — yfinance mode only;
  // the broker feed needs no basis conversion.
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

  const on = (k) => inds.includes(k);
  const subPanes = ["rsi", "macd", "stoch", "adx"].filter(on).length;
  const chartHeight = 440 + subPanes * 120;

  const lastBar = bars?.[bars.length - 1];
  const prevBar = bars?.[bars.length - 2];
  const change = lastBar && prevBar ? ((lastBar.close - prevBar.close) / prevBar.close) * 100 : null;
  // Live price. On the MT5 stream use the BID — MetaTrader's candles are
  // bid-based, so the bid is exactly the number on the MT5 chart (zero
  // discrepancy). Off it, the yfinance/gold-api blend as before. Only the
  // yfinance path polls a separate quote; on the stream the tick comes with
  // the candles, so we skip the extra quote request entirely.
  const liveQuote = useLiveQuote(mt5Active ? null : ticker);
  const effSpotInfo = mt5Active ? null : spotInfo;
  const livePx = mt5Active
    ? feed.tick?.bid ?? feed.tick?.mid ?? lastBar?.close
    : liveQuote?.price ?? lastBar?.close;
  const liveSpot = mt5Active ? null : liveQuote?.spot ?? spotInfo?.spot;
  const liveChange = livePx != null && prevBar ? ((livePx - prevBar.close) / prevBar.close) * 100 : change;
  // Real-time futures↔spot basis so every set of MT5 SL/TP (rating + strategy)
  // tracks the live spread instead of the last polled candle — zero on the
  // broker feed, since those candles already are the broker's own symbol.
  const liveSpread = mt5Active ? null : livePx != null && liveSpot != null ? livePx - liveSpot : null;
  const liveSpotInfo = mt5Active
    ? null
    : spotInfo?.pair || liveQuote?.pair
      ? { pair: spotInfo?.pair || liveQuote?.pair, spot: liveSpot ?? null }
      : null;
  // "Market closed" flag: the newest yfinance bar is far older than the tf's
  // bar interval (weekend / after hours). Never stale on the live broker feed.
  const stale =
    !mt5Active && lastBar ? Date.now() - lastBar.time * 1000 > TF.staleMs : false;
  const rating = useMemo(() => (bars ? technicalRating(bars, TF.intraday) : null), [bars, TF.intraday]);

  // Structural signature: changes only when the bar SET changes — a new bar
  // forms (the rolling window slides, so the first/last bar times advance) or
  // the length grows — NOT when the forming bar's OHLC ticks. The whole chart
  // is rebuilt only on this; the forming candle then updates incrementally
  // (effect below), so the 7 Hz MT5 stream never tears down and recreates the
  // chart. Without this, a live stream would rebuild the chart ~7×/second.
  const barsSig = bars ? `${feed.source}:${bars.length}:${bars[0]?.time}:${lastBar?.time}` : null;

  // The ONE live strategy signal — same hook, same timeframe, same bars as the
  // Plan tab, so the banner can never disagree with the plan page. Only a
  // FRESH signal (not WAIT) exposes levels or a trade button.
  const live = useStrategyLive(ticker, strategyId);
  const strat = live.strat;
  const stratAnalysis = live.analysis;
  const stratActionable = !!(
    stratAnalysis && !stratAnalysis.error && stratAnalysis.signal !== "WAIT" && stratAnalysis.last
  );
  const stratLevelsRef = useRef(null);
  stratLevelsRef.current = stratActionable ? stratAnalysis.last : null;

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
    mainRef.current = main;

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

    // Levels of the selected strategy's CURRENT signal (fresh only — a WAIT
    // strategy draws no entry lines), so entry/SL/TP read straight off the
    // chart and always match the Plan tab.
    const se = stratLevelsRef.current;
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
      mainRef.current = null;
      chart.remove();
    };
  }, [barsSig, inds, signal, style, showMarkers, logScale, tfIdx, t.entry, strategyId, // eslint-disable-line react-hooks/exhaustive-deps
      stratActionable, stratAnalysis?.last?.time]); // rebuild on new bar/signal, not on every tick

  // Live-moving last candle, applied WITHOUT rebuilding the chart. On the MT5
  // stream the last bar IS MetaTrader's real forming candle (real O/H/L/C, bid-
  // based) pushed ~7×/second — draw it verbatim so the chart matches MT5 tick
  // for tick. On yfinance there's no forming candle, so roll the live quote
  // onto the last bar as before. lightweight-charts' update() only touches the
  // last point, so this is cheap at stream cadence.
  useEffect(() => {
    const s = mainRef.current;
    if (!s || !lastBar) return;
    try {
      if (mt5Active) {
        if (style === "candles") s.update(lastBar);
        else s.update({ time: lastBar.time, value: lastBar.close });
        return;
      }
      const p = livePx;
      if (p == null) return;
      if (style === "candles")
        s.update({
          time: lastBar.time,
          open: lastBar.open,
          high: Math.max(lastBar.high, p),
          low: Math.min(lastBar.low, p),
          close: p,
        });
      else s.update({ time: lastBar.time, value: p });
    } catch { /* series was replaced mid-update */ }
  }, [livePx, lastBar, style, mt5Active]);

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
              <span className="px">{fmt(livePx, mt5Active ? (feed.digits ?? 2) : 4)}</span>
              {liveChange != null && (
                <span className={`chg ${liveChange >= 0 ? "up" : "down"}`}>
                  {liveChange >= 0 ? "▲" : "▼"} {Math.abs(liveChange).toFixed(2)}%
                </span>
              )}
              {liveSpot != null && (spotInfo?.pair || liveQuote?.pair) && (
                <span className="spot-chip" title={t.spot}>
                  {spotInfo?.pair || liveQuote?.pair} {fmt(liveSpot, 2)}
                  <em> · {t.spread} {fmt((livePx ?? lastBar.close) - liveSpot, 2)}</em>
                </span>
              )}
              {mt5Active && feed.tick?.bid != null && feed.tick?.ask != null && (
                // Exact broker bid/ask — a BUY fills at ask, a SELL at bid.
                <span className="spot-chip" title={t.srcMt5Note}>
                  bid {fmt(feed.tick.bid, feed.digits ?? 2)} / ask {fmt(feed.tick.ask, feed.digits ?? 2)}
                  <em> · {t.spread} {fmt(feed.tick.ask - feed.tick.bid, feed.digits ?? 2)}</em>
                </span>
              )}
            </div>
          )}
          <span
            className={`src-chip ${mt5Active ? "mt5" : "yahoo"}`}
            title={mt5Active ? t.srcMt5Note : ""}
            dir="ltr"
          >
            {mt5Active
              ? `🔌 ${t.srcMt5}${mt5s?.account?.login ? ` #${mt5s.account.login}` : ""}`
              : `☁ ${t.srcYahoo}`}
          </span>
          {stale && <span className="src-chip stale">⚠ {t.mktStale}</span>}
          {(TF.poll || mt5Active) && (
            <motion.span
              key={feed.at}
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

        {!mt5Active && error && <div className="error-banner">{String(error)}</div>}

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
              <span className="sb-meta" dir="ltr" title={t.plan.timeframe}>
                {t.timeframes[live.tf] || live.tf}
              </span>
              <span className={`verdict-badge sm ${sig === "BUY" ? "buy" : sig === "SELL" ? "sell" : "hold"}`}>
                {sig === "WAIT" ? t.plan.dirWait : sig}
              </span>
              {sig !== "WAIT" && last ? (
                <>
                  <span className="sb-meta" dir="ltr">
                    {stratAnalysis.barsSince === 0
                      ? t.plan.justNow
                      : t.plan.barsAgo.replace("{n}", stratAnalysis.barsSince)}
                  </span>
                  {livePx != null && (
                    <span className="sb-meta" dir="ltr" title={t.plan.priceVsEntry}>
                      @ {fmt(livePx, dpB)}
                      {last.entry ? (
                        <b
                          className={livePx - last.entry >= 0 ? "up" : "down"}
                          style={{ marginInlineStart: 6 }}
                        >
                          {livePx - last.entry >= 0 ? "+" : ""}
                          {(((livePx - last.entry) / last.entry) * 100).toFixed(2)}%
                        </b>
                      ) : null}
                    </span>
                  )}
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
                // Neutral = NO tradable levels. Only say when the last signal
                // fired, so a stale entry can never be mistaken for a live one.
                <span className="sb-meta">
                  {last
                    ? `${t.plan.waitNoTrade} · ${last.dir} ${t.plan.barsAgo.replace("{n}", stratAnalysis.barsSince)}`
                    : t.plan.noSignalYet}
                </span>
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

      {/* Aggregate strategy gauge: every strategy compatible with this chart
          timeframe votes (fresh signals only, weighted by strength) — the
          TradingView-style needle for the strategy engine. The selected
          strategy's one-click trade block sits directly under the needle, and
          only exists while that strategy has a FRESH signal (never on WAIT).
          On the broker feed the levels already are the broker's own prices:
          zero spread shift, resolved symbol. Same shared signal as the Plan tab. */}
      <StrategyGauge
        bars={bars}
        intraday={TF.intraday}
        tf={TF.tf}
        t={t}
        activeId={strategyId}
        onPick={onStrategyChange}
        live={live}
      >
        {strat && stratActionable && (
          <AutoTrade
            t={t}
            ticker={ticker}
            levels={{
              dir: stratAnalysis.last.dir,
              entry: stratAnalysis.last.entry,
              sl: stratAnalysis.last.sl,
              tp1: stratAnalysis.last.tp1,
              tp2: stratAnalysis.last.tp2,
            }}
            spotInfo={live.source === "mt5" ? { pair: live.display } : liveSpotInfo ?? effSpotInfo}
            spread={live.source === "mt5" ? null : liveSpread}
            label={`${strat.icon} ${strat.meta[t.dir === "rtl" ? "fa" : "en"].name}`
                   + (stratAnalysis.strength != null ? ` · 💪 ${stratAnalysis.strength}%` : "")}
            tag={strat.id}
          />
        )}
      </StrategyGauge>

      <TechRating
        rating={rating}
        t={t}
        spotInfo={mt5Active ? { pair: feed.display } : liveSpotInfo ?? effSpotInfo}
        futuresLast={livePx}
        ticker={ticker}
        mt5={mt5Active}
      />

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
