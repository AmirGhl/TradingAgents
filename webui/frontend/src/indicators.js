// Indicator math for the pro chart. Every function takes the bar array
// [{time, open, high, low, close, volume}] and returns lightweight-charts
// line/histogram data (points before the warm-up period are omitted).

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    if (i >= period - 1) out[i] = prev;
  }
  return out;
}

const line = (bars, vals, from = 0) =>
  bars.flatMap((b, i) => (i >= from && vals[i] != null ? [{ time: b.time, value: vals[i] }] : []));

export function maSeries(bars, period) {
  return line(bars, sma(bars.map((b) => b.close), period));
}

export function emaSeries(bars, period) {
  return line(bars, ema(bars.map((b) => b.close), period));
}

export function bollinger(bars, period = 20, mult = 2) {
  const closes = bars.map((b) => b.close);
  const mid = sma(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < bars.length; i++) {
    if (mid[i] == null) continue;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper.push({ time: bars[i].time, value: mid[i] + mult * sd });
    lower.push({ time: bars[i].time, value: mid[i] - mult * sd });
  }
  return { mid: line(bars, mid), upper, lower };
}

export function rsi(bars, period = 14) {
  const out = [];
  let avgG = 0, avgL = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= period) {
      avgG += g / period;
      avgL += l / period;
      if (i === period) out.push({ time: bars[i].time, value: 100 - 100 / (1 + avgG / (avgL || 1e-9)) });
    } else {
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out.push({ time: bars[i].time, value: 100 - 100 / (1 + avgG / (avgL || 1e-9)) });
    }
  }
  return out;
}

export function macd(bars, fast = 12, slow = 26, signalP = 9) {
  const closes = bars.map((b) => b.close);
  const f = ema(closes, fast), s = ema(closes, slow);
  const macdVals = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const first = macdVals.findIndex((v) => v != null);
  const sig = ema(macdVals.slice(first), signalP).map((v, i) => (i < signalP - 1 ? null : v));
  const macdLine = [], signalLine = [], hist = [];
  for (let i = 0; i < bars.length; i++) {
    if (macdVals[i] == null) continue;
    macdLine.push({ time: bars[i].time, value: macdVals[i] });
    const sv = sig[i - first];
    if (sv != null) {
      signalLine.push({ time: bars[i].time, value: sv });
      const h = macdVals[i] - sv;
      hist.push({
        time: bars[i].time,
        value: h,
        color: h >= 0 ? "rgba(47,214,123,0.55)" : "rgba(255,93,108,0.55)",
      });
    }
  }
  return { macdLine, signalLine, hist };
}

export function stochastic(bars, period = 14, smooth = 3) {
  const kRaw = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    kRaw[i] = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
  }
  const kVals = kRaw.map((v) => v ?? 0);
  const kS = sma(kVals, smooth).map((v, i) => (kRaw[i] == null ? null : v));
  const dS = sma(kS.map((v) => v ?? 0), smooth).map((v, i) => (kS[i] == null ? null : v));
  return { k: line(bars, kS, period + smooth - 2), d: line(bars, dS, period + 2 * smooth - 3) };
}

export function vwap(bars, intraday) {
  // Intraday: reset at each UTC day boundary (session VWAP); daily bars:
  // cumulative over the loaded window.
  const out = [];
  let pv = 0, vol = 0, day = null;
  for (const b of bars) {
    const d = intraday ? Math.floor(b.time / 86400) : null;
    if (intraday && d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typ = (b.high + b.low + b.close) / 3;
    pv += typ * b.volume;
    vol += b.volume;
    if (vol > 0) out.push({ time: b.time, value: pv / vol });
  }
  return out;
}

export function fibLevels(bars) {
  let hi = -Infinity, lo = Infinity;
  for (const b of bars) {
    hi = Math.max(hi, b.high);
    lo = Math.min(lo, b.low);
  }
  if (!isFinite(hi) || !isFinite(lo) || hi === lo) return [];
  return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((r) => ({
    ratio: r,
    price: hi - (hi - lo) * r,
  }));
}

export function supportResistance(bars, period = 20) {
  const win = bars.slice(-period);
  if (!win.length) return null;
  return {
    resistance: Math.max(...win.map((b) => b.high)),
    support: Math.min(...win.map((b) => b.low)),
  };
}

export function atr14(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++)
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    ));
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (const tr of trs.slice(period)) a = (a * (period - 1) + tr) / period;
  return a;
}

