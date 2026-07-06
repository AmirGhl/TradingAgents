import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { STRINGS } from "./i18n.js";
import Pipeline from "./components/Pipeline.jsx";
import LiveLog from "./components/LiveLog.jsx";
import SignalCard from "./components/SignalCard.jsx";
import ReportTabs from "./components/ReportTabs.jsx";
import ChartPanel from "./components/ChartPanel.jsx";
import PlanPanel from "./components/PlanPanel.jsx";
import TickerTape from "./components/TickerTape.jsx";
import HistoryPanel from "./components/HistoryPanel.jsx";
import SettingsModal from "./components/SettingsModal.jsx";
import { beep } from "./utils.js";
import { byId as strategyById } from "./strategies.js";

const ANALYST_KEYS = ["market", "social", "news", "fundamentals"];
const TAIL_STAGES = ["research", "trader", "risk", "portfolio"];

// Log-line keywords → pipeline stage (ratchet: a later stage marks earlier done).
const STAGE_SNIFF = [
  ["market", /market[_ ]analyst|market_report/i],
  ["social", /social|sentiment[_ ]analyst|sentiment_report/i],
  ["news", /news[_ ]analyst|news_report/i],
  ["fundamentals", /fundamentals/i],
  ["research", /bull|bear|research[_ ]manager|investment_plan|debate/i],
  ["trader", /\btrader\b/i],
  ["risk", /risky|conservative|neutral|risk[_ ]/i],
  ["portfolio", /portfolio|final_trade_decision/i],
];

const MAX_LOG_LINES = 1200;

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

