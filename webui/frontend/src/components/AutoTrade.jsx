import { useEffect, useState } from "react";

/** yfinance ticker → best-guess MT5 symbol (editable in the UI). */
export function brokerSymbol(tk) {
  const up = (tk || "").toUpperCase();
  if (up.endsWith("=X")) return up.slice(0, -2); // EURUSD=X → EURUSD
  if (up.endsWith("-USD")) return up.slice(0, -4) + "USD"; // BTC-USD → BTCUSD
  return up.replace(/[=^.\-]/g, "");
}

/** One-click MT5 execution of a set of levels (rating or strategy). The account
 *  lives in server settings; this block only picks symbol/lot/TP and confirms.
 *  Reused below the chart (technical rating) and on each strategy in the plan. */
export default function AutoTrade({ t, ticker, levels, spotInfo, spread, label, tag }) {
  const A = t.autoTrade;
  const [st, setSt] = useState(null); // /api/mt5/status payload
  const [lot, setLot] = useState(null); // null → server default
  const [tp, setTp] = useState("tp1");
  const [symOverride, setSymOverride] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {ok, error, ...}
  const [spec, setSpec] = useState(null); // broker contract facts + risk_per_lot

  useEffect(() => {
    let cancelled = false;
    setSymOverride(null);
    setResult(null);
    fetch("/api/mt5/status")
      .then((r) => r.json())
      .then((d) => !cancelled && setSt(d))
      .catch(() => !cancelled && setSt({ enabled: false }));
    return () => { cancelled = true; };
  }, [ticker]);

  // Derived before the early returns so hooks below stay unconditional.
  const dir = levels.dir;
  // MT5 trades the spot pair for futures charts → shift levels by the spread.
  const shift = spread != null ? spread : 0;
  const symbol = symOverride ?? (spotInfo?.pair || brokerSymbol(ticker));
  const entry = levels.entry - shift;
  const sl = levels.sl - shift;
  const tpPrice = (tp === "tp1" ? levels.tp1 : levels.tp2) - shift;
  const effLot = lot ?? st?.lot ?? 0.01;
  const isReal = !!st?.account?.is_real;

  // Broker-truth money-at-risk: ask MT5 what this exact SL costs per lot for
  // this exact symbol (tick value × distance), instead of guessing a contract
  // size. Rounded deps so a moving spread doesn't refetch on every tick.
  const eKey = Math.round(entry * 100), sKey = Math.round(sl * 100);
  useEffect(() => {
    if (!st?.enabled || !st?.connected || !symbol || !(entry > 0) || !(sl > 0)) {
      setSpec(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch("/api/mt5/symbol_info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // risk_pct lets the broker also suggest a 1%-of-equity lot size.
        body: JSON.stringify({ symbol, entry, sl, risk_pct: 1 }),
      })
        .then((r) => r.json())
        .then((d) => !cancelled && setSpec(d?.ok ? d : null))
        .catch(() => !cancelled && setSpec(null));
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [st?.enabled, st?.connected, symbol, eKey, sKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!st) return null;
  if (!st.enabled)
    return (
      <div className="autotrade off">
        <div className="at-head">🤖 {label || A.title}</div>
        <div className="hint">{A.notConfigured}</div>
      </div>
    );

  // "If the stop is hit, this costs X" — in account currency and as a share of
  // live equity. The single most useful number before pressing a market order.
  const riskMoney = spec?.risk_per_lot != null ? spec.risk_per_lot * effLot : null;
  const equity = st.account?.equity ?? null;
  const riskPct = riskMoney != null && equity ? (riskMoney / equity) * 100 : null;

  const send = () => {
    if (dir === "HOLD" || dir === "WAIT" || busy || st?.lock?.locked) return;
    const msg = A.confirm
      .replace("{dir}", dir)
      .replace("{symbol}", symbol)
      .replace("{lot}", String(effLot))
      .replace("{sl}", sl.toFixed(2))
      .replace("{tp}", tpPrice.toFixed(2));
    if (!window.confirm(msg)) return;
    setBusy(true);
    setResult(null);
    fetch("/api/mt5/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        dir,
        lot: effLot,
        sl: Number(sl.toFixed(2)),
        tp: Number(tpPrice.toFixed(2)),
        comment: (tag ? `TA-${tag}` : "TA-webui auto").slice(0, 26),
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        setResult(d);
        if (d.account) setSt((p) => ({ ...p, account: d.account }));
      })
      .catch((e) => setResult({ ok: false, error: String(e) }))
      .finally(() => setBusy(false));
  };

  // Send the trade to Telegram with Approve/Reject buttons instead of firing it
  // now — tap Approve on the phone (server executes it via the same MT5 path).
  const propose = () => {
    if (dir === "HOLD" || dir === "WAIT" || busy) return;
    setBusy(true);
    setResult(null);
    fetch("/api/mt5/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        dir,
        lot: effLot,
        sl: Number(sl.toFixed(2)),
        tp: Number(tpPrice.toFixed(2)),
        comment: (tag ? `TA-${tag}` : "TA-webui auto").slice(0, 26),
      }),
    })
      .then((r) => r.json())
      .then((d) => setResult(d.ok ? { ok: true, proposed: true } : { ok: false, error: d.error }))
      .catch((e) => setResult({ ok: false, error: String(e) }))
      .finally(() => setBusy(false));
  };

  const idle = dir === "HOLD" || dir === "WAIT";

  return (
    <div className={`autotrade ${isReal ? "real" : ""}`}>
      <div className="at-head">
        🤖 {label || A.title}
        {st.account ? (
          <span className="at-acct" dir="ltr">
            <span className={`acct-mode ${isReal ? "real" : "demo"}`}>
              {isReal ? A.real : A.demo}
            </span>
            #{st.account.login} · {A.balance} {Number(st.account.balance).toLocaleString("en-US")}{" "}
            {st.account.currency}
          </span>
        ) : (
          <span className="at-acct warn">{A.disconnected}</span>
        )}
      </div>

      {isReal && <div className="at-real-warn">⚠ {A.realWarn}</div>}

      {st.lock?.locked && (
        <div className="at-result err" dir={t.dir}>
          🛑 {t.guard.locked} — {t.guard[st.lock.reason] || st.lock.detail || ""}
        </div>
      )}

      <div className="at-row" dir="ltr">
        <span className={`vbadge ${dir === "BUY" ? "up" : dir === "SELL" ? "down" : "mid"}`}>
          {dir}
        </span>
        <input
          className="at-sym-input"
          type="text"
          value={symbol}
          dir="ltr"
          spellCheck={false}
          onChange={(e) => setSymOverride(e.target.value.toUpperCase())}
        />
        <label className="at-field">
          {A.lot}
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={effLot}
            onChange={(e) => setLot(Number(e.target.value))}
          />
        </label>
        <label className="at-field">
          TP
          <select value={tp} onChange={(e) => setTp(e.target.value)}>
            <option value="tp1">TP1 {levels.tp1 != null ? (levels.tp1 - shift).toFixed(2) : ""}</option>
            <option value="tp2">TP2 {levels.tp2 != null ? (levels.tp2 - shift).toFixed(2) : ""}</option>
          </select>
        </label>
        <button
          className={`at-btn ${dir === "BUY" ? "buy" : dir === "SELL" ? "sell" : ""}`}
          disabled={idle || busy || !symbol || st.lock?.locked}
          onClick={send}
        >
          {busy ? A.sending : idle ? A.holdNoTrade : A.send.replace("{dir}", dir)}
        </button>
        <button className="at-btn" title={A.propose} disabled={idle || busy || !symbol} onClick={propose}>
          📲
        </button>
      </div>

      <div className="hint at-note" dir="ltr">
        SL {sl.toFixed(2)} · TP {tpPrice.toFixed(2)}
        {spread != null && ` · ${t.spread} ${spread.toFixed(2)}`}
      </div>

      {riskMoney != null && !idle && (
        // Broker-truth money-at-risk if the stop is hit — the number that
        // matters most before a market order. Loud on a real account.
        <div className={`at-risk ${isReal ? "real" : ""}`} dir="ltr">
          {A.ifStopHit}: <b>−{riskMoney.toLocaleString("en-US", { maximumFractionDigits: 2 })} {st.account?.currency}</b>
          {riskPct != null && (
            <span className={riskPct > 3 ? "over" : ""}> · {riskPct.toFixed(1)}% {A.ofEquity}</span>
          )}
          {spec?.suggested_lot != null && (
            <button
              className="rtab xs"
              title={A.sizeToRisk}
              onClick={() => setLot(spec.suggested_lot)}
            >
              → {spec.suggested_lot}
            </button>
          )}
        </div>
      )}

      {result && (
        <div className={`at-result ${result.ok ? "ok" : "err"}`}>
          {result.ok
            ? result.proposed
              ? `📲 ${A.proposed}`
              : `✅ ${A.sent} — #${result.order ?? ""} @ ${result.price ?? ""}`
            : `✖ ${A.fail}: ${result.error}`}
        </div>
      )}
      <div className="hint">{A.riskNote}</div>
    </div>
  );
}
