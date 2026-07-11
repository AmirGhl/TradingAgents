# Contributing to TradingAgents

Thanks for taking the time to contribute. This project is a personal fork of [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents), extending it with a full desktop web UI for Windows + MetaTrader 5 integration. Bug reports and focused pull requests are the most useful contributions.

---

## Dev setup (from source)

**Requirements:** Python 3.10+, Node.js 18+, a MetaTrader 5 terminal (Windows) for live-trading features.

```bash
git clone https://github.com/AmirGhl/TradingAgents.git
cd TradingAgents

# Python — install in editable mode with all extras
pip install -e ".[webui,dev]"

# Frontend
npm --prefix webui/frontend install

# Start the backend server
python -m webui   # → http://127.0.0.1:8420

# In another terminal — start Vite dev server with HMR
npm --prefix webui/frontend run dev   # → http://127.0.0.1:5173
```

The Vite dev server proxies `/api` and `/ws` to port 8420 (see `webui/frontend/vite.config.js`), so you get hot-module-reload while talking to the real backend.

---

## Project layout

```
tradingagents/          AI agent core (LangGraph)
webui/
  server.py             FastAPI backend — all endpoints + background loops
  signal_engine.mjs     Node.js headless signal evaluator (imports strategies.js)
  worker.py             Telegram + MT5 watchdog loops
  frontend/src/
    strategies.js       25 strategy definitions (single source of truth)
    mt5stream.js        WebSocket registry — one shared socket per (ticker, tf)
    livesignal.js       useStrategyLive() hook — shared across Chart and Plan
    components/
      ChartPanel.jsx
      PlanPanel.jsx
      StrategyGauge.jsx
      AutoTrade.jsx
      ArmPanel.jsx
      ScannerPanel.jsx
```

**One source of truth for signals:** `strategies.js` runs in the browser *and* is imported unmodified by `signal_engine.mjs` under Node — so the chart, plan tab, and headless auto-executor can never disagree.

---

## Making changes

### Python (server.py / worker.py)
- All MetaTrader5 calls must be wrapped in `with _MT5_LOCK:` — the MT5 package is not thread-safe.
- Don't add new data paths for the same candle data. One path: `_mt5_snapshot()` → `/ws/mt5` for live streaming, `/api/chart` for initial HTTP load with Yahoo fallback.
- Run `ruff check .` before committing — CI will fail on lint errors.

### JavaScript (strategies.js)
- Adding a new strategy means adding one entry to the `STRATEGIES` array and one `analyze*()` function. The function must return `{ signal, barsSince, strength, last: { entry, sl, tp1, tp2 } }`.
- Run the engine self-test: `node webui/signal_engine.mjs --selftest` (when implemented) to verify the new strategy doesn't crash the headless path.

### Frontend (React)
- `useStrategyLive(ticker, stratId)` is the shared hook. Don't fetch signals anywhere else — adding a second signal source is how chart/plan divergence happens.
- `useBars(ticker, opts)` owns data fetching and WebSocket subscription. Don't call `/api/chart` directly from components.

---

## Running tests

```bash
pytest -q          # Python test suite
ruff check .       # Linter (CI requires this to pass)
```

There is currently no frontend test suite. If you add one, `npm --prefix webui/frontend run test` is the convention.

---

## Pull requests

- Keep PRs focused — one concern per PR.
- For bug fixes: describe the root cause in the PR description, not just the symptom.
- For new features: check the [ideas/](ideas/) folder first — some ideas are pre-planned with context on why a naive approach won't work.
- The CI runs Python tests + ruff lint on every push. PRs must pass CI.
- Don't commit `gui_reports/`, `.env`, `runtime/`, or `release/` — these are gitignored and may contain credentials.

---

## Reporting security issues

Please **do not** open a public issue for vulnerabilities. See [SECURITY.md](SECURITY.md).
