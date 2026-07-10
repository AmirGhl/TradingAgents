import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const money = (v, ccy) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}${ccy ? " " + ccy : ""}`);

// Digits for the price columns of a position row.
const dg = (p) => (p.digits != null ? p.digits : Math.abs(p.price_open) >= 100 ? 2 : 4);

/**
 * Open MT5 positions with live P/L and one-click management
 * (close, close half, jump the stop to break-even). Completes the
 * open→monitor→manage→close loop that the trade ticket only started.
 */
export default function PositionsPanel({ t }) {
  const P = t.positions;
  const G = t.guard;
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState({}); // ticket → action label while a request is in flight
  const [flash, setFlash] = useState(null); // { ok, msg }
  const timer = useRef(null);

  const load = useCallback((quiet) => {
    if (!quiet) setData((d) => d || "loading");
    fetch("/api/mt5/positions")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ enabled: false, error: "server unreachable", positions: [] }));
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(() => load(true), 5000);
    return () => clearInterval(timer.current);
  }, [load]);

  const act = async (ticket, url, body, label) => {
    setBusy((b) => ({ ...b, [ticket]: label }));
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      setFlash(d.ok ? { ok: true, msg: P.actionOk } : { ok: false, msg: d.error || P.actionFail });
    } catch (e) {
      setFlash({ ok: false, msg: String(e) });
    }
    setBusy((b) => {
      const n = { ...b };
      delete n[ticket];
      return n;
    });
    setTimeout(() => setFlash(null), 3000);
    load(true);
  };

  // Safety guard: re-arm (clear the lock) or disarm (trip it now).
  const guardAction = (url) =>
    fetch(url, { method: "POST" }).then(() => load(true)).catch(() => {});

  const loading = data === "loading" || data == null;
  const d = loading ? null : data;
  const positions = d?.positions || [];
  const acct = d?.account;
  const ccy = acct?.currency || "";

  return (
    <div className="panel panel-pad plan-sect positions">
      <div className="pos-head">
        <div>
          <h3>{P.title}</h3>
          <div className="sub" style={{ marginBottom: 0 }}>{P.sub}</div>
        </div>
        <button className="rtab pos-refresh" onClick={() => load(false)} title={P.refresh}>
          ⟳
        </button>
      </div>

      {loading && <div className="plan-loading">⏳</div>}

      {!loading && !d.enabled && <div className="ticket-warn">⚠ {P.disabled}</div>}
      {!loading && d.enabled && d.error && <div className="ticket-warn">⚠ {d.error}</div>}

      {!loading && d.enabled && d.connected && (
        <>
          {acct && (
            <div className="pos-acct" dir="ltr">
              <div className="pa-cell">
                <span className="k">{P.equity}</span>
                <span className="v">{fmt(acct.equity)} {ccy}</span>
              </div>
              <div className="pa-cell">
                <span className="k">{P.balance}</span>
                <span className="v">{fmt(acct.balance)} {ccy}</span>
              </div>
              <div className="pa-cell">
                <span className="k">{P.free}</span>
                <span className="v">{fmt(acct.margin_free)} {ccy}</span>
              </div>
              <div className="pa-cell">
                <span className="k">{P.floating}</span>
                <span className={`v ${acct.profit >= 0 ? "up" : "down"}`}>{money(acct.profit, ccy)}</span>
              </div>
            </div>
          )}

          {(d.lock?.locked || d.guard) && (
            <div
              className="pos-guard"
              dir={t.dir}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                margin: "10px 0",
                padding: "8px 10px",
                borderRadius: 8,
                background: d.lock?.locked ? "rgba(220,50,50,.12)" : "transparent",
                border: `1px solid ${d.lock?.locked ? "var(--red)" : "var(--border)"}`,
              }}
            >
              {d.lock?.locked ? (
                <>
                  <b style={{ color: "var(--red)" }}>
                    🛑 {G.locked} — {G[d.lock.reason] || d.lock.detail || ""}
                  </b>
                  <span style={{ flex: 1 }} />
                  <button className="rtab" onClick={() => guardAction("/api/mt5/rearm")}>
                    {G.rearm}
                  </button>
                </>
              ) : (
                <>
                  <span className="hint">
                    🛡 {G.dayPl}: {money(d.day_pl, ccy)}
                    {d.max_daily_loss ? ` / −${d.max_daily_loss}` : ""}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button className="rtab danger" onClick={() => guardAction("/api/mt5/lock")}>
                    {G.disarm}
                  </button>
                </>
              )}
            </div>
          )}

          <AnimatePresence>
            {flash && (
              <motion.div
                className={flash.ok ? "ticket-ok" : "ticket-warn"}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                dir="ltr"
              >
                {flash.ok ? "✅ " : "✗ "}{flash.msg}
              </motion.div>
            )}
          </AnimatePresence>

          {positions.length === 0 ? (
            <div className="hint" style={{ padding: "18px 0" }}>{P.empty}</div>
          ) : (
            <div className="scan-wrap">
              <table className="scan-table pos-table" dir="ltr">
                <thead>
                  <tr className="scan-head">
                    <th>{P.symbol}</th>
                    <th>{P.dir}</th>
                    <th>{P.volume}</th>
                    <th>{P.entry}</th>
                    <th>{P.now}</th>
                    <th>{P.sl}</th>
                    <th>{P.tp}</th>
                    <th>{P.pnl}</th>
                    <th>{P.manage}</th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence initial={false}>
                    {positions.map((p) => {
                      const b = busy[p.ticket];
                      return (
                        <motion.tr
                          key={p.ticket}
                          layout
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0, height: 0 }}
                        >
                          <td className="scan-name">{p.symbol}</td>
                          <td>
                            <span className={`vbadge ${p.dir === "BUY" ? "up" : "down"}`}>{p.dir}</span>
                          </td>
                          <td className="mono">{fmt(p.volume, 2)}</td>
                          <td className="mono">{fmt(p.price_open, dg(p))}</td>
                          <td className="mono">{fmt(p.price_current, dg(p))}</td>
                          <td className="mono">{p.sl ? fmt(p.sl, dg(p)) : "—"}</td>
                          <td className="mono">{p.tp ? fmt(p.tp, dg(p)) : "—"}</td>
                          <td className={`mono pos-pnl ${p.profit >= 0 ? "up" : "down"}`}>
                            {money(p.profit)}
                          </td>
                          <td className="pos-actions">
                            <button
                              className="rtab xs"
                              disabled={!!b}
                              title={P.breakevenTip}
                              onClick={() => act(p.ticket, "/api/mt5/modify", { ticket: p.ticket, breakeven: true }, "be")}
                            >
                              {b === "be" ? "…" : P.breakeven}
                            </button>
                            <button
                              className="rtab xs"
                              disabled={!!b || p.volume < 0.02}
                              title={P.closeHalfTip}
                              onClick={() => act(p.ticket, "/api/mt5/close", { ticket: p.ticket, volume: p.volume / 2 }, "half")}
                            >
                              {b === "half" ? "…" : P.closeHalf}
                            </button>
                            <button
                              className="rtab xs danger"
                              disabled={!!b}
                              onClick={() => act(p.ticket, "/api/mt5/close", { ticket: p.ticket }, "close")}
                            >
                              {b === "close" ? "…" : P.close}
                            </button>
                          </td>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          )}
          <div className="hint" style={{ marginTop: 10 }}>{P.note}</div>
        </>
      )}
    </div>
  );
}