// ---- value-array helpers (exported for the strategy engine) ----

export const smaArr = (values, period) => sma(values, period);
export const emaArr = (values, period) => ema(values, period);

export function rsiArr(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= period) {
      avgG += g / period;
      avgL += l / period;
      if (i === period) out[i] = 100 - 100 / (1 + avgG / (avgL || 1e-9));
    } else {
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out[i] = 100 - 100 / (1 + avgG / (avgL || 1e-9));
    }
  }
  return out;
}

export function atrArr(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  let a = null, sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    if (i <= period) {
      sum += tr;
      if (i === period) a = sum / period;
    } else {
      a = (a * (period - 1) + tr) / period;
    }
    out[i] = a;
  }
  return out;
}

// ---- Ichimoku Kinko Hyo (9, 26, 52) ----

function midpoint(bars, period, i) {
  if (i < period - 1) return null;
  let hi = -Infinity, lo = Infinity;
  for (let j = i - period + 1; j <= i; j++) {
    hi = Math.max(hi, bars[j].high);
    lo = Math.min(lo, bars[j].low);
  }
  return (hi + lo) / 2;
}

/** Raw (unshifted) ichimoku arrays; spanA/B are values computed at bar i —
 *  the cloud ABOVE price at bar i is spanA/B[i - 26]. */
export function ichimokuArr(bars, tenkanP = 9, kijunP = 26, senkouP = 52) {
  const n = bars.length;
  const tenkan = new Array(n).fill(null), kijun = new Array(n).fill(null);
  const spanA = new Array(n).fill(null), spanB = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    tenkan[i] = midpoint(bars, tenkanP, i);
    kijun[i] = midpoint(bars, kijunP, i);
    if (tenkan[i] != null && kijun[i] != null) spanA[i] = (tenkan[i] + kijun[i]) / 2;
    spanB[i] = midpoint(bars, senkouP, i);
  }
  return { tenkan, kijun, spanA, spanB };
}

/** Chart series: spanA/B shifted forward 26 bars (points beyond the last
 *  bar are dropped), chikou = close shifted back 26 bars. */
export function ichimoku(bars, shift = 26) {
  const { tenkan, kijun, spanA, spanB } = ichimokuArr(bars);
  const shifted = (vals) =>
    bars.flatMap((b, i) =>
      i >= shift && vals[i - shift] != null ? [{ time: b.time, value: vals[i - shift] }] : []);
  const chikou = bars.flatMap((b, i) =>
    i + shift < bars.length ? [{ time: b.time, value: bars[i + shift].close }] : []);
  return {
    tenkan: line(bars, tenkan),
    kijun: line(bars, kijun),
    spanA: shifted(spanA),
    spanB: shifted(spanB),
    chikou,
  };
}

// ---- SuperTrend (ATR trailing stop) ----

export function supertrendArr(bars, period = 10, mult = 3) {
  const n = bars.length;
  const atr = atrArr(bars, period);
  const st = new Array(n).fill(null);   // stop line value
  const dir = new Array(n).fill(null);  // 1 = uptrend, -1 = downtrend
  let up = null, dn = null;
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const mid = (bars[i].high + bars[i].low) / 2;
    let bu = mid - mult * atr[i];
    let bd = mid + mult * atr[i];
    if (up != null && bars[i - 1].close > up) bu = Math.max(bu, up);
    if (dn != null && bars[i - 1].close < dn) bd = Math.min(bd, dn);
    const prev = dir[i - 1] ?? 1;
    const d = prev === 1 ? (bars[i].close < bu ? -1 : 1) : (bars[i].close > bd ? 1 : -1);
    dir[i] = d;
    st[i] = d === 1 ? bu : bd;
    up = bu;
    dn = bd;
  }
  return { st, dir };
}

