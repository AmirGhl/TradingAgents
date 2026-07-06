import { useEffect, useRef, useState } from "react";

// Compact live tape across the top. Clicking a chip selects that symbol.
// The list is user-editable (settings ⚙ → watchlist), stored in localStorage.
export const TAPE_DEFAULT = [
  "GC=F", "SI=F", "BTC-USD", "ETH-USD", "EURUSD=X", "GBPUSD=X",
  "DX-Y.NYB", "CL=F", "^GSPC", "^NDX", "NVDA", "TSLA",
];
export const TAPE_LS = "ta_tape";

const LABELS = {
  "GC=F": "GOLD", "SI=F": "SILVER", "PL=F": "PLATINUM", "PA=F": "PALLADIUM",
  "HG=F": "COPPER", "CL=F": "WTI", "BZ=F": "BRENT", "NG=F": "NATGAS",
  "DX-Y.NYB": "DXY", "^GSPC": "S&P500", "^NDX": "NAS100", "^DJI": "US30",
  "^RUT": "US2000", "^VIX": "VIX", "^GDAXI": "DAX", "^FTSE": "FTSE",
  "^N225": "NIKKEI", "^HSI": "HSI",
};
const labelOf = (sym) =>
  LABELS[sym] || sym.replace(/=X$|-USD$|=F$/, "").replace(/^\^/, "");

export function loadTape() {
  try {
    const saved = JSON.parse(localStorage.getItem(TAPE_LS));
    if (Array.isArray(saved) && saved.length) return saved.slice(0, 24);
  } catch { /* default */ }
  return TAPE_DEFAULT;
}

const fmt = (v) =>
  v == null
    ? "…"
    : Number(v).toLocaleString("en-US", {
        maximumFractionDigits: Math.abs(v) >= 1000 ? 1 : Math.abs(v) >= 10 ? 2 : 4,
      });

export default function TickerTape({ onPick }) {
  const [prices, setPrices] = useState({});
  const [tape, setTape] = useState(loadTape);
  const prevRef = useRef({});

  // Reload when the settings modal edits the watchlist.
  useEffect(() => {
    const onChange = () => setTape(loadTape());
    window.addEventListener("ta_tape_changed", onChange);
    return () => window.removeEventListener("ta_tape_changed", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const symbols = tape.join(",");
    const load = () =>
      fetch(`/api/price?tickers=${encodeURIComponent(symbols)}`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          setPrices((old) => {
            prevRef.current = old;
            return data;
          });
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tape]);

  // Rendered twice for the seamless marquee loop.
  const chips = (suffix) =>
    tape.map((sym) => {
      const label = labelOf(sym);
      const v = prices[sym];
      const p = prevRef.current[sym];
      const dirCls = v != null && p != null ? (v > p ? "up" : v < p ? "down" : "") : "";
      return (
        <button
          key={sym + suffix}
          className={`tape-chip ${dirCls}`}
          onClick={() => onPick?.(sym)}
          title={sym}
          tabIndex={suffix ? -1 : 0}
        >
          <span className="ts">{label}</span>
          <span className="tp">{fmt(v)}</span>
        </button>
      );
    });

  return (
    <div className="tape" dir="ltr">
      <div className="tape-track">
        {chips("")}
        {chips("-b")}
      </div>
    </div>
  );
}
