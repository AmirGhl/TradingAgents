// One live MetaTrader WebSocket per (ticker, tf, count), shared by every
// consumer. This is what makes the price/candle/signal match MT5 with no lag
// AND with no cross-panel discrepancy: the chart and the plan signal read the
// exact same stream object, and only ONE socket per timeframe exists no matter
// how many components subscribe. Ref-counted — the socket closes when the last
// subscriber leaves. While MetaTrader is closed the stream reports `source:null`
// so the caller falls back to the yfinance HTTP chart, and it upgrades to live
// automatically the moment the terminal opens.

const streams = new Map(); // key -> entry

const keyFor = (ticker, tf, count) => `${ticker}|${tf}|${count}`;

const wsUrl = () => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/mt5`;
};

// Diff updates only carry the last 1-2 bars, so cap the running series or it
// would grow by one bar per minute forever on a long-open tab (slowing every
// analyze/backtest pass). 2500 bars is well past what any strategy or the
// chart window needs.
const MAX_BARS = 2500;

// Merge a diff (last 1-2 real bars) into the running series: replace the bars
// that share a timestamp, append genuinely new ones, keep time order.
function mergeBars(prev, incoming) {
  if (!prev?.length) return incoming;
  const byTime = new Map(prev.map((b) => [b.time, b]));
  for (const b of incoming) byTime.set(b.time, b);
  const merged = [...byTime.values()].sort((a, b) => a.time - b.time);
  return merged.length > MAX_BARS ? merged.slice(-MAX_BARS) : merged;
}

function broadcast(entry) {
  for (const cb of entry.subs) {
    try { cb(entry.state); } catch { /* subscriber threw */ }
  }
}

function open(key, ticker, tf, count) {
  const entry = {
    ws: null,
    subs: new Set(),
    closed: false,
    retry: null,
    state: { bars: null, tick: null, source: null, symbol: null,
             display: null, digits: null, at: 0 },
  };
  streams.set(key, entry);

  const markUnavailable = () => {
    if (entry.state.source !== null || entry.state.at === 0) {
      entry.state = { ...entry.state, source: null, at: Date.now() };
      broadcast(entry);
    }
  };

  const scheduleRetry = () => {
    if (entry.closed || entry.retry) return;
    markUnavailable();
    entry.retry = setTimeout(() => { entry.retry = null; connect(); }, 4000);
  };

  const connect = () => {
    if (entry.closed) return;
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch { scheduleRetry(); return; }
    entry.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ ticker, tf, count }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "snapshot") {
        entry.state = { bars: msg.bars, tick: msg.tick || null, source: "mt5",
                        symbol: msg.symbol, display: msg.display,
                        digits: msg.digits, at: Date.now() };
        broadcast(entry);
      } else if (msg.type === "update") {
        entry.state = { ...entry.state, source: "mt5",
                        bars: mergeBars(entry.state.bars, msg.bars),
                        tick: msg.tick || entry.state.tick, at: Date.now() };
        broadcast(entry);
      } else if (msg.type === "unavailable") {
        markUnavailable();
      }
    };
    ws.onclose = () => { entry.ws = null; scheduleRetry(); };
    ws.onerror = () => { try { ws.close(); } catch { /* already gone */ } };
  };

  connect();
  return entry;
}

/** Subscribe to the live MT5 stream for (ticker, tf, count). `cb(state)` fires
 *  on every tick with { bars, tick, source, symbol, display, digits, at };
 *  source is "mt5" when live, null when the terminal is unavailable (fall back
 *  to HTTP). Returns an unsubscribe function. */
export function subscribeBars(ticker, tf, count, cb) {
  if (!ticker) return () => {};
  const key = keyFor(ticker, tf, count);
  let entry = streams.get(key);
  if (!entry) entry = open(key, ticker, tf, count);
  entry.subs.add(cb);
  if (entry.state.at) cb(entry.state); // hand over the last-known state at once
  return () => {
    entry.subs.delete(cb);
    if (entry.subs.size === 0) {
      entry.closed = true;
      if (entry.retry) clearTimeout(entry.retry);
      try { entry.ws?.close(); } catch { /* already gone */ }
      streams.delete(key);
    }
  };
}

// yfinance range/interval → a matching MT5 candle count for the stream window.
const RANGE_DAYS = { "1d": 1, "5d": 5, "1mo": 30, "3mo": 90, "6mo": 180,
                     "1y": 365, "2y": 730, "5y": 1825 };
const INTERVAL_S = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
                     "1h": 3600, "4h": 14400, "1d": 86400, "1wk": 604800 };

export function countFor(range, interval) {
  const days = RANGE_DAYS[range] || 180;
  const step = INTERVAL_S[interval] || 86400;
  return Math.max(60, Math.min(2000, Math.round((days * 86400) / step)));
}
