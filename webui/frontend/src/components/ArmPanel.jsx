import { useEffect, useState } from "react";
import { STRATEGIES } from "../strategies.js";

// The auto-execution control room: which strategies are "armed" (the server
// evaluates them on live broker candles and acts on a fresh signal), whether
// they run in shadow (paper) or live mode, and the shadow journal that lets you
// prove a setup before it ever touches money. All persisted server-side, so the
// engine keeps running with no tab open.
export default function ArmPanel({ t, lang, defaultTicker }) {
  const A = t.arm;
  const [auto, setAuto] = useState(false);
  const [items, setItems] = useState([]);
  const [engine, setEngine] = useState(null); // {ok, error}
  const [shadow, setShadow] = useState([]);
  const [saved, setSaved] = useState(false);

  const load = () => {
    fetch("/api/arm").then((r) => r.json()).then((d) => {
      setAuto(!!d.auto);
      setItems(d.items || []);
    }).catch(() => {});
    fetch("/api/engine/status").then((r) => r.json()).then(setEngine).catch(() => {});
    fetch("/api/shadow").then((r) => r.json()).then((d) => setShadow(Array.isArray(d) ? d : [])).catch(() => {});
  };
  useEffect(load, []);

  const save = (nextItems = items, nextAuto = auto) =>
    fetch("/api/arm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto: nextAuto, items: nextItems }),
    })
      .then((r) => r.json())
      .then((d) => {
        setItems(d.items || []);
        setAuto(!!d.auto);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      })
      .catch(() => {});

  const addRow = () => {
    const strat = STRATEGIES[0];
    const row = {
      id: Math.random().toString(36).slice(2, 10),
      ticker: (defaultTicker || "XAUUSD").toUpperCase(),
      strategy: strat.id,
      tf: strat.tfs.includes("1m") ? "1m" : strat.defaultTf,
      lot: null,
      min_strength: 0,
      mode: "shadow",
      enabled: true,
    };
    const next = [...items, row];
    setItems(next);
    save(next);
  };

  const patch = (id, key, val) => {
    const next = items.map((r) => {
      if (r.id !== id) return r;
      const nr = { ...r, [key]: val };
      // Keep the timeframe valid for the chosen strategy.
      if (key === "strategy") {
        const s = STRATEGIES.find((x) => x.id === val);
        if (s && !s.tfs.includes(nr.tf)) nr.tf = s.tfs.includes("1m") ? "1m" : s.defaultTf;
      }
      return nr;
    });
    setItems(next);
    save(next);
  };

  const goLive = (id, toLive) => {
    if (toLive && !window.confirm(A.confirmLive)) return;
    patch(id, "mode", toLive ? "live" : "shadow");
  };

  const removeRow = (id) => {
    const next = items.filter((r) => r.id !== id);
    setItems(next);
    save(next);
  };

  const clearShadow = () =>
    fetch("/api/shadow", { method: "DELETE" }).then(() => setShadow([])).catch(() => {});

  return (
    <div className="panel panel-pad plan-sect">
      <div className="pos-head">
        <div>
          <h3>🤖 {A.title}</h3>
          <div className="sub" style={{ marginBottom: 0 }}>{A.sub}</div>
        </div>
        <label className={`check-item inline ${auto ? "ok" : ""}`} style={{ margin: 0 }}>
          <input type="checkbox" checked={auto} onChange={(e) => save(items, e.target.checked)} />
          <span className="box">{auto ? "✓" : ""}</span>
          {A.masterOn}
        </label>
      </div>

      {engine && !engine.ok && (
        <div className="at-result err" style={{ marginTop: 8 }}>
          ⚠ {A.engineOff}{engine.error ? ` — ${engine.error}` : ""}
        </div>
      )}
      {engine?.ok && (
        <div className="hint" style={{ marginTop: 6, color: "var(--green)" }}>● {A.engineOn}</div>
      )}

      {items.length === 0 && <div className="hint" style={{ padding: "12px 0" }}>{A.empty}</div>}

      {items.length > 0 && (
        <div className="scan-wrap" style={{ marginTop: 10 }}>
          <table className="scan-table" dir="ltr">
            <thead>
              <tr className="scan-head">
                <th>{A.on}</th><th>{A.symbol}</th><th>{A.strategy}</th><th>TF</th>
                <th>{A.lot}</th><th>{A.minStr}</th><th>{A.mode}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const strat = STRATEGIES.find((s) => s.id === r.strategy);
                return (
                  <tr key={r.id} className="scan-row">
                    <td>
                      <input type="checkbox" checked={!!r.enabled}
                             onChange={(e) => patch(r.id, "enabled", e.target.checked)} />
                    </td>
                    <td>
                      <input className="at-sym-input" style={{ width: 92 }} value={r.ticker} dir="ltr"
                             spellCheck={false}
                             onChange={(e) => patch(r.id, "ticker", e.target.value.toUpperCase())} />
                    </td>
                    <td>
                      <select value={r.strategy} onChange={(e) => patch(r.id, "strategy", e.target.value)}>
                        {STRATEGIES.map((s) => (
                          <option key={s.id} value={s.id}>{s.icon} {s.meta[lang === "fa" ? "fa" : "en"].name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select value={r.tf} onChange={(e) => patch(r.id, "tf", e.target.value)}>
                        {(strat?.tfs || ["1m"]).map((x) => (
                          <option key={x} value={x}>{t.timeframes[x] || x}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="number" min="0.01" step="0.01" style={{ width: 64 }}
                             value={r.lot ?? ""} placeholder="auto" dir="ltr"
                             onChange={(e) => patch(r.id, "lot", e.target.value ? Number(e.target.value) : null)} />
                    </td>
                    <td>
                      <input type="number" min="0" max="100" step="5" style={{ width: 56 }}
                             value={r.min_strength || 0} dir="ltr"
                             onChange={(e) => patch(r.id, "min_strength", Number(e.target.value))} />
                    </td>
                    <td>
                      <button
                        className={`chip sm ${r.mode === "live" ? "danger on" : "on"}`}
                        onClick={() => goLive(r.id, r.mode !== "live")}
                        title={A.modeHint}
                      >
                        {r.mode === "live" ? `🔴 ${A.live}` : `🌓 ${A.shadow}`}
                      </button>
                    </td>
                    <td><button className="rtab xs" onClick={() => removeRow(r.id)}>✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="plan-actions" style={{ marginTop: 10 }}>
        <button className="rtab on" onClick={addRow}>＋ {A.add}</button>
        {saved && <span className="hint" style={{ color: "var(--green)" }}>✓ {A.saved}</span>}
      </div>

      <div className="hint" style={{ marginTop: 8 }}>{A.note}</div>

      {/* shadow journal */}
      <div className="plan-h" style={{ marginTop: 18 }}>
        🌓 {A.shadowJournal} {shadow.length > 0 && <span className="hint">({shadow.length})</span>}
      </div>
      {shadow.length === 0 ? (
        <div className="hint" style={{ padding: "8px 0" }}>{A.shadowEmpty}</div>
      ) : (
        <>
          <div className="scan-wrap">
            <table className="scan-table" dir="ltr">
              <thead>
                <tr className="scan-head">
                  <th>{A.time}</th><th>{A.symbol}</th><th></th><th>{A.price}</th>
                  <th>SL</th><th>TP</th><th>{t.spread}</th>
                </tr>
              </thead>
              <tbody>
                {shadow.slice(0, 30).map((x, i) => (
                  <tr key={i} className="scan-row">
                    <td>{x.ts}</td>
                    <td>{x.symbol}</td>
                    <td><span className={`vbadge ${x.dir === "BUY" ? "up" : "down"}`}>{x.dir}</span></td>
                    <td className="mono">{x.price}</td>
                    <td className="mono">{x.sl ?? "—"}</td>
                    <td className="mono">{x.tp ?? "—"}</td>
                    <td className="mono">{x.spread_points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="plan-actions" style={{ marginTop: 8 }}>
            <button className="rtab" onClick={load}>⟳ {A.refresh}</button>
            <button className="rtab" onClick={clearShadow}>{A.clearShadow}</button>
          </div>
        </>
      )}
    </div>
  );
}
