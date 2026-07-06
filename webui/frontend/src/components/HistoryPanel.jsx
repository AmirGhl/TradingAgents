import { useEffect, useMemo, useState } from "react";

const fmt = (v, d = 2) =>
  v == null || isNaN(v) ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d });

const DIR_OF = (e) => {
  const d = String(e.signal?.direction || e.decision || "").toUpperCase();
  return d.includes("BUY") ? "BUY" : d.includes("SELL") ? "SELL" : "HOLD";
};

/** Past runs (auto-saved server-side), outcome evaluation via signal_eval,
 *  win-rate stats, CSV export, and one-click reopen of a run's reports. */
export default function HistoryPanel({ t, onOpen }) {
  const H = t.hist;
  const [items, setItems] = useState(null);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState(null);

  const reload = () =>
    fetch("/api/history")
      .then((r) => r.json())
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  const stats = useMemo(() => {
    if (!items?.length) return null;
    const oc = (x) => x.outcome || "?";
    const wins = items.filter((x) => ["tp1", "tp2"].includes(oc(x))).length;
    const losses = items.filter((x) => oc(x) === "sl").length;
    const openish = items.filter((x) => ["open", "no_entry"].includes(oc(x))).length;
    const closed = wins + losses;
    return {
      total: items.length,
      wins,
      losses,
      openish,
      winRate: closed ? (wins / closed) * 100 : null,
    };
  }, [items]);

  const evaluate = () => {
    const jobs = (items || []).flatMap((x, i) =>
      x.signal?.entry != null && x.date
        ? [{
            i,
            ticker: x.ticker,
            date: x.date,
            dir: DIR_OF(x),
            entry: x.signal.entry,
            sl: x.signal.stop_loss,
            tp1: x.signal.take_profit_1,
            tp2: x.signal.take_profit_2,
          }]
        : [],
    );
    if (!jobs.length) return;
    setEvaluating(true);
    fetch("/api/eval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jobs),
    })
      .then((r) => r.json())
      .then((results) => {
        if (!Array.isArray(results)) throw new Error(results?.error || "eval failed");
        const outcomes = {};
        for (const res of results) {
          const item = items[res.i];
          if (item?.ts) outcomes[item.ts] = res.outcome;
        }
        return fetch("/api/history/outcomes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(outcomes),
        });
      })
      .then(reload)
      .catch((e) => setError(String(e)))
      .finally(() => setEvaluating(false));
  };

  const exportCsv = () => {
    const head = "ts,ticker,date,decision,model,entry,sl,tp1,tp2,outcome";
    const rows = (items || []).map((x) =>
      [
        x.ts, x.ticker, x.date, String(x.decision || "").replaceAll(",", ";"),
        x.model, x.signal?.entry ?? "", x.signal?.stop_loss ?? "",
        x.signal?.take_profit_1 ?? "", x.signal?.take_profit_2 ?? "",
        x.outcome ?? "",
      ].join(","),
    );
    const blob = new Blob(["﻿" + [head, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tradingagents_history.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const clearAll = () => {
    if (!confirm(H.clearConfirm)) return;
    fetch("/api/history", { method: "DELETE" }).then(reload);
  };

  return (
    <div className="panel panel-pad">
      <h3>{H.title}</h3>
      <div className="sub">{H.sub}</div>

      {error && <div className="error-banner">{error}</div>}

      {stats && (
        <div className="levels" style={{ marginBottom: 16 }}>
          <div className="level">
            <div className="k">{H.total}</div>
            <div className="v">{stats.total}</div>
          </div>
          <div className="level tp">
            <div className="k">{H.wins}</div>
            <div className="v">{stats.wins}</div>
          </div>
          <div className="level sl">
            <div className="k">{H.losses}</div>
            <div className="v">{stats.losses}</div>
          </div>
          <div className="level">
            <div className="k">{H.open}</div>
            <div className="v">{stats.openish}</div>
          </div>
          <div className="level entry">
            <div className="k">{H.winRate}</div>
            <div className="v">{stats.winRate != null ? `${stats.winRate.toFixed(0)}%` : "—"}</div>
          </div>
        </div>
      )}

      <div className="plan-actions" style={{ marginTop: 0, marginBottom: 14 }}>
        <button className="rtab on" onClick={evaluate} disabled={evaluating || !items?.length}>
          {evaluating ? H.evaluating : H.evaluate}
        </button>
        <button className="rtab" onClick={exportCsv} disabled={!items?.length}>
          {H.exportCsv}
        </button>
        <button className="rtab" onClick={clearAll} disabled={!items?.length}>
          {H.clear}
        </button>
      </div>

      {items && !items.length && (
        <div className="hint" style={{ padding: "40px 0", textAlign: "center", fontSize: 13 }}>
          {H.empty}
        </div>
      )}

      {items?.length > 0 && (
        <div className="scan-wrap">
          <table className="scan-table hist-table">
            <tbody>
              {items.map((x, idx) => {
                const dir = DIR_OF(x);
                return (
                  // No entrance animation: rows must stay visible even when
                  // animation frames stall (background/headless tabs).
                  <tr key={x.ts + (x.ticker || "") + idx}>
                    <td className="mono">{x.ts}</td>
                    <td className="mono">
                      {x.ticker}
                      {x.source === "scheduler" && (
                        <span className="vbadge mid" style={{ marginInlineStart: 6 }}>{H.scheduled}</span>
                      )}
                    </td>
                    <td>
                      <span className={`vbadge ${dir === "BUY" ? "up" : dir === "SELL" ? "down" : "mid"}`}>
                        {dir}
                      </span>
                    </td>
                    <td className="mono">{fmt(x.signal?.entry)}</td>
                    <td className="mono" style={{ color: "var(--red)" }}>{fmt(x.signal?.stop_loss)}</td>
                    <td className="mono" style={{ color: "var(--green)" }}>
                      {fmt(x.signal?.take_profit_1)} / {fmt(x.signal?.take_profit_2)}
                    </td>
                    <td className="scan-last">{x.model}</td>
                    <td>
                      <span
                        className={`vbadge ${
                          ["tp1", "tp2"].includes(x.outcome) ? "up" : x.outcome === "sl" ? "down" : "mid"
                        }`}
                      >
                        {H.outcome[x.outcome] || H.outcome["?"]}
                      </span>
                    </td>
                    <td>
                      {x.reports && (
                        <button className="rtab" onClick={() => onOpen?.(x)}>
                          {H.openReports}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint" style={{ marginTop: 10 }}>{H.evalNote}</div>
    </div>
  );
}