export default function App() {
  const [lang, setLang] = useState("fa");
  const t = STRINGS[lang];
  useEffect(() => {
    document.documentElement.dir = t.dir;
    document.documentElement.lang = lang;
  }, [lang, t.dir]);

  // ---- server config ----
  const [cfg, setCfg] = useState(null);
  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setCfg).catch(() => {});
  }, []);

  // ---- form state (ticker choice persists across visits) ----
  const [ticker, setTicker] = useState(() => localStorage.getItem("ta_ticker") || "GC=F");
  const [customTicker, setCustomTicker] = useState("");
  useEffect(() => localStorage.setItem("ta_ticker", ticker), [ticker]);
  const [date, setDate] = useState(todayISO());
  const [provider, setProvider] = useState("groq");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [rounds, setRounds] = useState(1);
  const [analysts, setAnalysts] = useState([...ANALYST_KEYS]);
  const [outLang, setOutLang] = useState("Persian");

  const models = cfg?.models?.[provider] || [];
  useEffect(() => {
    setModel((m) => (models.includes(m) ? m : models[0] || ""));
  }, [provider, cfg]); // eslint-disable-line react-hooks/exhaustive-deps

  const keyKnown = cfg?.keys?.[provider];
  const needsKey = provider !== "ollama";

  // ---- run state ----
  const [phase, setPhase] = useState("idle"); // idle | loading | running | done | error
  const [logLines, setLogLines] = useState([]);
  const [stageStatus, setStageStatus] = useState({});
  const [reports, setReports] = useState(null);
  const [decision, setDecision] = useState(null);
  const [signal, setSignal] = useState(null);
  const [spotAdj, setSpotAdj] = useState(null); // {pair, spread} for futures
  const pricesRef = useRef(null);
  const [runError, setRunError] = useState(null);
  const [view, setView] = useState(() => {
    const v = new URLSearchParams(location.search).get("view");
    return ["live", "reports", "chart", "plan", "history"].includes(v) ? v : "live";
  });
  // plan → chart markers; starts on the strategy last picked in the plan tab
  const [chartStrategy, setChartStrategy] = useState(() => {
    const saved = localStorage.getItem("ta_plan_strategy");
    return strategyById(saved) ? saved : null;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [serverDown, setServerDown] = useState(false);
  const wsRef = useRef(null);
  const runTicker = useRef("GC=F");
  // Latest run payload for the auto-saved history entry (state in the ws
  // closure is stale, so mirror it in a ref).
  const runInfoRef = useRef({});

  const activeStages = useMemo(
    () => [...ANALYST_KEYS.filter((a) => analysts.includes(a)), ...TAIL_STAGES],
    [analysts],
  );

  const sniffStage = useCallback((line) => {
    for (let i = STAGE_SNIFF.length - 1; i >= 0; i--) {
      const [key, re] = STAGE_SNIFF[i];
      if (re.test(line)) {
        setStageStatus((prev) => {
          const next = { ...prev, [key]: "run" };
          for (const [k] of STAGE_SNIFF.slice(0, i))
            if (next[k] === "run") next[k] = "done";
          return next;
        });
        return;
      }
    }
  }, []);

  const appendLog = useCallback((text, kind) => {
    setLogLines((prev) => {
      const next = [...prev, { text: text + "\n", kind }];
      return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
    });
  }, []);

  const start = () => {
    const symbol = (customTicker.trim() || ticker).toUpperCase();
    runTicker.current = symbol;
    runInfoRef.current = {
      startedAt: Date.now(), date, provider, model,
      language: outLang, signal: null, decision: null, reports: null,
    };
    if ("Notification" in window && Notification.permission === "default")
      Notification.requestPermission().catch(() => {});
    setPhase("loading");
    setLogLines([]);
    setStageStatus({});
    setReports(null);
    setDecision(null);
    setSignal(null);
    setSpotAdj(null);
    pricesRef.current = null;
    setRunError(null);
    setView("live");

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/run`);
    wsRef.current = ws;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          ticker: symbol,
          date,
          provider,
          model,
          rounds,
          language: outLang,
          analysts,
          apiKey: apiKey || undefined,
        }),
      );
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.type) {
        case "stage":
          if (msg.data === "loading") setPhase("loading");
          if (msg.data === "running") setPhase("running");
          if (msg.data === "done") {
            setPhase("done");
            setStageStatus((prev) => {
              const all = {};
              for (const [k] of STAGE_SNIFF) all[k] = prev[k] ? "done" : prev[k];
              return { ...prev, ...Object.fromEntries(Object.entries(all).filter(([, v]) => v)) };
            });
          }
          appendLog(`── ${msg.data} ──`, "marker");
          break;
        case "log":
          appendLog(msg.data);
          sniffStage(msg.data);
          break;
        case "prices":
          pricesRef.current = msg.data;
          break;
        case "reports":
          setReports(msg.data);
          runInfoRef.current.reports = msg.data;
          break;
        case "decision":
          setDecision(msg.data);
          runInfoRef.current.decision = msg.data;
          break;
        case "signal":
          setSignal(msg.data);
          runInfoRef.current.signal = msg.data;
          // Futures tickers (GC=F/SI=F): convert levels to MT5 spot terms
          // by the live futures-spot spread, like the desktop GUI.
          fetch(`/api/spot?ticker=${encodeURIComponent(runTicker.current)}`)
            .then((r) => r.json())
            .then(({ spot, pair }) => {
              const fl = pricesRef.current?.close?.at(-1);
              if (spot != null && fl != null)
                setSpotAdj({ pair, spread: fl - spot });
              else if (pair) setSpotAdj({ pair, spread: null });
            })
            .catch(() => {});
          break;
        case "error":
          setRunError(String(msg.data));
          setPhase("error");
          appendLog(`✖ ${msg.data}`, "err");
          break;
        case "exit": {
          setPhase((p) => (p === "done" || p === "error" ? p : msg.data === 0 ? "done" : "error"));
          const info = runInfoRef.current;
          if (msg.data === 0 && (info.signal || info.decision != null)) {
            const mins = info.startedAt ? Math.round((Date.now() - info.startedAt) / 60000) : null;
            fetch("/api/history", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ticker: runTicker.current,
                date: info.date,
                decision: String(info.decision ?? info.signal?.direction ?? ""),
                provider: info.provider,
                model: info.model,
                language: info.language,
                duration: mins != null ? `${mins}m` : undefined,
                signal: info.signal,
                reports: info.reports,
              }),
            }).catch(() => {});
            beep();
            if ("Notification" in window && Notification.permission === "granted" && document.hidden)
              new Notification("TradingAgents", {
                body: t.notifDone.replace("{ticker}", runTicker.current),
              });
          }
          break;
        }
        default:
          break;
      }
    };
    ws.onerror = () => {
      setPhase((p) => (p === "done" ? p : "error"));
      setRunError((e) => e || "WebSocket error");
    };
    ws.onclose = () => {
      setPhase((p) => (p === "loading" || p === "running" ? "error" : p));
    };
  };

  const stop = () => {
    wsRef.current?.send(JSON.stringify({ action: "stop" }));
    wsRef.current?.close();
    setPhase("idle");
  };

  const running = phase === "loading" || phase === "running";
  const statusCls = running ? "run" : phase === "done" ? "ok" : phase === "error" ? "err" : "";
  const statusText =
    phase === "idle" ? t.idle : phase === "loading" ? t.loading : phase === "running" ? t.running : phase === "done" ? t.done : t.error;

  const views = [
    ["live", t.viewLive],
    ["plan", t.viewPlan],
    ["chart", t.viewChart],
    ["reports", t.viewReports],
    ["history", t.viewHistory],
  ];

  const activeTicker = customTicker.trim().toUpperCase() || ticker;

  // Keyboard shortcuts: 1-5 switch tabs (ignored while typing in a field).
  useEffect(() => {
    const ids = ["live", "plan", "chart", "reports", "history"];
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest?.("input, select, textarea, [contenteditable]")) return;
      const idx = ["1", "2", "3", "4", "5"].indexOf(e.key);
      if (idx >= 0) setView(ids[idx]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const errHint = useMemo(() => {
    if (!runError) return null;
    const hit = t.errHints.find(([pat]) => runError.includes(pat));
    return hit ? hit[1] : null;
  }, [runError, t]);

  const powerOff = () => {
    if (!confirm(t.powerConfirm)) return;
    fetch("/api/shutdown", { method: "POST" })
      .catch(() => {})
      .finally(() => setServerDown(true));
  };

  const openHistoryEntry = (entry) => {
    setReports(entry.reports || null);
    setSignal(entry.signal || null);
    setDecision(entry.decision ?? null);
    runTicker.current = entry.ticker || runTicker.current;
    setView("reports");
  };

  return (
    <>
      <div className="backdrop" />
      <header className="topbar">
        <div className="brand">
          <span className="logo">TradingAgents</span>
          <span className="tag">{t.tagline}</span>
        </div>
        <div className="spacer" />
        <span className={`status-dot ${statusCls}`}>
          <i />
          {statusText}
        </span>
        <button className="lang-toggle" onClick={() => setHelpOpen(true)} title={t.helpBtn}>
          ؟
        </button>
        <button className="lang-toggle" onClick={() => setSettingsOpen(true)} title={t.settingsBtn}>
          ⚙
        </button>
        <button className="lang-toggle" onClick={() => setLang(lang === "fa" ? "en" : "fa")}>
          {lang === "fa" ? "English" : "فارسی"}
        </button>
        <button className="lang-toggle power" onClick={powerOff} title={t.power}>
          ⏻
        </button>
      </header>

      <TickerTape
        onPick={(sym) => {
          setCustomTicker("");
          setTicker(sym);
        }}
      />

      <div className="shell">
        {/* ---------- sidebar ---------- */}
        <motion.aside
          className="side"
          initial={{ opacity: 0, x: t.dir === "rtl" ? 24 : -24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ type: "spring", stiffness: 90, damping: 18 }}
        >
          <div className="panel panel-pad">
            <h3>{t.configTitle}</h3>
            <div className="sub">{t.configSub}</div>

            <div className="field">
              <label htmlFor="f-ticker">{t.ticker}</label>
              <select id="f-ticker" value={ticker} onChange={(e) => setTicker(e.target.value)}>
                {cfg?.ticker_groups ? (
                  cfg.ticker_groups.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.items.map((tk) => (
                        <option key={tk.symbol} value={tk.symbol}>
                          {tk.symbol} {tk.name ? `— ${tk.name}` : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))
                ) : (
                  (cfg?.tickers || [{ symbol: "GC=F", name: "" }]).map((tk) => (
                    <option key={tk.symbol} value={tk.symbol}>
                      {tk.symbol} {tk.name ? `— ${tk.name}` : ""}
                    </option>
                  ))
                )}
              </select>
              <input
                type="text"
                style={{ marginTop: 8 }}
                placeholder={t.customTicker}
                value={customTicker}
                onChange={(e) => setCustomTicker(e.target.value)}
                dir="ltr"
              />
            </div>

            <div className="row2">
              <div className="field">
                <label htmlFor="f-date">{t.date}</label>
                <input id="f-date" type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} dir="ltr" />
              </div>
              <div className="field">
                <label htmlFor="f-rounds">{t.rounds}</label>
                <select id="f-rounds" value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
                  {[1, 2, 3].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <label htmlFor="f-provider">{t.provider}</label>
              <select id="f-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {(cfg?.providers || []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {lang === "fa" ? p.label_fa : p.label_en}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="f-model">{t.model}</label>
              <select id="f-model" value={model} onChange={(e) => setModel(e.target.value)} dir="ltr">
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            {needsKey && (
              <div className="field">
                <label htmlFor="f-key">{t.apiKey}</label>
                <input
                  id="f-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  dir="ltr"
                  autoComplete="off"
                  placeholder={keyKnown ? "••••••••" : ""}
                />
                <div className="hint">{keyKnown ? t.apiKeyHintSet : t.apiKeyHintUnset}</div>
              </div>
            )}

            <div className="field">
              <label>{t.analysts}</label>
              <div className="chips" role="group" aria-label={t.analysts}>
                {ANALYST_KEYS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={`chip ${analysts.includes(a) ? "on" : ""}`}
                    aria-pressed={analysts.includes(a)}
                    onClick={() =>
                      setAnalysts((prev) =>
                        prev.includes(a)
                          ? prev.length > 1
                            ? prev.filter((x) => x !== a)
                            : prev
                          : [...prev, a],
                      )
                    }
                  >
                    {t.analystNames[a]}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label htmlFor="f-lang">{t.outLang}</label>
              <select id="f-lang" value={outLang} onChange={(e) => setOutLang(e.target.value)}>
                <option value="Persian">فارسی</option>
                <option value="English">English</option>
              </select>
            </div>

            <motion.button
              className={`run-btn ${running ? "stop" : ""}`}
              whileTap={{ scale: 0.97 }}
              onClick={running ? stop : start}
              disabled={!cfg || (!running && !model)}
            >
              {running ? t.stop : t.run}
            </motion.button>
          </div>
        </motion.aside>

        {/* ---------- main ---------- */}
        <main>
          <div className="viewtabs" role="tablist">
            {views.map(([id, label], i) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                className={`viewtab ${view === id ? "on" : ""}`}
                title={`${label} (${i + 1})`}
                onClick={() => setView(id)}
              >
                {view === id && <motion.span layoutId="viewpill" className="pill" transition={{ type: "spring", stiffness: 320, damping: 28 }} />}
                {label}
              </button>
            ))}
          </div>

          {runError && (
            <div className="error-banner">
              ✖ {runError}
              {errHint && <div className="err-hint">💡 {errHint}</div>}
            </div>
          )}

          <AnimatePresence mode="wait">
            {view === "live" && (
              <motion.div key="live" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
                <Pipeline stages={activeStages} statuses={stageStatus} labels={t.stages} />
                {(signal || decision) && (
                  <SignalCard signal={signal} decision={decision} spotAdj={spotAdj} t={t} lang={lang} />
                )}
                <div className="panel panel-pad">
                  <h3>{t.viewLive}</h3>
                  <div className="sub" dir="ltr" style={{ textAlign: t.dir === "rtl" ? "right" : "left" }}>
                    {runTicker.current} · {date}
                  </div>
                  <LiveLog lines={logLines} emptyText={t.logEmpty} running={running} />
                </div>
              </motion.div>
            )}
            {view === "reports" && (
              <motion.div key="reports" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
                <ReportTabs reports={reports} t={t} dir={outLang === "Persian" ? "rtl" : "ltr"} />
              </motion.div>
            )}
            {view === "chart" && (
              <motion.div key="chart" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
                <ChartPanel ticker={activeTicker} signal={signal} t={t} strategyId={chartStrategy} onStrategyChange={setChartStrategy} />
              </motion.div>
            )}
            {view === "plan" && (
              <motion.div key="plan" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
                <PlanPanel
                  ticker={activeTicker}
                  t={t}
                  lang={lang}
                  onShowOnChart={(id) => {
                    setChartStrategy(id);
                    setView("chart");
                  }}
                />
              </motion.div>
            )}
            {view === "history" && (
              <motion.div key="history" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
                <HistoryPanel t={t} onOpen={openHistoryEntry} />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="disclaimer">{t.disclaimer}</div>
        </main>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} t={t} defaultTicker={activeTicker} />

      <AnimatePresence>
        {helpOpen && (
          <motion.div
            className="modal-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setHelpOpen(false)}
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
              aria-label={t.helpTitle}
            >
              <h3>{t.helpTitle}</h3>
              <div className="help-list">
                {t.helpSections.map(([title, body]) => (
                  <div key={title} className="help-item">
                    <div className="help-title">{title}</div>
                    <div className="help-body">{body}</div>
                  </div>
                ))}
              </div>
              <button className="rtab on" style={{ marginTop: 14 }} onClick={() => setHelpOpen(false)}>
                {t.close}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {serverDown && (
        <div className="modal-scrim" style={{ zIndex: 200 }}>
          <div className="modal" dir={t.dir} style={{ maxWidth: 420, textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>⏻</div>
            {t.powerDone}
          </div>
        </div>
      )}
    </>
  );
}