/** Two chart series (up-trend / down-trend legs) with whitespace gaps. */
export function supertrend(bars, period = 10, mult = 3) {
  const { st, dir } = supertrendArr(bars, period, mult);
  const upLine = [], downLine = [];
  for (let i = 0; i < bars.length; i++) {
    if (st[i] == null) continue;
    upLine.push(dir[i] === 1 ? { time: bars[i].time, value: st[i] } : { time: bars[i].time });
    downLine.push(dir[i] === -1 ? { time: bars[i].time, value: st[i] } : { time: bars[i].time });
  }
  return { upLine, downLine };
}

// ---- Donchian channel ----

export function donchianArr(bars, period = 20) {
  const n = bars.length;
  const upper = new Array(n).fill(null), lower = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

export function donchian(bars, period = 20) {
  const { upper, lower } = donchianArr(bars, period);
  const mid = upper.map((u, i) => (u == null ? null : (u + lower[i]) / 2));
  return { upper: line(bars, upper), lower: line(bars, lower), mid: line(bars, mid) };
}

// ---- ADX / DMI (Wilder 14) ----

export function adxArr(bars, period = 14) {
  const n = bars.length;
  const adx = new Array(n).fill(null);
  const pdi = new Array(n).fill(null), mdi = new Array(n).fill(null);
  if (n < period * 2 + 1) return { adx, pdi, mdi };
  let trS = 0, pdmS = 0, mdmS = 0, dxSum = 0, adxPrev = null;
  for (let i = 1; i < n; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const dnMove = bars[i - 1].low - bars[i].low;
    const pdm = upMove > dnMove && upMove > 0 ? upMove : 0;
    const mdm = dnMove > upMove && dnMove > 0 ? dnMove : 0;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    if (i <= period) {
      trS += tr;
      pdmS += pdm;
      mdmS += mdm;
      if (i < period) continue;
    } else {
      trS = trS - trS / period + tr;
      pdmS = pdmS - pdmS / period + pdm;
      mdmS = mdmS - mdmS / period + mdm;
    }
    const p = trS ? (100 * pdmS) / trS : 0;
    const m = trS ? (100 * mdmS) / trS : 0;
    pdi[i] = p;
    mdi[i] = m;
    const dx = p + m ? (100 * Math.abs(p - m)) / (p + m) : 0;
    if (i < period * 2) {
      dxSum += dx;
      if (i === period * 2 - 1) adxPrev = dxSum / period;
    } else {
      adxPrev = (adxPrev * (period - 1) + dx) / period;
    }
    if (i >= period * 2 - 1) adx[i] = adxPrev;
  }
  return { adx, pdi, mdi };
}

export function adxSeries(bars, period = 14) {
  const { adx, pdi, mdi } = adxArr(bars, period);
  return { adx: line(bars, adx), pdi: line(bars, pdi), mdi: line(bars, mdi) };
}

// ---- Heikin-Ashi candles ----

export function heikinAshi(bars) {
  const out = [];
  let ho = null, hc = null;
  for (const b of bars) {
    const c = (b.open + b.high + b.low + b.close) / 4;
    const o = ho == null ? (b.open + b.close) / 2 : (ho + hc) / 2;
    out.push({
      time: b.time,
      open: o,
      close: c,
      high: Math.max(b.high, o, c),
      low: Math.min(b.low, o, c),
      volume: b.volume,
    });
    ho = o;
    hc = c;
  }
  return out;
}

// ---- classic floor pivot points ----
// Intraday: previous UTC day's H/L/C. Daily: previous 5 bars (≈week).
// Weekly: previous 4 bars (≈month).

export function pivotPoints(bars, intraday) {
  if (!bars?.length) return null;
  let hi = -Infinity, lo = Infinity, close = null;
  if (intraday) {
    // Most recent completed day before the current one (skips weekend gaps).
    const day = (t) => Math.floor(t / 86400);
    const days = [...new Set(bars.map((b) => day(b.time)))].sort((a, b) => a - b);
    const prevDay = days[days.length - 2];
    if (prevDay == null) return null;
    const win = bars.filter((b) => day(b.time) === prevDay);
    for (const b of win) {
      hi = Math.max(hi, b.high);
      lo = Math.min(lo, b.low);
      close = b.close;
    }
  } else {
    const n = 5;
    const win = bars.slice(-(n + 1), -1);
    if (win.length < 2) return null;
    for (const b of win) {
      hi = Math.max(hi, b.high);
      lo = Math.min(lo, b.low);
      close = b.close;
    }
  }
  if (!isFinite(hi) || close == null) return null;
  const p = (hi + lo + close) / 3;
  return {
    p,
    r1: 2 * p - lo,
    s1: 2 * p - hi,
    r2: p + (hi - lo),
    s2: p - (hi - lo),
    r3: hi + 2 * (p - lo),
    s3: lo - 2 * (hi - p),
  };
}

/** Aggregate bars by a fixed factor (e.g. 1h → 4h with factor 4). */
export function resampleBars(bars, factor) {
  const out = [];
  for (let i = 0; i < bars.length; i += factor) {
    const chunk = bars.slice(i, i + factor);
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      volume: chunk.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

// ---- crossover markers (v5 createSeriesMarkers data) ----

function crossovers(bars, fastVals, slowVals, textUp, textDown) {
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const f0 = fastVals[i - 1], s0 = slowVals[i - 1], f1 = fastVals[i], s1 = slowVals[i];
    if (f0 == null || s0 == null || f1 == null || s1 == null) continue;
    if (f0 <= s0 && f1 > s1)
      out.push({ time: bars[i].time, position: "belowBar", color: "#2fd67b", shape: "arrowUp",
                 ...(textUp ? { text: textUp } : {}) });
    else if (f0 >= s0 && f1 < s1)
      out.push({ time: bars[i].time, position: "aboveBar", color: "#ff5d6c", shape: "arrowDown",
                 ...(textDown ? { text: textDown } : {}) });
  }
  return out;
}

function smaVals(bars, period) {
  const closes = bars.map((b) => b.close);
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function crossMarkers(bars) {
  const ma20 = smaVals(bars, 20), ma50 = smaVals(bars, 50);
  const m = macd(bars);
  const macdByTime = new Map(m.macdLine.map((p) => [p.time, p.value]));
  const sigByTime = new Map(m.signalLine.map((p) => [p.time, p.value]));
  const macdVals = bars.map((b) => macdByTime.get(b.time) ?? null);
  const sigVals = bars.map((b) => sigByTime.get(b.time) ?? null);
  return [
    ...crossovers(bars, ma20, ma50, "GC", "DC"),
    ...crossovers(bars, macdVals, sigVals, null, null),
  ].sort((a, b) => a.time - b.time);
}

// ---- TradingView-style technical rating ----
// Each rule votes +1 (buy) / -1 (sell) / 0 (neutral); the normalized mean
// maps onto strong-sell … strong-buy buckets.

export function technicalRating(bars, intraday) {
  if (!bars || bars.length < 30) return null;
  const last = bars[bars.length - 1];
  const closes = bars.map((b) => b.close);
  const ma20v = smaVals(bars, 20), ma50v = smaVals(bars, 50);
  const ma20 = ma20v[ma20v.length - 1], ma50 = ma50v[ma50v.length - 1];
  const ema10arr = emaSeries(bars, 10);
  const ema10 = ema10arr[ema10arr.length - 1]?.value;
  const rsiArr = rsi(bars);
  const rsiV = rsiArr[rsiArr.length - 1]?.value;
  const m = macd(bars);
  const macdV = m.macdLine[m.macdLine.length - 1]?.value;
  const sigV = m.signalLine[m.signalLine.length - 1]?.value;
  const h1 = m.hist[m.hist.length - 1]?.value, h0 = m.hist[m.hist.length - 2]?.value;
  const st = stochastic(bars);
  const kV = st.k[st.k.length - 1]?.value;
  const bb = bollinger(bars);
  const bbU = bb.upper[bb.upper.length - 1]?.value, bbL = bb.lower[bb.lower.length - 1]?.value;
  const vw = vwap(bars, intraday);
  const vwapV = vw[vw.length - 1]?.value;
  const mom = closes.length > 20 ? closes[closes.length - 1] - closes[closes.length - 21] : null;

  const votes = [];
  const add = (key, vote) => vote != null && votes.push({ key, vote });

  add("ma20", ma20 == null ? null : last.close > ma20 ? 1 : -1);
  add("ma50", ma50 == null ? null : last.close > ma50 ? 1 : -1);
  add("maCross", ma20 == null || ma50 == null ? null : ma20 > ma50 ? 1 : -1);
  add("ema10", ema10 == null ? null : last.close > ema10 ? 1 : -1);
  add("rsi", rsiV == null ? null : rsiV < 30 ? 1 : rsiV > 70 ? -1 : 0);
  add("macdCross", macdV == null || sigV == null ? null : macdV > sigV ? 1 : -1);
  add("macdHist", h1 == null || h0 == null ? null : h1 > h0 ? 1 : -1);
  add("stoch", kV == null ? null : kV < 20 ? 1 : kV > 80 ? -1 : 0);
  add("boll", bbU == null || bbL == null ? null : last.close < bbL ? 1 : last.close > bbU ? -1 : 0);
  add("vwap", !intraday || vwapV == null ? null : last.close > vwapV ? 1 : -1);
  add("momentum", mom == null ? null : mom > 0 ? 1 : -1);

  if (!votes.length) return null;
  const score = votes.reduce((s, v) => s + v.vote, 0) / votes.length; // -1 … 1
  const bucket =
    score >= 0.5 ? "strongBuy" : score >= 0.15 ? "buy" : score > -0.15 ? "neutral" : score > -0.5 ? "sell" : "strongSell";

  // ATR-anchored levels, mirroring gui_worker's deterministic fallback.
  const a = atr14(bars) || last.close * 0.02;
  const lo20 = Math.min(...bars.slice(-20).map((b) => b.low));
  const dir = score >= 0.15 ? "BUY" : score <= -0.15 ? "SELL" : "HOLD";
  const entry = dir === "HOLD" ? lo20 : last.close;
  const sl = dir === "SELL" ? entry + 1.5 * a : entry - 1.5 * a;
  const tp1 = dir === "SELL" ? entry - 1.5 * a : entry + 1.5 * a;
  const tp2 = dir === "SELL" ? entry - 3 * a : entry + 3 * a;
  const dp = last.close < 1 ? 4 : last.close < 100 ? 2 : 1;
  const rnd = (v) => Number(v.toFixed(dp));

  return {
    score,
    bucket,
    votes,
    counts: {
      buy: votes.filter((v) => v.vote === 1).length,
      neutral: votes.filter((v) => v.vote === 0).length,
      sell: votes.filter((v) => v.vote === -1).length,
    },
    levels: { dir, entry: rnd(entry), sl: rnd(sl), tp1: rnd(tp1), tp2: rnd(tp2), atr: rnd(a),
              rr: Number((Math.abs(tp2 - entry) / Math.max(Math.abs(entry - sl), 1e-9)).toFixed(1)) },
  };
}
