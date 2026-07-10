import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { loadTape, TAPE_DEFAULT, TAPE_LS } from "./TickerTape.jsx";

/** Server-side settings: telegram bot, daily scheduled run, price alerts.
 *  Everything persists in gui_reports/webui_settings.json on the server, so
 *  alerts and the scheduler work even with no browser tab open. */
export default function SettingsModal({ open, onClose, t, defaultTicker }) {
  const C = t.cfgModal;
  const [s, setS] = useState(null); // server settings snapshot
  const [alerts, setAlerts] = useState([]);
  const [lastRun, setLastRun] = useState(null);
  const [saved, setSaved] = useState(false);
  const [tgResult, setTgResult] = useState(null);
  const [mt5Result, setMt5Result] = useState(null);
  const [mt5Lock, setMt5Lock] = useState(null); // /api/mt5/status → lock state
  const [na, setNa] = useState({ ticker: "", op: ">=", price: "" });
  const [tapeText, setTapeText] = useState("");

  // Esc closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setSaved(false);
    setTgResult(null);
    setMt5Result(null);
    setTapeText(loadTape().join(", "));
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setS({
          tg_enabled: !!d.tg_enabled,
          tg_token: d.tg_token || "",
          tg_chat: d.tg_chat || "",
          sched_enabled: !!d.sched_enabled,
          sched_time: d.sched_time || "09:00",
          llm_cache_min: d.llm_cache_min || 0,
          mt5_enabled: !!d.mt5_enabled,
          mt5_login: d.mt5_login || "",
          mt5_password: d.mt5_password || "",
          mt5_server: d.mt5_server || "",
          mt5_lot: d.mt5_lot || 0.01,
          mt5_suffix: d.mt5_suffix || "",
          mt5_guard: !!d.mt5_guard,
          mt5_max_daily_loss: d.mt5_max_daily_loss || 0,
          mt5_trail: !!d.mt5_trail,
          mt5_trail_pct: d.mt5_trail_pct || 0.5,
          mt5_max_ccy: d.mt5_max_ccy || 0,
          mt5_max_streak: d.mt5_max_streak || 0,
          mt5_blackout: d.mt5_blackout || "",
        });
        setAlerts(d.alerts || []);
        setLastRun(d.last_run || null);
        setNa((p) => ({ ...p, ticker: p.ticker || defaultTicker || "" }));
      })
      .catch(() => setS({}));
    fetch("/api/mt5/status")
      .then((r) => r.json())
      .then((d) => setMt5Lock(d.lock || { locked: false }))
      .catch(() => setMt5Lock(null));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const rearm = () =>
    fetch("/api/mt5/rearm", { method: "POST" })
      .then((r) => r.json())
      .then((d) => setMt5Lock(d.lock || { locked: false }))
      .catch(() => {});

  const save = () => {
    const symbols = tapeText
      .split(/[,\s]+/)
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 24);
    localStorage.setItem(TAPE_LS, JSON.stringify(symbols.length ? symbols : TAPE_DEFAULT));
    window.dispatchEvent(new Event("ta_tape_changed"));
    return fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }).then(() => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  const testTelegram = () => {
    setTgResult("…");
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    })
      .then(() =>
        fetch("/api/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "✅ TradingAgents — تست اتصال تلگرام" }),
        }),
      )
      .then((r) => r.json())
      .then((d) => setTgResult(d.ok ? "ok" : d.error || "fail"))
      .catch((e) => setTgResult(String(e)));
  };

  const testMt5 = () => {
    setMt5Result("…");
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    })
      .then(() => fetch("/api/mt5/status"))
      .then((r) => r.json())
      .then((d) =>
        setMt5Result(
          d.connected
            ? `ok:#${d.account.login} · ${d.account.balance} ${d.account.currency}`
            : d.error || "fail",
        ),
      )
      .catch((e) => setMt5Result(String(e)));
  };

  const addAlert = () => {
    if (!na.ticker.trim() || !na.price) return;
    fetch("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: na.ticker.trim(), op: na.op, price: Number(na.price) }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.alerts) setAlerts(d.alerts);
        setNa((p) => ({ ...p, price: "" }));
      });
  };

  const delAlert = (id) =>
    fetch(`/api/alerts/${id}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => d.alerts && setAlerts(d.alerts));

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
            className="modal"
            dir={t.dir}
            initial={{ opacity: 0, y: 30, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 220, damping: 22 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={C.title}
          >
            <h3>{C.title}</h3>

            {!s ? (
              <div className="plan-loading">⏳</div>
            ) : (
              <>
                {/* telegram */}
                <div className="set-sect">
                  <div className="plan-h">📨 {C.telegram}</div>
                  <label className={`check-item ${s.tg_enabled ? "ok" : ""}`}>
                    <input
                      type="checkbox"
                      checked={s.tg_enabled}
                      onChange={(e) => setS({ ...s, tg_enabled: e.target.checked })}
                    />
                    <span className="box">{s.tg_enabled ? "✓" : ""}</span>
                    {C.tgEnable}
                  </label>
                  <div className="row2" style={{ marginTop: 10 }}>
                    <div className="field">
                      <label>{C.tgToken}</label>
                      <input
                        type="password"
                        value={s.tg_token}
                        dir="ltr"
                        autoComplete="off"
                        onChange={(e) => setS({ ...s, tg_token: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label>{C.tgChat}</label>
                      <input
                        type="text"
                        value={s.tg_chat}
                        dir="ltr"
                        onChange={(e) => setS({ ...s, tg_chat: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="plan-actions" style={{ marginTop: 4 }}>
                    <button className="rtab" onClick={testTelegram} disabled={!s.tg_token || !s.tg_chat}>
                      {C.tgTest}
                    </button>
                    {tgResult && (
                      <span className={`hint ${tgResult === "ok" ? "" : ""}`}
                            style={{ color: tgResult === "ok" ? "var(--green)" : tgResult === "…" ? "var(--muted)" : "var(--red)" }}>
                        {tgResult === "ok" ? C.tgOk : tgResult === "…" ? "…" : `${C.tgFail}: ${tgResult}`}
                      </span>
                    )}
                  </div>
                </div>

                {/* scheduler */}
                <div className="set-sect">
                  <div className="plan-h">🤖 {C.sched}</div>
                  <label className={`check-item ${s.sched_enabled ? "ok" : ""}`}>
                    <input
                      type="checkbox"
                      checked={s.sched_enabled}
                      onChange={(e) => setS({ ...s, sched_enabled: e.target.checked })}
                    />
                    <span className="box">{s.sched_enabled ? "✓" : ""}</span>
                    {C.schedEnable}
                  </label>
                  <div className="field" style={{ marginTop: 10, maxWidth: 200 }}>
                    <label>{C.schedTime}</label>
                    <input
                      type="time"
                      value={s.sched_time}
                      dir="ltr"
                      onChange={(e) => setS({ ...s, sched_time: e.target.value })}
                    />
                  </div>
                  <div className="hint">
                    {C.schedHint}
                    <br />
                    {lastRun ? (
                      <span dir="ltr" style={{ fontFamily: "var(--font-mono)" }}>
                        {C.schedLast} {lastRun.ticker} · {lastRun.provider}/{lastRun.model}
                      </span>
                    ) : (
                      <b>{C.schedNone}</b>
                    )}
                  </div>
                  <div className="field" style={{ marginTop: 12, maxWidth: 260 }}>
                    <label>{C.llmCache}</label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={s.llm_cache_min}
                      dir="ltr"
                      onChange={(e) => setS({ ...s, llm_cache_min: Number(e.target.value) })}
                    />
                    <div className="hint">{C.llmCacheHint}</div>
                  </div>
                </div>

                {/* MT5 auto-trade account */}
                <div className="set-sect">
                  <div className="plan-h">🤖 {C.mt5}</div>
                  <label className={`check-item ${s.mt5_enabled ? "ok" : ""}`}>
                    <input
                      type="checkbox"
                      checked={s.mt5_enabled}
                      onChange={(e) => setS({ ...s, mt5_enabled: e.target.checked })}
                    />
                    <span className="box">{s.mt5_enabled ? "✓" : ""}</span>
                    {C.mt5Enable}
                  </label>
                  <div className="row2" style={{ marginTop: 10 }}>
                    <div className="field">
                      <label>{C.mt5Login}</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={s.mt5_login}
                        dir="ltr"
                        autoComplete="off"
                        onChange={(e) => setS({ ...s, mt5_login: e.target.value.replace(/\D/g, "") })}
                      />
                    </div>
                    <div className="field">
                      <label>{C.mt5Password}</label>
                      <input
                        type="password"
                        value={s.mt5_password}
                        dir="ltr"
                        autoComplete="off"
                        onChange={(e) => setS({ ...s, mt5_password: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="row2">
                    <div className="field">
                      <label>{C.mt5Server}</label>
                      <input
                        type="text"
                        value={s.mt5_server}
                        dir="ltr"
                        placeholder="e.g. Exness-MT5Trial8"
                        onChange={(e) => setS({ ...s, mt5_server: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label>{C.mt5Lot}</label>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={s.mt5_lot}
                        dir="ltr"
                        onChange={(e) => setS({ ...s, mt5_lot: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                  <div className="field" style={{ maxWidth: 240 }}>
                    <label>{C.mt5Suffix}</label>
                    <input
                      type="text"
                      value={s.mt5_suffix}
                      dir="ltr"
                      placeholder=".m / .pro / c …"
                      onChange={(e) => setS({ ...s, mt5_suffix: e.target.value.trim() })}
                    />
                  </div>
                  <div className="plan-actions" style={{ marginTop: 4 }}>
                    <button
                      className="rtab"
                      onClick={testMt5}
                      disabled={!s.mt5_login || !s.mt5_server}
                    >
                      {C.mt5Test}
                    </button>
                    {mt5Result && (
                      <span
                        className="hint"
                        dir="ltr"
                        style={{
                          color: mt5Result.startsWith("ok:")
                            ? "var(--green)"
                            : mt5Result === "…"
                              ? "var(--muted)"
                              : "var(--red)",
                        }}
                      >
                        {mt5Result.startsWith("ok:")
                          ? `${C.mt5Ok} ${mt5Result.slice(3)}`
                          : mt5Result === "…"
                            ? "…"
                            : `${C.mt5Fail}: ${mt5Result}`}
                      </span>
                    )}
                  </div>
                  <div className="hint" style={{ marginTop: 6 }}>{C.mt5Hint}</div>

                  {/* safety guard / kill-switch */}
                  <div className="plan-h" style={{ marginTop: 16 }}>🛡 {C.guard}</div>
                  <label className={`check-item ${s.mt5_guard ? "ok" : ""}`}>
                    <input
                      type="checkbox"
                      checked={s.mt5_guard}
                      onChange={(e) => setS({ ...s, mt5_guard: e.target.checked })}
                    />
                    <span className="box">{s.mt5_guard ? "✓" : ""}</span>
                    {C.guardEnable}
                  </label>
                  <div className="hint" style={{ marginBottom: 8 }}>{C.guardEnableHint}</div>
                  <div className="row2">
                    <div className="field">
                      <label>{C.guardMaxLoss}</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={s.mt5_max_daily_loss}
                        dir="ltr"
                        onChange={(e) => setS({ ...s, mt5_max_daily_loss: Number(e.target.value) })}
                      />
                      <div className="hint">{C.guardMaxLossHint}</div>
                    </div>
                    <div className="field">
                      <label>{C.guardMaxCcy}</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={s.mt5_max_ccy}
                        dir="ltr"
                        onChange={(e) => setS({ ...s, mt5_max_ccy: Number(e.target.value) })}
                      />
                      <div className="hint">{C.guardMaxCcyHint}</div>
                    </div>
                  </div>
                  <label className={`check-item ${s.mt5_trail ? "ok" : ""}`} style={{ marginTop: 10 }}>
                    <input
                      type="checkbox"
                      checked={s.mt5_trail}
                      onChange={(e) => setS({ ...s, mt5_trail: e.target.checked })}
                    />
                    <span className="box">{s.mt5_trail ? "✓" : ""}</span>
                    {C.trailEnable}
                  </label>
                  <div className="hint" style={{ marginBottom: 8 }}>{C.trailEnableHint}</div>
                  <div className="field" style={{ marginTop: 10, maxWidth: 340 }}>
                    <label>{C.trailPct}</label>
                    <input
                      type="number"
                      min="0"
                      step="0.05"
                      value={s.mt5_trail_pct}
                      dir="ltr"
                      onChange={(e) => setS({ ...s, mt5_trail_pct: Number(e.target.value) })}
                    />
                    <div className="hint">{C.trailPctHint}</div>
                  </div>
                  <div className="row2">
                    <div className="field">
                      <label>{C.guardStreak}</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={s.mt5_max_streak}
                        dir="ltr"
                        onChange={(e) => setS({ ...s, mt5_max_streak: Number(e.target.value) })}
                      />
                      <div className="hint">{C.guardStreakHint}</div>
                    </div>
                    <div className="field">
                      <label>{C.guardBlackout}</label>
                      <input
                        type="text"
                        value={s.mt5_blackout}
                        dir="ltr"
                        placeholder="15:00-15:15, 21:30-22:00"
                        onChange={(e) => setS({ ...s, mt5_blackout: e.target.value })}
                      />
                      <div className="hint">{C.guardBlackoutHint}</div>
                    </div>
                  </div>
                  {mt5Lock && (
                    <div className="plan-actions" style={{ marginTop: 8, alignItems: "center" }}>
                      <span className="hint">
                        {C.guardStatus}{" "}
                        <b style={{ color: mt5Lock.locked ? "var(--red)" : "var(--green)" }}>
                          {mt5Lock.locked ? C.guardLocked : C.guardUnlocked}
                        </b>
                        {mt5Lock.locked && mt5Lock.detail ? ` — ${mt5Lock.detail}` : ""}
                      </span>
                      {mt5Lock.locked && (
                        <button className="rtab" onClick={rearm}>{C.guardRearm}</button>
                      )}
                    </div>
                  )}
                  <div className="hint" style={{ marginTop: 6 }}>{C.guardStatusHint}</div>
                  <div className="hint" style={{ marginTop: 6 }}>{C.guardHint}</div>
                </div>

                {/* price alerts */}
                <div className="set-sect">
                  <div className="plan-h">⏰ {C.alerts}</div>
                  <div className="hint" style={{ marginBottom: 10 }}>{C.alertHint}</div>
                  <div className="alert-add" dir="ltr">
                    <input
                      type="text"
                      placeholder={C.alertTicker}
                      value={na.ticker}
                      onChange={(e) => setNa({ ...na, ticker: e.target.value.toUpperCase() })}
                      style={{ width: 110 }}
                    />
                    <select value={na.op} onChange={(e) => setNa({ ...na, op: e.target.value })}>
                      <option value=">=">{C.alertAbove}</option>
                      <option value="<=">{C.alertBelow}</option>
                    </select>
                    <input
                      type="number"
                      placeholder={C.alertPrice}
                      value={na.price}
                      onChange={(e) => setNa({ ...na, price: e.target.value })}
                      style={{ width: 120 }}
                    />
                    <button className="rtab on" onClick={addAlert}>{C.alertAdd}</button>
                  </div>
                  {!alerts.length && <div className="hint" style={{ marginTop: 8 }}>{C.alertEmpty}</div>}
                  {alerts.length > 0 && (
                    <div className="alert-list">
                      {alerts.map((a) => (
                        <div key={a.id} className={`alert-row ${a.active ? "" : "fired"}`} dir="ltr">
                          <span className="mono">{a.ticker}</span>
                          <span className="mono">{a.op} {a.price}</span>
                          {a.active ? (
                            <span className="vbadge mid">⏳</span>
                          ) : (
                            <span className="vbadge up">
                              {C.alertTriggered} {a.triggered_price} · {a.triggered_at}
                            </span>
                          )}
                          <span style={{ flex: 1 }} />
                          <button className="rtab" onClick={() => delAlert(a.id)}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ticker tape watchlist (local to this browser) */}
                <div className="set-sect">
                  <div className="plan-h">📜 {C.tape}</div>
                  <div className="hint" style={{ marginBottom: 8 }}>{C.tapeHint}</div>
                  <div className="field">
                    <input
                      type="text"
                      value={tapeText}
                      dir="ltr"
                      onChange={(e) => setTapeText(e.target.value)}
                      placeholder="GC=F, BTC-USD, EURUSD, US30, NVDA…"
                    />
                  </div>
                  <button className="rtab" onClick={() => setTapeText(TAPE_DEFAULT.join(", "))}>
                    {C.tapeReset}
                  </button>
                </div>

                <div className="plan-actions" style={{ marginTop: 18 }}>
                  <button className="rtab on" onClick={save}>{saved ? C.saved : C.save}</button>
                  <button className="rtab" onClick={onClose}>{C.close}</button>
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
