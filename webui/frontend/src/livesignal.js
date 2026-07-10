// The ONE live strategy signal, shared by the Plan tab and the Chart banner.
//
// Both views previously fetched their own bars on their own timeframe and ran
// analyze() separately, so the same strategy could say BUY on one page and
// WAIT on the other. This hook owns the strategy timeframe (persisted, shared)
// and the bar feed, so every consumer computes the identical signal from the
// identical candles — broker candles when MetaTrader is open (via the unified
// /api/chart), yfinance otherwise.

import { useEffect, useMemo, useState } from "react";
import { byId as strategyById, analyze } from "./strategies.js";
import { useBars } from "./utils.js";

// timeframe → fetch window + yfinance-fallback poll cadence. Ranges are long
// enough for the slow strategies (SMA200, Ichimoku). When MetaTrader is open
// the signal is re-evaluated on every stream tick (~7 Hz), not on this poll.
export const TF_FETCH = {
  "1m": { range: "1d", poll: 10_000 },
  "5m": { range: "5d", poll: 30_000 },
  "15m": { range: "1mo", poll: 30_000 },
  "1h": { range: "3mo", poll: 60_000 },
  "1d": { range: "2y", poll: null },
  "1wk": { range: "5y", poll: null },
};
export const INTRADAY = new Set(["1m", "5m", "15m", "1h"]);

const LS_TF = "ta_strat_tf";

/** The timeframe this strategy's live signal runs on: the user's last choice
 *  when the strategy supports it, else 1m (scalping-first), else its default. */
export function pickStratTf(strat) {
  const saved = localStorage.getItem(LS_TF);
  if (strat?.tfs.includes(saved)) return saved;
  if (strat?.tfs.includes("1m")) return "1m";
  return strat?.defaultTf || "1m";
}

/** Live, self-refreshing analysis of one strategy on one ticker.
 *  Returns { strat, tf, setTf, intraday, bars, source, display, tick,
 *  analysis, error }. `analysis.signal` is "BUY"/"SELL" only while the last
 *  event is fresh — "WAIT" means no entry (and the UI must not offer one). */
export function useStrategyLive(ticker, stratId) {
  const strat = stratId ? strategyById(stratId) : null;
  const [tf, setTfState] = useState(() => pickStratTf(strat));
  // Re-pick when the strategy changes (keeps the shared choice if compatible).
  useEffect(() => {
    setTfState(pickStratTf(strat));
  }, [stratId]); // eslint-disable-line react-hooks/exhaustive-deps
  const setTf = (x) => {
    localStorage.setItem(LS_TF, x);
    setTfState(x);
  };

  const meta = TF_FETCH[tf] || TF_FETCH["1d"];
  const feed = useBars(strat ? ticker : null, { interval: tf, range: meta.range,
                                                poll: meta.poll });
  const intraday = INTRADAY.has(tf);
  // Live broker spread (ask − bid) → honest, spread-aware net R in the backtest.
  const spread =
    feed.tick?.ask != null && feed.tick?.bid != null
      ? Math.max(0, feed.tick.ask - feed.tick.bid)
      : 0;
  const analysis = useMemo(
    () => (strat && feed.bars ? analyze(strat.id, feed.bars, intraday, spread) : null),
    [strat, feed.bars, intraday, spread],
  );
  return { strat, tf, setTf, intraday, bars: feed.bars, source: feed.source,
           display: feed.display, tick: feed.tick, analysis, error: feed.error };
}
