import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

// Best-effort MT5 symbol for a yfinance ticker when no live spot pair is known.
const MT5_MAP = { "GC=F": "XAUUSD", "SI=F": "XAGUSD", "PL=F": "XPTUSD", "CL=F": "XTIUSD" };
export function mt5Symbol(ticker) {
  if (MT5_MAP[ticker]) return MT5_MAP[ticker];
  return ticker.replace(/=X$/, "").replace(/-USD$/, "USD");
}

// Approximate contract size per 1.0 lot (quote currency) for the risk line.
function contractSize(sym) {
  if (/^XAG/.test(sym)) return 5000;
  if (/^(XAU|XPT|XPD)/.test(sym)) return 100;
  if (/^[A-Z]{6}$/.test(sym)) return 100000; // FX pairs
  return null; // indices/crypto/stocks: too broker-specific to guess
}

const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d));

export default function TradeTicket({ open, onClose, symbol, dir, entry, sl, tp1, tp2, comment, t }) {
  const T = t.ticket;
  const [st, setSt] = useState(null); // /api/mt5/status payload
  const [info, setInfo] = useState(null); // /api/mt5/symbol_info — broker-truth risk math
  const [lot, setLot] = useState("");
  const [tpKey, setTpKey] = useState("tp1");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setBusy(false);
    setSt(null);
    fetch("/api/mt5/status")
      .then((r) => r.json())
      .then((d) => {
        setSt(d);
        setLot((prev) => prev || String(d.lot ?? 0.01));
      })
      .catch(() => setSt({ enabled: false, error: "server unreachable" }));
  }, [open]);

  // Pull the broker's real contract/tick values and a 1%-risk lot suggestion,
  // so the risk line is correct even for indices/crypto/stocks where the
  // client-side guess gives up. Falls back to the guess if this fails.
  useEffect(() => {
    if (!open || entry == null || sl == null) return;
    setInfo(null);
    fetch("/api/mt5/symbol_info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, entry, sl, risk_pct: 1 }),
    })
      .then((r) => r.json())
      .then((d) => setInfo(d && d.ok ? d : null))
      .catch(() => setInfo(null));
  }, [open, symbol, entry, sl]);

  const tp = tpKey === "tp2" ? tp2 : tp1;
  const slDist = entry != null && sl != null ? Math.abs(entry - sl) : null;
  const cs = contractSize(symbol);
  const equity = info?.equity ?? st?.account?.equity;
  const ccy = info?.currency || st?.account?.currency || "";
  const lotNum = parseFloat(lot) || 0;
  // Prefer the broker's money-at-risk per lot; fall back to the local guess.
  const riskPerLot = info?.risk_per_lot ?? (slDist != null && cs != null ? slDist * cs : null);
  const riskNow = riskPerLot != null && lotNum > 0 ? riskPerLot * lotNum : null;
  const lot1pct =
    info?.suggested_lot ??
    (slDist && cs && equity ? Math.max(0.01, Math.floor(((equity * 0.01) / (slDist * cs)) * 100) / 100) : null);
  const locked = !!st?.lock?.locked;
  const ready = st?.enabled && st?.connected && !st?.error && !locked;

  const send = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/mt5/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir, symbol, lot: lotNum, sl, tp, comment: comment || "TradingAgents" }),
      });
      setResult(await r.json());
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    }
    setBusy(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="modal ticket"
            initial={{ y: 30, scale: 0.96, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 20, scale: 0.97, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>
              {T.title}{" "}
              <span className={`verdict-badge ${dir === "BUY" ? "buy" : "sell"} ticket-dir`} dir="ltr">
                {dir} {symbol}
              </span>
            </h3>

            {/* connection / config state */}
            {!st && <div className="hint">{T.checking}</div>}
            {st && !st.enabled && (
              <div className="ticket-warn">⚠ {T.disabled}</div>
            )}
            {st && st.enabled && st.error && <div className="ticket-warn">⚠ {st.error}</div>}
            {ready && st.account && (
              <div className="hint" dir="ltr">
                {st.account.login}@{st.account.server} · {T.equity} {fmt(equity)} {ccy}
              </div>
            )}
            {locked && (
              <div className="ticket-warn">
                🛑 {t.guard.locked} — {t.guard[st.lock.reason] || st.lock.detail || ""}
              </div>
            )}

            {/* order summary */}
            <div className="ticket-rows" dir="ltr">
              <div className="trow">
                <span className="k">{t.entry}</span>
                <span className="v">≈ {fmt(entry)} <em className="ticket-mkt">{T.market}</em></span>
              </div>
              <div className="trow">
                <span className="k">{t.stopLoss}</span>
                <span className="v sl">{fmt(sl)}</span>
              </div>
              <div className="trow">
                <span className="k">TP</span>
                <span className="v tp">
                  <select value={tpKey} onChange={(e) => setTpKey(e.target.value)}>
                    <option value="tp1">TP1 · {fmt(tp1)}</option>
                    <option value="tp2">TP2 · {fmt(tp2)}</option>
                  </select>
                </span>
              </div>
              <div className="trow">
                <span className="k">{T.lot}</span>
                <span className="v">
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={lot}
                    onChange={(e) => setLot(e.target.value)}
                  />
                  {lot1pct != null && (
                    <button type="button" className="rtab ticket-suggest" onClick={() => setLot(String(lot1pct))}>
                      1% ≈ {lot1pct}
                    </button>
                  )}
                </span>
              </div>
              {riskNow != null && (
                <div className="trow">
                  <span className="k">{T.riskEst}</span>
                  <span className="v">
                    ≈ {fmt(riskNow)} {ccy} <em className="ticket-mkt">{T.approx}</em>
                  </span>
                </div>
              )}
            </div>

            {/* result */}
            {result && result.ok && (
              <div className="ticket-ok" dir="ltr">
                ✅ {T.sent} · #{result.order} @ {result.price} · {result.volume} lot
              </div>
            )}
            {result && !result.ok && <div className="ticket-warn">✗ {result.error}</div>}

            <div className="ticket-actions">
              {!result?.ok && (
                <button className="rtab on ticket-go" disabled={!ready || busy || lotNum <= 0} onClick={send}>
                  {busy ? T.sending : `${T.confirm} ${dir}`}
                </button>
              )}
              <button className="rtab" onClick={onClose}>
                {result?.ok ? T.done : T.cancel}
              </button>
            </div>
            <div className="hint ticket-note">{T.note}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
