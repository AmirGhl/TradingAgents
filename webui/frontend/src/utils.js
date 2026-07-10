// Small shared helpers for the web UI.

import { useEffect, useRef, useState } from "react";
import { subscribeBars, countFor } from "./mt5stream.js";

/** Near-real-time quote for a ticker: polls /api/quote (live gold-api spot for
 *  metals + last 1m close) every `poll` ms, pausing while the tab is hidden.
 *  Returns { price, spot, pair, at } or null. Used to move the strategy
 *  signal's price and its distance-to-levels between the slower bar polls. */
export function useLiveQuote(ticker, poll = 2500) {
  const [quote, setQuote] = useState(null);
  useEffect(() => {
    if (!ticker) return;
    let cancelled = false; // per-effect: an in-flight fetch from an old ticker
    const load = () => { //            can never set state after the switch.
      if (document.hidden) return;
      fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`)
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled && d) setQuote({ ...d, at: Date.now() });
        })
        .catch(() => {});
    };
    setQuote(null);
    load();
    const timer = setInterval(load, poll);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ticker, poll]);
  return quote;
}

/** Poll /api/mt5/status so panels can react to the broker connection. Slow
 *  cadence, paused on a hidden tab; returns the status payload (or null).
 *  `{enabled:false}` comes back instantly when MT5 is off — no connect. */
export function useMt5Status(poll = 15000) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      fetch("/api/mt5/status")
        .then((r) => r.json())
        .then((d) => !cancelled && setStatus(d))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, poll);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [poll]);
  return status;
}

/** THE market-data hook: candles + the live price for (ticker, interval,
 *  range). When the MetaTrader terminal is open it rides the WebSocket tick
 *  stream (source:"mt5") — the broker's OWN candles and live bid/ask pushed at
 *  ~7 Hz, so the price and the forming candle match MT5 with no perceptible
 *  lag and zero basis error. When the terminal is closed it falls back to the
 *  yfinance HTTP chart (source:"yahoo") and upgrades to live automatically the
 *  moment MetaTrader opens. Returns { bars, source, symbol, display, digits,
 *  tick, error, at } (bars null until the first load lands). */
export function useBars(ticker, { interval, range, poll = null }) {
  const [data, setData] = useState({ bars: null, source: null, error: null });
  const liveRef = useRef(false); // is the MT5 stream currently delivering?

  // ---- live MT5 stream (shared socket per ticker+tf) ----
  useEffect(() => {
    if (!ticker) return;
    liveRef.current = false;
    const count = countFor(range, interval);
    const unsub = subscribeBars(ticker, interval, count, (st) => {
      if (st.source === "mt5" && st.bars?.length) {
        liveRef.current = true;
        setData({ bars: st.bars, source: "mt5", symbol: st.symbol,
                  display: st.display, digits: st.digits, tick: st.tick,
                  error: null, at: st.at });
      } else {
        // terminal unavailable → let the HTTP fallback drive
        liveRef.current = false;
      }
    });
    return unsub;
  }, [ticker, interval, range]);

  // ---- yfinance HTTP fallback (only runs while the stream is NOT live) ----
  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    let timer = null;
    const tick = () => {
      if (cancelled) return;
      // MT5 stream is live, or tab is hidden → don't fetch; just re-check soon.
      if (liveRef.current || document.hidden) {
        timer = setTimeout(tick, 1200);
        return;
      }
      fetch(`/api/chart?ticker=${encodeURIComponent(ticker)}&range=${range}&interval=${interval}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled || liveRef.current) return;
          if (d.error || !d.bars?.length)
            setData((p) => ({ ...p, error: d.error || "no data" }));
          else if (d.source === "mt5")
            // stream is catching up; ignore the HTTP MT5 one-shot to avoid a flip-flop
            liveRef.current = true;
          else
            setData({ bars: d.bars, source: "yahoo", symbol: d.symbol,
                      display: d.display, digits: d.digits, tick: d.tick,
                      error: null, at: Date.now() });
        })
        .catch((e) => !cancelled && setData((p) => ({ ...p, error: String(e) })))
        .finally(() => {
          if (!cancelled) timer = setTimeout(tick, poll || 5000);
        });
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ticker, interval, range, poll]);

  return data;
}

/** Short completion beep via WebAudio (no asset files needed). */
export function beep(freq = 880) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    setTimeout(() => ctx.close(), 700);
  } catch { /* audio blocked */ }
}

/** Fire a browser notification if permitted (no permission prompt here). */
export function notify(title, body) {
  try {
    if ("Notification" in window && Notification.permission === "granted")
      new Notification(title, { body });
  } catch { /* blocked */ }
}
