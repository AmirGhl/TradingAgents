"""TradingAgents Web UI — FastAPI backend.

Serves the built React frontend from webui/static and bridges the browser to
webui/worker.py: one WebSocket per analysis run, streaming the worker's
@@-marker protocol as typed JSON messages. Run from the project venv:

    venv\\Scripts\\python -m webui          (Windows)
    venv/bin/python -m webui                (POSIX)

Persistent data lives in gui_reports/: webui_history.json (past signals),
webui_settings.json (telegram / scheduler / alerts / last run config).
"""

import asyncio
import json
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

PROJECT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
WORKER_PATH = Path(__file__).resolve().parent / "worker.py"
DATA_DIR = PROJECT_DIR / "gui_reports"
HISTORY_PATH = DATA_DIR / "webui_history.json"
SETTINGS_PATH = DATA_DIR / "webui_settings.json"
SHADOW_PATH = DATA_DIR / "webui_shadow.json"
ENGINE_PATH = Path(__file__).resolve().parent / "signal_engine.mjs"
OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434").removesuffix("/v1")

# Mirrors the desktop GUI's catalog (tradingagents_gui.py).
PROVIDERS = [
    {"id": "ollama", "label_fa": "Ollama (رایگان، محلی)", "label_en": "Ollama (free, local)"},
    {"id": "anthropic", "label_fa": "Claude (Anthropic)", "label_en": "Claude (Anthropic)"},
    {"id": "groq", "label_fa": "Groq (ابری، سریع)", "label_en": "Groq (cloud, fast)"},
    {"id": "openrouter", "label_fa": "OpenRouter (مدل‌های رایگان)", "label_en": "OpenRouter (free models)"},
]
MODELS = {
    "anthropic": [
        "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5",
        "claude-opus-4-7", "claude-sonnet-4-6",
    ],
    "groq": [
        "meta-llama/llama-4-scout-17b-16e-instruct", "openai/gpt-oss-120b",
        "openai/gpt-oss-20b", "qwen/qwen3.6-27b", "qwen/qwen3-32b",
        "llama-3.3-70b-versatile",
    ],
    "openrouter": [
        "nvidia/nemotron-3-super-120b-a12b:free", "openrouter/free",
        "openai/gpt-oss-120b:free", "meta-llama/llama-3.3-70b-instruct:free",
        "qwen/qwen3-coder:free", "nvidia/nemotron-3-ultra-550b-a55b:free",
    ],
    "ollama": ["qwen2.5:7b"],
}
PROVIDER_ENV = {"anthropic": "ANTHROPIC_API_KEY", "groq": "GROQ_API_KEY",
                "openrouter": "OPENROUTER_API_KEY"}
# Full symbol catalog, grouped for the UI. Persian labels; yfinance symbols.
TICKER_GROUPS = [
    ("فلزات گران‌بها", [
        ("GC=F", "انس جهانی طلا XAUUSD"), ("SI=F", "انس جهانی نقره XAGUSD"),
        ("PL=F", "پلاتین XPTUSD"), ("PA=F", "پالادیوم XPDUSD"),
        ("HG=F", "مس"), ("GLD", "صندوق طلا GLD"), ("SLV", "صندوق نقره SLV"),
        ("GDX", "معدن‌کاران طلا"), ("SIL", "معدن‌کاران نقره"),
    ]),
    ("انرژی و کالاها", [
        ("CL=F", "نفت WTI"), ("BZ=F", "نفت برنت"), ("NG=F", "گاز طبیعی"),
        ("ZC=F", "ذرت"), ("ZW=F", "گندم"), ("ZS=F", "سویا"),
        ("KC=F", "قهوه"), ("SB=F", "شکر"), ("CC=F", "کاکائو"), ("CT=F", "پنبه"),
    ]),
    ("فارکس", [
        ("EURUSD=X", "یورو / دلار"), ("GBPUSD=X", "پوند / دلار"),
        ("USDJPY=X", "دلار / ین"), ("USDCHF=X", "دلار / فرانک"),
        ("AUDUSD=X", "دلار استرالیا"), ("NZDUSD=X", "دلار نیوزیلند"),
        ("USDCAD=X", "دلار / دلار کانادا"), ("EURGBP=X", "یورو / پوند"),
        ("EURJPY=X", "یورو / ین"), ("GBPJPY=X", "پوند / ین"),
        ("AUDJPY=X", "استرالیا / ین"), ("EURCHF=X", "یورو / فرانک"),
        ("USDTRY=X", "دلار / لیر"), ("DX-Y.NYB", "شاخص دلار DXY"),
    ]),
    ("کریپتو", [
        ("BTC-USD", "بیت‌کوین"), ("ETH-USD", "اتریوم"), ("BNB-USD", "بایننس‌کوین"),
        ("SOL-USD", "سولانا"), ("XRP-USD", "ریپل"), ("ADA-USD", "کاردانو"),
        ("DOGE-USD", "دوج‌کوین"), ("AVAX-USD", "آوالانچ"), ("DOT-USD", "پولکادات"),
        ("LINK-USD", "چین‌لینک"), ("LTC-USD", "لایت‌کوین"), ("TRX-USD", "ترون"),
        ("SHIB-USD", "شیبا"), ("TON11419-USD", "تون‌کوین"),
    ]),
    ("شاخص‌ها", [
        ("^GSPC", "S&P 500"), ("^NDX", "نزدک ۱۰۰"), ("^DJI", "داوجونز"),
        ("^RUT", "راسل ۲۰۰۰"), ("^VIX", "شاخص ترس VIX"),
        ("^GDAXI", "دکس آلمان"), ("^FTSE", "فوتسی انگلیس"),
        ("^N225", "نیکی ژاپن"), ("^HSI", "هنگ‌سنگ"), ("^STOXX50E", "یورو استاکس ۵۰"),
    ]),
    ("صندوق‌ها (ETF)", [
        ("SPY", "S&P 500 ETF"), ("QQQ", "نزدک ۱۰۰ ETF"), ("DIA", "داوجونز ETF"),
        ("IWM", "راسل ETF"), ("USO", "نفت ETF"), ("TLT", "اوراق ۲۰ ساله"),
        ("ARKK", "ARK نوآوری"), ("XLF", "بخش مالی"), ("XLE", "بخش انرژی"),
        ("SMH", "نیمه‌هادی‌ها"),
    ]),
    ("سهام — تکنولوژی", [
        ("AAPL", "اپل"), ("MSFT", "مایکروسافت"), ("NVDA", "انویدیا"),
        ("GOOGL", "گوگل / آلفابت"), ("AMZN", "آمازون"), ("META", "متا"),
        ("TSLA", "تسلا"), ("AMD", "ای‌ام‌دی"), ("NFLX", "نتفلیکس"),
        ("INTC", "اینتل"), ("AVGO", "برادکام"), ("ORCL", "اوراکل"),
        ("CRM", "سیلزفورس"), ("ADBE", "ادوبی"), ("QCOM", "کوالکام"),
        ("MU", "میکرون"), ("PLTR", "پلنتیر"), ("COIN", "کوین‌بیس"),
        ("UBER", "اوبر"), ("SHOP", "شاپیفای"), ("SNOW", "اسنوفلیک"),
        ("SMCI", "سوپرمیکرو"), ("ARM", "آرم"), ("MSTR", "مایکرواستراتژی"),
        ("HOOD", "رابین‌هود"), ("BABA", "علی‌بابا"),
    ]),
    ("سهام — سایر", [
        ("JPM", "جی‌پی‌مورگان"), ("BAC", "بانک‌آوامریکا"), ("V", "ویزا"),
        ("MA", "مسترکارت"), ("KO", "کوکاکولا"), ("PEP", "پپسی"),
        ("MCD", "مک‌دونالد"), ("DIS", "دیزنی"), ("BA", "بوئینگ"),
        ("XOM", "اکسون‌موبیل"), ("CVX", "شورون"), ("PFE", "فایزر"),
        ("JNJ", "جانسون‌اندجانسون"), ("LLY", "الی‌لیلی"), ("UNH", "یونایتدهلث"),
        ("WMT", "والمارت"), ("COST", "کاست‌کو"), ("NKE", "نایکی"),
        ("SBUX", "استارباکس"), ("GE", "جنرال‌الکتریک"), ("F", "فورد"),
        ("GM", "جنرال‌موتورز"),
    ]),
]
TICKERS = [(s, n) for _, items in TICKER_GROUPS for s, n in items]

# Broker/MT5-style names → yfinance symbols.
TICKER_ALIASES = {
    "XAUUSD": "GC=F", "XAU": "GC=F", "GOLD": "GC=F",
    "XAGUSD": "SI=F", "XAG": "SI=F", "SILVER": "SI=F",
    "XPTUSD": "PL=F", "XPT": "PL=F", "PLATINUM": "PL=F",
    "XPDUSD": "PA=F", "XPD": "PA=F", "PALLADIUM": "PA=F",
    "COPPER": "HG=F", "USOIL": "CL=F", "WTI": "CL=F", "OIL": "CL=F",
    "UKOIL": "BZ=F", "BRENT": "BZ=F", "NATGAS": "NG=F", "NGAS": "NG=F",
    "US30": "^DJI", "DJ30": "^DJI", "DOW": "^DJI",
    "US500": "^GSPC", "SPX": "^GSPC", "SP500": "^GSPC",
    "NAS100": "^NDX", "USTEC": "^NDX", "NDX": "^NDX", "US100": "^NDX",
    "US2000": "^RUT", "GER40": "^GDAXI", "GER30": "^GDAXI", "DAX": "^GDAXI",
    "UK100": "^FTSE", "FTSE": "^FTSE", "JPN225": "^N225", "JP225": "^N225",
    "NIKKEI": "^N225", "HK50": "^HSI", "EUSTX50": "^STOXX50E",
    "DXY": "DX-Y.NYB", "USDX": "DX-Y.NYB", "VIX": "^VIX",
    "TON": "TON11419-USD", "TONUSD": "TON11419-USD",
}
_FIAT = {"USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "TRY",
         "SEK", "NOK", "DKK", "SGD", "HKD", "CNH", "CNY", "MXN", "ZAR", "PLN"}
_CRYPTO = {"BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT",
           "LINK", "LTC", "TRX", "SHIB", "PEPE", "UNI", "ATOM", "XLM", "NEAR",
           "APT", "ARB", "OP", "FIL", "ICP", "ETC", "BCH", "SUI", "RENDER"}
# Futures ticker → (gold-api symbol, MT5 pair). COMEX futures trade at a
# premium over spot, so signals get a spot-adjusted copy (same as the GUI).
SPOT_MAP = {"GC=F": ("XAU", "XAUUSD"), "SI=F": ("XAG", "XAGUSD"),
            "PL=F": ("XPT", "XPTUSD"), "PA=F": ("XPD", "XPDUSD")}


def broker_names(ticker):
    """Ordered candidate MetaTrader symbol names for a UI/yfinance ticker.

    The broker may add a suffix (XAUUSD.m, EURUSD.pro …) — ``_mt5_resolve_symbol``
    handles that and a prefix match. Mirrors the frontend ``brokerSymbol``:
    metals map via SPOT_MAP (GC=F→XAUUSD), FX drop the ``=X`` (EURUSD=X→EURUSD),
    crypto join the pair (BTC-USD→BTCUSD/BTCUSDT), everything else strips the
    Yahoo punctuation (^GSPC→GSPC, AAPL→AAPL)."""
    norm = normalize_ticker(ticker)
    up = (ticker or "").strip().upper()
    out = []
    entry = SPOT_MAP.get(norm)
    if entry:
        out.append(entry[1])  # XAUUSD / XAGUSD / …
    if up.endswith("=X"):
        out.append(up[:-2])
    elif up.endswith("-USD"):
        out.append(up[:-4] + "USD")
        out.append(up[:-4] + "USDT")
    stripped = re.sub(r"[=^.\-]", "", up)
    for cand in (stripped, up):
        if cand:
            out.append(cand)
    seen, res = set(), []
    for cand in out:
        if cand and cand not in seen:
            seen.add(cand)
            res.append(cand)
    return res


app = FastAPI(title="TradingAgents Web UI")


def read_dotenv():
    """Best-effort parse of the project .env (never returned to the client)."""
    env = {}
    try:
        for line in (PROJECT_DIR / ".env").read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


def worker_python():
    # Portable runtime/ first (self-contained folder copies), then the venv.
    for cand in (PROJECT_DIR / "runtime" / "python.exe",
                 PROJECT_DIR / "venv" / "Scripts" / "python.exe",
                 PROJECT_DIR / "venv" / "bin" / "python"):
        if cand.exists():
            return str(cand)
    return sys.executable


def normalize_ticker(t):
    """Map broker-style names (EURUSD, BTCUSD, US30 …) to yfinance symbols."""
    t = (t or "").strip().upper()
    if t in TICKER_ALIASES:
        return TICKER_ALIASES[t]
    known = {s for s, _ in TICKERS}
    if t in known or "=" in t or "-" in t or t.startswith("^"):
        return t
    # Crypto pairs: BTCUSD / BTCUSDT → BTC-USD
    for quote in ("USDT", "USD"):
        if t.endswith(quote) and t[:-len(quote)] in _CRYPTO:
            return f"{t[:-len(quote)]}-USD"
    if t in _CRYPTO:
        return f"{t}-USD"
    # Forex pairs: EURUSD → EURUSD=X
    if len(t) == 6 and t[:3] in _FIAT and t[3:] in _FIAT:
        return f"{t}=X"
    return t


def _probe_ollama():
    """Blocking Ollama probe — must run in a thread, never on the loop."""
    try:
        import urllib.request

        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=2) as r:
            data = json.load(r)
            return sorted(m["name"] for m in data.get("models", [])), True
    except Exception:
        return [], False


@app.get("/api/config")
async def get_config():
    dotenv = read_dotenv()
    keys = {p: bool(os.environ.get(env) or dotenv.get(env))
            for p, env in PROVIDER_ENV.items()}
    ollama_models, ollama_up = await asyncio.to_thread(_probe_ollama)
    return {
        "providers": PROVIDERS,
        "models": {**MODELS, "ollama": ollama_models or MODELS["ollama"]},
        "keys": keys,
        "ollama_up": ollama_up,
        "tickers": [{"symbol": s, "name": n} for s, n in TICKERS],
        "ticker_groups": [
            {"group": g, "items": [{"symbol": s, "name": n} for s, n in items]}
            for g, items in TICKER_GROUPS
        ],
    }


# ---- market data: tiny TTL cache + retry so aggressive polling and Yahoo's
# rate limiter stop blanking the UI. A single failed/empty fetch otherwise
# empties a chart or the whole ticker tape; here repeated polls within `ttl`
# reuse the cached frame, and a transient failure serves the last good one. ----

_HIST_CACHE = {}  # (sym, period, interval) -> (fetched_at, dataframe)


def _yf_history(sym, period, interval, ttl, retries=2):
    """Cached ``yfinance`` history with retry and stale-on-error fallback.

    Always returns a DataFrame (possibly empty). Runs in a worker thread, so
    the short ``time.sleep`` backoff between retries does not block the loop.
    """
    import pandas as pd
    import yfinance as yf

    # A pure-digit symbol is an account number typed by mistake (e.g. an MT5
    # login) — never a Yahoo ticker. Refuse it here so no endpoint (chart,
    # tape, spot) can hammer Yahoo with a request that can never resolve.
    if sym and sym.isdigit() and len(sym) >= 5:
        return pd.DataFrame()

    key = (sym, period, interval)
    now = time.time()
    cached = _HIST_CACHE.get(key)
    if cached and now - cached[0] < ttl:
        return cached[1]

    last = None
    for attempt in range(retries):
        try:
            hist = yf.Ticker(sym).history(period=period, interval=interval)
            last = hist
            if len(hist):
                _HIST_CACHE[key] = (now, hist)
                return hist
        except Exception:  # network / rate-limit / parse — retry, then fall back
            pass
        if attempt < retries - 1:  # no trailing sleep after the last try
            time.sleep(0.35)

    if cached:  # transient failure: better a few-seconds-stale frame than blank
        return cached[1]
    if last is not None:
        return last
    import pandas as pd

    return pd.DataFrame()


# yfinance range/interval → an equivalent MetaTrader candle count, so the
# unified /api/chart can serve the same window from the broker feed.
_RANGE_DAYS = {"1d": 1, "5d": 5, "1mo": 30, "3mo": 90, "6mo": 180,
               "1y": 365, "2y": 730, "5y": 1825, "10y": 3650, "max": 3650}
_INTERVAL_S = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800,
               "1h": 3600, "4h": 14400, "1d": 86400, "1wk": 604800}


def _mt5_count_for(range_, interval):
    days = _RANGE_DAYS.get(range_, 180)
    step = _INTERVAL_S.get(interval, 86400)
    return max(60, min(2000, int(days * 86400 / step)))


@app.get("/api/chart")
async def get_chart(ticker: str, range: str = "6mo", interval: str = "1d"):
    """OHLCV series for lightweight-charts (unix seconds).

    ONE market-data door for every consumer (chart, plan, scanner, MTF strip):
    when the MetaTrader terminal is open and knows the symbol, candles + the
    live tick come straight from the broker (`source:"mt5"`, tick-rolled last
    bar, clean `display` name); otherwise the yfinance path (`source:"yahoo"`)."""
    ticker = normalize_ticker(ticker)
    # A pure-digit "symbol" is almost always an account number typed into the
    # ticker box by mistake (e.g. an MT5 login) — reject it before hammering
    # Yahoo with a request that can never resolve.
    if ticker.isdigit() and len(ticker) >= 5:
        return JSONResponse(
            {"error": f"'{ticker}' looks like an account number, not a symbol"},
            status_code=400,
        )

    md = await asyncio.to_thread(_mt5_candles, ticker, interval,
                                 _mt5_count_for(range, interval))
    if md.get("ok") and md.get("bars"):
        return {"ticker": ticker, "bars": md["bars"], "source": "mt5",
                "symbol": md.get("symbol"), "display": md.get("display"),
                "digits": md.get("digits"), "tick": md.get("tick")}

    def fetch():
        # Fresher cache on the 1-minute chart so the live candle actually moves.
        ttl = 4 if interval == "1m" else 8
        hist = _yf_history(ticker, range, interval, ttl=ttl)
        return [
            {
                "time": int(idx.timestamp()),
                "open": round(float(row["Open"]), 4),
                "high": round(float(row["High"]), 4),
                "low": round(float(row["Low"]), 4),
                "close": round(float(row["Close"]), 4),
                "volume": int(row["Volume"]),
            }
            for idx, row in hist.iterrows()
        ]

    try:
        bars = await asyncio.to_thread(fetch)
        return {"ticker": ticker, "bars": bars, "source": "yahoo"}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


def _mt5_prices(symbols):
    """Live tick mids from the open MetaTrader terminal for every UI ticker it
    knows, {ticker: price}. Empty dict when MT5 is off/closed — callers fall
    back to yfinance per missing symbol."""
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {}
    mt5, err = _mt5_md_connect(s)
    if err:
        return {}
    out = {}
    with _MT5_LOCK:
        for sym in symbols:
            try:
                name = _resolve_broker_symbol(mt5, sym, s.get("mt5_suffix") or "")
                if not name:
                    continue
                info = mt5.symbol_info(name)
                tick = _mt5_tick_dict(mt5.symbol_info_tick(name),
                                      info.digits if info else 5)
                if tick:
                    out[sym] = tick["mid"]
            except Exception:
                pass
    return out


@app.get("/api/price")
async def get_price(tickers: str):
    # Keyed by the raw requested token so alias symbols (EURUSD, US30 …)
    # round-trip for the client.
    pairs = [(t.strip().upper(), normalize_ticker(t))
             for t in tickers.split(",") if t.strip()]

    def fetch():
        # Broker-first: live ticks from the open terminal, yfinance for the rest.
        live = _mt5_prices([raw for raw, _ in pairs])
        out = {}
        cache = {}
        for raw, sym in pairs:
            if raw in live:
                out[raw] = live[raw]
                continue
            try:
                if sym not in cache:
                    hist = _yf_history(sym, "1d", "1m", ttl=30)
                    if len(hist) == 0:
                        hist = _yf_history(sym, "5d", "1d", ttl=90)
                    cache[sym] = round(float(hist["Close"].iloc[-1]), 4) if len(hist) else None
                if cache[sym] is not None:
                    out[raw] = cache[sym]
            except Exception:
                pass
        return out

    return await asyncio.to_thread(fetch)


@app.get("/api/spot")
async def get_spot(ticker: str):
    """Live spot price for futures tickers (gold-api.com), or null."""
    entry = SPOT_MAP.get(normalize_ticker(ticker))
    if not entry:
        return {"spot": None}
    metal, pair = entry

    def fetch():
        import urllib.request

        with urllib.request.urlopen(f"https://api.gold-api.com/price/{metal}",
                                    timeout=6) as r:
            return float(json.load(r)["price"])

    try:
        spot = await asyncio.to_thread(fetch)
        return {"spot": spot, "pair": pair}
    except Exception:
        return {"spot": None, "pair": pair}


@app.get("/api/quote")
async def get_quote(ticker: str):
    """Freshest current price for the YFINANCE fallback only: gold-api spot for
    metals plus the last 1m close on a short cache. When MetaTrader is open the
    UI never calls this — the tick rides the /ws/mt5 stream alongside the
    candles, from one source, so the two can't disagree."""
    raw = (ticker or "").strip().upper()
    norm = normalize_ticker(ticker)

    def fetch():
        out = {"ticker": raw, "symbol": norm, "price": None, "spot": None,
               "pair": None, "source": None, "bid": None, "ask": None}
        entry = SPOT_MAP.get(norm)
        if entry:
            metal, pair = entry
            out["pair"] = pair
            try:
                import urllib.request

                with urllib.request.urlopen(
                        f"https://api.gold-api.com/price/{metal}", timeout=4) as r:
                    out["spot"] = round(float(json.load(r)["price"]), 4)
            except Exception:
                pass
        # Last traded price from a short-cached 1m history → near-real-time.
        hist = _yf_history(norm, "1d", "1m", ttl=2)
        if len(hist) == 0:
            hist = _yf_history(norm, "5d", "1d", ttl=30)
        if len(hist):
            out["price"] = round(float(hist["Close"].iloc[-1]), 6)
            out["source"] = "yahoo"
        return out

    return await asyncio.to_thread(fetch)


@app.post("/api/eval")
async def eval_signals(jobs: list[dict]):
    """Evaluate past signals via signal_eval.py (tp2/tp1/sl/open/no_entry)."""
    proc = await asyncio.create_subprocess_exec(
        worker_python(), str(Path(__file__).resolve().parent / "signal_eval.py"),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, cwd=str(PROJECT_DIR),
    )
    out, _ = await proc.communicate(json.dumps(jobs).encode("utf-8"))
    try:
        return json.loads(out.decode("utf-8"))
    except json.JSONDecodeError:
        return JSONResponse({"error": "signal_eval failed"}, status_code=502)


# ---- persistent stores (gui_reports/webui_*.json) ----

def _read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


# Serialize + atomically replace: several background loops (alerts, scheduler,
# health, trail) and request handlers write these JSON stores from different
# threads. A lock + temp-file replace stops a half-written file (and the torn
# reads the roadmap flagged for a SQLite move) without a risky DB migration.
_IO_LOCK = threading.Lock()


def _write_json(path, data):
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with _IO_LOCK:
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
    except OSError:
        pass


def load_settings():
    return _read_json(SETTINGS_PATH, {})


def save_settings(s):
    _write_json(SETTINGS_PATH, s)


# ---- MT5 password obfuscated at rest (no clear-text in webui_settings.json).
# A per-install random key lives in gui_reports/.mt5key; the password is stored
# as "enc:<base64>" and transparently decrypted for connect/status and when the
# settings modal reloads. Not military-grade, but it removes the plaintext
# credential the repo flagged. ----

def _machine_key():
    kp = DATA_DIR / ".mt5key"
    try:
        if kp.exists():
            return kp.read_bytes()
    except OSError:
        pass
    key = os.urandom(32)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        kp.write_bytes(key)
    except OSError:
        pass
    return key


def _keystream(n, key):
    import hashlib
    out = b""
    i = 0
    while len(out) < n:
        out += hashlib.sha256(key + i.to_bytes(4, "big")).digest()
        i += 1
    return out[:n]


# A control-char sentinel that cannot appear in a typed password, so a real
# password starting with "enc:" is never mistaken for ciphertext.
_PW_MARK = "\x00enc:"


def _enc_pw(plain):
    import base64
    if not plain or str(plain).startswith(_PW_MARK):
        return plain
    data = str(plain).encode("utf-8")
    xored = bytes(a ^ b for a, b in zip(data, _keystream(len(data), _machine_key())))
    return _PW_MARK + base64.b64encode(xored).decode()


def _dec_pw(val):
    import base64
    if not val or not str(val).startswith(_PW_MARK):
        return val
    try:
        data = base64.b64decode(str(val)[len(_PW_MARK):])
        return bytes(a ^ b for a, b in zip(data, _keystream(len(data), _machine_key()))).decode("utf-8")
    except Exception:
        return val


# ---- shadow (paper) journal: hypothetical fills recorded at the REAL bid/ask
# so the auto-engine can be proven before it ever touches money. ----

def load_shadow():
    return _read_json(SHADOW_PATH, [])


def _shadow_add(rec):
    items = load_shadow()
    items.insert(0, rec)
    _write_json(SHADOW_PATH, items[:500])


@app.get("/api/shadow")
async def get_shadow():
    return await asyncio.to_thread(load_shadow)


@app.delete("/api/shadow")
async def clear_shadow():
    _write_json(SHADOW_PATH, [])
    return {"ok": True}


def load_history():
    return _read_json(HISTORY_PATH, [])


def save_history(items):
    _write_json(HISTORY_PATH, items[:200])


@app.get("/api/history")
async def get_history():
    return load_history()


@app.post("/api/history")
async def add_history(entry: dict):
    entry.setdefault("ts", time.strftime("%Y-%m-%d %H:%M"))
    items = load_history()
    # A rerun of the same run (same ts+ticker) replaces instead of duplicating.
    items = [x for x in items if not (x.get("ts") == entry["ts"] and
                                      x.get("ticker") == entry.get("ticker"))]
    items.insert(0, entry)
    save_history(items)
    return {"ok": True, "count": len(items)}


@app.put("/api/history/outcomes")
async def put_outcomes(outcomes: dict):
    """Merge {ts: outcome} produced by /api/eval back into the store."""
    items = load_history()
    for x in items:
        oc = outcomes.get(x.get("ts"))
        if oc:
            x["outcome"] = oc
    save_history(items)
    return {"ok": True}


@app.get("/api/calibration")
async def get_calibration():
    """Confidence calibration: bucket the AI signal's claimed confidence against
    the realized outcome (tp1/tp2 = win, sl = loss) from history, and suggest a
    minimum confidence to auto-trade — the lowest 10-pt bucket that actually
    wins >=55% with a meaningful sample."""
    items = load_history()
    buckets = {}
    for x in items:
        sig = x.get("signal") or {}
        conf = sig.get("confidence")
        oc = x.get("outcome")
        if conf is None or oc not in ("tp1", "tp2", "sl"):
            continue
        try:
            b = min(90, max(0, (int(conf) // 10) * 10))
        except (TypeError, ValueError):
            continue
        d = buckets.setdefault(b, {"n": 0, "wins": 0})
        d["n"] += 1
        if oc in ("tp1", "tp2"):
            d["wins"] += 1
    rows = [{"bucket": b, "n": d["n"],
             "winrate": round(d["wins"] / d["n"] * 100, 1)}
            for b, d in sorted(buckets.items())]
    thresh = next((r["bucket"] for r in rows if r["n"] >= 3 and r["winrate"] >= 55), None)
    total = sum(d["n"] for d in buckets.values())
    return {"buckets": rows, "suggested_threshold": thresh, "total": total}


@app.delete("/api/history")
async def clear_history():
    save_history([])
    return {"ok": True}


# ---- settings (telegram / scheduler / MT5 auto-trade) ----

SETTING_KEYS = {"tg_enabled", "tg_token", "tg_chat",
                "sched_enabled", "sched_time",
                "mt5_enabled", "mt5_login", "mt5_password", "mt5_server",
                "mt5_lot", "mt5_suffix", "mt5_max_spread",
                "mt5_guard", "mt5_max_daily_loss",
                "mt5_trail", "mt5_trail_pct", "mt5_max_ccy",
                "mt5_max_streak", "mt5_blackout",
                "mt5_auto", "mt5_armed",
                "llm_cache_min"}


@app.get("/api/settings")
async def get_settings():
    s = load_settings()
    out = {k: s.get(k) for k in SETTING_KEYS}
    out["mt5_password"] = _dec_pw(s.get("mt5_password"))  # decrypt for the modal
    out["alerts"] = s.get("alerts", [])
    out["last_run"] = s.get("last_run")
    return out


@app.post("/api/settings")
async def post_settings(patch: dict):
    s = load_settings()
    for k in SETTING_KEYS & set(patch):
        s[k] = patch[k]
    if "mt5_password" in patch:  # store obfuscated, never plaintext
        s["mt5_password"] = _enc_pw(s.get("mt5_password"))
    save_settings(s)
    return {"ok": True}


# ---- MT5 auto-trade (Windows: needs the MT5 terminal + MetaTrader5 pkg) ----

def _mt5_connect(s):
    """Initialize the terminal + login. Returns (mt5 module, None) or (None, err)."""
    try:
        import MetaTrader5 as mt5
    except ImportError:
        return None, "MetaTrader5 package not installed — run: pip install MetaTrader5"
    try:
        login = int(s.get("mt5_login") or 0)
    except (TypeError, ValueError):
        return None, "bad MT5 login"
    if not mt5.initialize(login=login, password=_dec_pw(s.get("mt5_password")) or "",
                          server=s.get("mt5_server") or ""):
        code, msg = mt5.last_error()
        return None, f"MT5 connect failed [{code}] {msg} — is the MetaTrader 5 terminal installed?"
    return mt5, None


def _mt5_resolve_symbol(mt5, name, suffix):
    """Find the broker's symbol name: exact, with suffix (XAUUSD.m …), or prefix."""
    for cand in (f"{name}{suffix or ''}", name):
        if cand and mt5.symbol_info(cand) is not None:
            mt5.symbol_select(cand, True)
            return cand
    matches = mt5.symbols_get(f"{name}*") or ()
    for m in matches:
        if mt5.symbol_select(m.name, True):
            return m.name
    return None


_BROKER_NAME_CACHE = {}  # (ticker, suffix) -> (resolved_at, name-or-None)


def _resolve_broker_symbol(mt5, ticker, suffix):
    """First broker symbol that resolves for any candidate name of `ticker`.

    Cached: the market-data path calls this every ~2s per symbol, and a miss
    walks mt5.symbols_get wildcards — cache hits for 10 min, misses for 60 s
    (so adding the symbol at the broker is picked up within a minute)."""
    key = ((ticker or "").strip().upper(), suffix or "")
    now = time.time()
    hit = _BROKER_NAME_CACHE.get(key)
    if hit and now - hit[0] < (600 if hit[1] else 60):
        return hit[1]
    name = None
    for cand in broker_names(ticker):
        name = _mt5_resolve_symbol(mt5, cand, suffix)
        if name:
            break
    _BROKER_NAME_CACHE[key] = (now, name)
    return name


# ---- live broker market data (chart candles + tick straight from the open
# MetaTrader terminal). The chart/quote poll this every ~2s — far more often
# than the trade path — so a tiny negative-connect cache means that when the
# terminal is closed we don't re-attempt mt5.initialize (which can relaunch the
# terminal) on every poll; we report "closed" until the cooldown passes and the
# UI falls back to the yfinance chart. ----

_MT5_MD = {"at": 0.0, "ok": False, "err": None}
_MT5_MD_COOLDOWN = 6.0
_MT5_CANDLE_CACHE = {}  # (symbol, tf) -> (fetched_at, payload without live tick)

# The MetaTrader5 package is a single global connection to one terminal and is
# NOT thread-safe: concurrent copy_rates/symbol_info_tick calls from different
# worker threads (the tick stream at ~7 Hz, the scanner hitting many symbols,
# /api/chart, the trade path) can return torn data or crash. Serialize every
# hot-path MT5 read behind this lock. Held only for the microsecond-fast local
# terminal calls, so even the 150 ms stream loop never contends meaningfully.
_MT5_LOCK = threading.Lock()


def _mt5_md_connect(s):
    """Throttled connect for the market-data path (see the note above)."""
    now = time.time()
    if not _MT5_MD["ok"] and now - _MT5_MD["at"] < _MT5_MD_COOLDOWN:
        return None, _MT5_MD["err"] or "MT5 not connected"
    mt5, err = _mt5_connect(s)
    _MT5_MD.update(at=now, ok=(err is None), err=err)
    return mt5, err


def _mt5_tf_const(mt5, tf):
    return {
        "1m": mt5.TIMEFRAME_M1, "5m": mt5.TIMEFRAME_M5, "15m": mt5.TIMEFRAME_M15,
        "30m": mt5.TIMEFRAME_M30, "1h": mt5.TIMEFRAME_H1, "4h": mt5.TIMEFRAME_H4,
        "1d": mt5.TIMEFRAME_D1, "1wk": mt5.TIMEFRAME_W1,
    }.get(tf, mt5.TIMEFRAME_M1)


def _mt5_tick_dict(tick, digits):
    """A symbol_info_tick → {bid, ask, last, mid, time}, or None."""
    if tick is None:
        return None
    bid, ask = float(tick.bid or 0), float(tick.ask or 0)
    last = float(getattr(tick, "last", 0) or 0)
    if not (bid or ask or last):
        return None
    mid = (bid + ask) / 2 if bid and ask else (last or bid or ask)
    return {"bid": round(bid, digits) or None, "ask": round(ask, digits) or None,
            "last": round(last, digits) or None, "mid": round(mid, digits),
            "time": int(getattr(tick, "time", 0) or 0)}


def _mt5_candles(ticker, tf, count):
    """OHLCV candles + freshest tick for `ticker` straight from the broker, in
    the same shape as /api/chart. Returns {ok:False, reason} when MT5 is
    disabled/closed/unknown so the UI can fall back to yfinance."""
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"ok": False, "reason": "disabled"}
    mt5, err = _mt5_md_connect(s)
    if err:
        return {"ok": False, "reason": "connect", "error": err}
    try:
        count = max(60, min(2000, int(count or 500)))
    except (TypeError, ValueError):
        count = 500
    with _MT5_LOCK:
        name = _resolve_broker_symbol(mt5, ticker, s.get("mt5_suffix") or "")
        if not name:
            return {"ok": False, "reason": "symbol",
                    "error": f"{ticker} not found at this broker"}
        info = mt5.symbol_info(name)
        digits = info.digits if info else 5
        rates = mt5.copy_rates_from_pos(name, _mt5_tf_const(mt5, tf), 0, count)
        tick = _mt5_tick_dict(mt5.symbol_info_tick(name), digits)
    if rates is None or len(rates) == 0:
        return {"ok": False, "reason": "no_data",
                "error": f"no {tf} candles for {name}"}
    bars = [{
        "time": int(rr["time"]),
        "open": round(float(rr["open"]), digits),
        "high": round(float(rr["high"]), digits),
        "low": round(float(rr["low"]), digits),
        "close": round(float(rr["close"]), digits),
        "volume": int(rr["tick_volume"]),
    } for rr in rates]
    # `symbol` is the resolved broker name (e.g. XAUUSD_o) used for the data +
    # order calls; `display` is the clean canonical name (XAUUSD) the UI shows,
    # so the suffix stays a broker-side detail and never leaks into the UI.
    cands = broker_names(ticker)
    payload = {"ok": True, "symbol": name, "digits": digits, "bars": bars,
               "display": cands[0] if cands else name}
    if tick:
        payload["tick"] = tick
    return payload


# (`/api/mt5/candles` was removed: /api/chart and /ws/mt5 are the only two
# doors to broker candles now. Three implementations of "read candles from MT5"
# meant every bug had to be fixed three times — and their drift is exactly what
# made the chart and the plan disagree on price.)


# ---- real-time stream: push the broker's OWN candles + live bid/ask over a
# WebSocket at ~7 Hz so the price, the forming candle and every strategy signal
# track the open MetaTrader terminal with no perceptible lag and zero basis
# error. copy_rates' last row IS MetaTrader's real forming candle (bid-based),
# so nothing is faked — what the browser draws is byte-for-byte what MT5 shows.

_STREAM_HZ = 0.15   # live poll period (s) while connected — ~7 updates/second
_STREAM_IDLE = 1.5  # retry period while MT5 is unavailable (upgrades when it opens)


def _mt5_snapshot(ticker, tf, count, full):
    """One MetaTrader read for the stream: the last `count` (full) or last 2
    (diff) real candles + the live bid/ask tick. Bid-based, matching MT5's own
    chart exactly. {ok:False, reason} when the terminal is closed/unknown."""
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"ok": False, "reason": "disabled"}
    mt5, err = _mt5_md_connect(s)
    if err:
        return {"ok": False, "reason": "connect", "error": err}
    try:
        count = max(60, min(2000, int(count or 720)))
    except (TypeError, ValueError):
        count = 720
    n = count if full else 2
    with _MT5_LOCK:
        name = _resolve_broker_symbol(mt5, ticker, s.get("mt5_suffix") or "")
        if not name:
            return {"ok": False, "reason": "symbol"}
        info = mt5.symbol_info(name)
        digits = info.digits if info else 5
        rates = mt5.copy_rates_from_pos(name, _mt5_tf_const(mt5, tf), 0, n)
        tick = _mt5_tick_dict(mt5.symbol_info_tick(name), digits)
    if rates is None or len(rates) == 0:
        return {"ok": False, "reason": "no_data"}
    bars = [{
        "time": int(rr["time"]),
        "open": round(float(rr["open"]), digits),
        "high": round(float(rr["high"]), digits),
        "low": round(float(rr["low"]), digits),
        "close": round(float(rr["close"]), digits),
        "volume": int(rr["tick_volume"]),
    } for rr in rates]
    cands = broker_names(ticker)
    return {"ok": True, "symbol": name, "display": cands[0] if cands else name,
            "digits": digits, "bars": bars, "tick": tick}


@app.websocket("/ws/mt5")
async def ws_mt5(ws: WebSocket):
    """Live candle+tick stream for one (ticker, tf). The browser opens one of
    these per chart/signal timeframe; the server pushes a full snapshot then
    tick-by-tick diffs. While MetaTrader is closed it sends `unavailable` pings
    and keeps trying, so the feed upgrades to live the moment the terminal opens
    (the browser runs the yfinance fallback in the meantime)."""
    await ws.accept()
    try:
        cfg = json.loads(await ws.receive_text())
    except Exception:
        await ws.close()
        return
    ticker = normalize_ticker(cfg.get("ticker"))
    tf = str(cfg.get("tf") or "1m")
    try:
        count = max(60, min(2000, int(cfg.get("count") or 720)))
    except (TypeError, ValueError):
        count = 720

    # A reader task exists only to notice the socket closing (the browser sends
    # nothing after the config line); when it ends we stop streaming.
    async def _watch():
        try:
            while True:
                await ws.receive_text()
        except Exception:
            return

    watcher = asyncio.create_task(_watch())
    sent_full = False
    last_key = None
    last_unavail = 0.0
    try:
        while not watcher.done():
            snap = await asyncio.to_thread(_mt5_snapshot, ticker, tf, count, not sent_full)
            if not snap.get("ok"):
                sent_full = False
                now = time.time()
                if now - last_unavail > 2.5:  # don't spam the fallback signal
                    last_unavail = now
                    await ws.send_json({"type": "unavailable", "reason": snap.get("reason")})
                await asyncio.sleep(_STREAM_IDLE)
                continue
            bars = snap["bars"]
            lb, tk = bars[-1], (snap.get("tick") or {})
            key = (lb["time"], lb["close"], lb["high"], lb["low"], tk.get("time"), tk.get("bid"), tk.get("ask"))
            if not sent_full:
                await ws.send_json({"type": "snapshot", "source": "mt5",
                                    "symbol": snap["symbol"], "display": snap["display"],
                                    "digits": snap["digits"], "bars": bars, "tick": snap.get("tick")})
                sent_full = True
                last_key = key
            elif key != last_key:  # only push when something actually moved
                await ws.send_json({"type": "update", "bars": bars, "tick": snap.get("tick")})
                last_key = key
            await asyncio.sleep(_STREAM_HZ)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        watcher.cancel()
        try:
            await ws.close()
        except Exception:
            pass


# ---- headless signal engine ------------------------------------------------
# The strategies live in webui/frontend/src/strategies.js and, until now, only
# ever ran in the browser — so nothing could act on a signal unless a tab was
# open. `signal_engine.mjs` runs THAT SAME FILE under node, which is why the
# auto-engine's signal is guaranteed identical to the one drawn on the chart.
# A single long-lived process serves line-delimited JSON requests; if node (or
# the strategy file) is missing we simply report unavailable and the auto-engine
# stays idle rather than guessing.

_ENGINE = {"proc": None, "lock": None, "seq": 0, "why": None}


def _strategies_js():
    """Locate the ONE strategies.js the browser also runs. The launcher serves
    an installed copy where webui/frontend/src doesn't exist, so also look under
    the process cwd (the launcher's working dir is the repo root) — that's the
    real source tree the node engine imports."""
    here = Path(__file__).resolve().parent
    rel = ("webui", "frontend", "src", "strategies.js")
    for cand in (here / "frontend" / "src" / "strategies.js",
                 PROJECT_DIR / Path(*rel),
                 Path.cwd() / Path(*rel),
                 PROJECT_DIR.parent / Path(*rel)):
        try:
            if cand.exists():
                return cand.resolve()
        except OSError:
            pass
    return None


async def _engine_proc():
    p = _ENGINE["proc"]
    if p is not None and p.returncode is None:
        return p
    import shutil

    node = shutil.which("node")
    strat = _strategies_js()
    if not node:
        _ENGINE["why"] = "node not found on PATH"
        return None
    if not ENGINE_PATH.exists() or strat is None:
        _ENGINE["why"] = "signal_engine.mjs / strategies.js not found"
        return None
    try:
        p = await asyncio.create_subprocess_exec(
            node, str(ENGINE_PATH), str(strat),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, cwd=str(PROJECT_DIR))
        line = await asyncio.wait_for(p.stdout.readline(), timeout=20)
        if not line or b"ready" not in line:
            raise RuntimeError("engine did not announce readiness")
    except Exception as e:
        _ENGINE["why"] = f"{type(e).__name__}: {e}"
        _ENGINE["proc"] = None
        return None
    _ENGINE["why"] = None
    _ENGINE["proc"] = p
    return p


async def engine_eval(payload):
    """One request/response against the node engine, or None if unavailable."""
    if _ENGINE["lock"] is None:
        _ENGINE["lock"] = asyncio.Lock()
    async with _ENGINE["lock"]:
        p = await _engine_proc()
        if p is None:
            return None
        _ENGINE["seq"] += 1
        req = {**payload, "id": _ENGINE["seq"]}
        try:
            p.stdin.write((json.dumps(req) + "\n").encode())
            await p.stdin.drain()
            line = await asyncio.wait_for(p.stdout.readline(), timeout=30)
            if not line:
                raise RuntimeError("engine closed")
            return json.loads(line.decode())
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
            _ENGINE["proc"] = None  # respawn on the next call
            return None


@app.get("/api/engine/status")
async def engine_status():
    p = await _engine_proc()
    return {"ok": p is not None, "error": _ENGINE["why"],
            "strategies": str(_strategies_js() or "")}


# ---- trade safety guard: a watchdog (health_loop) locks new entries when MT5
# keeps failing or the day's loss cap is hit. Closing a position is always
# allowed — you must be able to exit even while locked. ----

_HEALTH = {"fails": 0}  # consecutive failed health checks (not persisted)


def _lock_state():
    return load_settings().get("mt5_lock") or {"locked": False}


def _apply_lock(reason, detail):
    """Trip the safety lock, announcing it once (only on a real transition)."""
    s = load_settings()
    if (s.get("mt5_lock") or {}).get("locked"):
        return  # already locked — don't re-announce
    s["mt5_lock"] = {"locked": True, "reason": reason, "detail": detail,
                     "since": time.strftime("%Y-%m-%d %H:%M")}
    save_settings(s)
    telegram_send("🛑 قفلِ ایمنیِ TradingAgents فعال شد\n"
                  f"دلیل: {detail}\nاتوترید تا رفعِ قفل متوقف است.")


def _clear_lock(note=""):
    s = load_settings()
    if not (s.get("mt5_lock") or {}).get("locked"):
        return
    s["mt5_lock"] = {"locked": False}
    save_settings(s)
    telegram_send("✅ قفلِ ایمنیِ TradingAgents برداشته شد"
                  + (f" — {note}" if note else ""))


def _guard_fields(out, s, acct):
    """Attach guard/lock/day-P&L state to an MT5 status or positions payload."""
    out["guard"] = bool(s.get("mt5_guard"))
    out["lock"] = s.get("mt5_lock") or {"locked": False}
    cap = float(s.get("mt5_max_daily_loss") or 0)
    out["max_daily_loss"] = cap or None
    day = s.get("mt5_day") or {}
    if acct is not None and day.get("date") == time.strftime("%Y-%m-%d"):
        out["day_pl"] = round(acct.equity - day.get("start_equity", acct.equity), 2)


def _mt5_status():
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"enabled": False}
    out = {"enabled": True, "connected": False,
           "lot": float(s.get("mt5_lot") or 0.01)}
    mt5, err = _mt5_connect(s)
    if err:
        _guard_fields(out, s, None)
        out["error"] = err
        return out
    acct = mt5.account_info()
    if acct is None:
        _guard_fields(out, s, None)
        out["error"] = f"MT5 login failed: {mt5.last_error()[1]}"
        return out
    out["connected"] = True
    # ACCOUNT_TRADE_MODE_DEMO=0, CONTEST=1, REAL=2. The UI paints a real account
    # red — the one-click send button must never look identical on live money.
    trade_mode = int(getattr(acct, "trade_mode", 0) or 0)
    out["account"] = {"login": acct.login, "server": acct.server,
                      "balance": round(acct.balance, 2),
                      "equity": round(acct.equity, 2),
                      "currency": acct.currency,
                      "trade_mode": trade_mode,
                      "is_real": trade_mode == 2}
    _guard_fields(out, s, acct)
    return out


# Recent accepted orders, for de-dup: (symbol, dir) -> time.time() of last send.
_RECENT_ORDERS = {}
_DEDUP_WINDOW_S = 8.0


def _currency_legs(symbol):
    """FX pair → (base, quote) currency codes, else (None, None). Broker suffixes
    (EURUSD.pro, XAUUSD.m …) are ignored by taking the first 6 alpha chars."""
    core = "".join(ch for ch in str(symbol).upper() if ch.isalpha())[:6]
    if len(core) == 6 and core[:3] in _FIAT and core[3:] in _FIAT:
        return core[:3], core[3:]
    return None, None


def _mt5_order(body):
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"ok": False, "error": "MT5 auto-trade disabled in settings"}
    mt5, err = _mt5_connect(s)
    if err:
        return {"ok": False, "error": err}

    # Safety guard: refuse NEW entries while the lock is tripped. A "disconnect"
    # lock self-heals here (we just connected fine); a loss/manual lock must be
    # cleared from the UI or by the next trading day. `force` overrides.
    lock = s.get("mt5_lock") or {}
    if lock.get("locked") and not body.get("force"):
        if lock.get("reason") == "disconnect":
            _clear_lock("سفارش پس از اتصال مجدد")
        else:
            return {"ok": False, "error":
                    f"قفلِ ایمنی فعال است — {lock.get('detail') or lock.get('reason')}. "
                    "از «رفع قفل» استفاده کن یا force بده."}

    # Blackout window (opt-in): pause entries around news / thin sessions.
    bw = _in_blackout(s)
    if bw and not body.get("force"):
        return {"ok": False, "error": f"پنجرهٔ بلک‌اوت فعال است ({bw}) — ورود لغو شد"}

    direction = str(body.get("dir", "")).upper()
    if direction not in ("BUY", "SELL"):
        return {"ok": False, "error": f"bad direction {direction!r}"}
    symbol = _mt5_resolve_symbol(mt5, str(body.get("symbol") or "").upper().strip(),
                                 s.get("mt5_suffix") or "")
    if not symbol:
        return {"ok": False, "error": f"symbol {body.get('symbol')!r} not found at this broker"}

    # Correlation / aggregate-exposure guard (opt-in mt5_max_ccy): sum signed net
    # exposure per currency across open FX positions + this one; refuse if any
    # currency's net count would exceed the cap. Catches stacking correlated
    # pairs (EURUSD+GBPUSD+AUDUSD long = one big USD bet).
    try:
        cap_ccy = int(float(s.get("mt5_max_ccy") or 0))
    except (TypeError, ValueError):
        cap_ccy = 0
    if cap_ccy > 0 and not body.get("force"):
        nb, nq = _currency_legs(symbol)
        if nb:
            net = {}
            for pos in (mt5.positions_get() or ()):
                b, q = _currency_legs(pos.symbol)
                if not b:
                    continue
                sg = 1 if pos.type == mt5.POSITION_TYPE_BUY else -1
                net[b] = net.get(b, 0) + sg
                net[q] = net.get(q, 0) - sg
            sg = 1 if direction == "BUY" else -1
            net[nb] = net.get(nb, 0) + sg
            net[nq] = net.get(nq, 0) - sg
            worst = max((abs(v) for v in net.values()), default=0)
            if worst > cap_ccy:
                return {"ok": False, "error":
                        f"سقفِ اکسپوژرِ ارزی رد شد (خالصِ {worst} > {cap_ccy}) — سفارش رد شد. force برای دور زدن."}

    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        return {"ok": False, "error": f"no market data for {symbol}"}

    # The broker can put a symbol in close-only / disabled mode (out of session,
    # expiring contract, restricted instrument). Sending then just earns a
    # reject — say so plainly instead. SYMBOL_TRADE_MODE_FULL=4, LONGONLY=1,
    # SHORTONLY=2, CLOSEONLY=3, DISABLED=0.
    tmode = int(getattr(info, "trade_mode", 4) or 0)
    if tmode == 0:
        return {"ok": False, "error": f"{symbol}: معاملهٔ این نماد نزد بروکر غیرفعال است"}
    if tmode == 3:
        return {"ok": False, "error": f"{symbol}: فقط بستنِ پوزیشن مجاز است (close-only)"}
    if tmode == 1 and direction == "SELL":
        return {"ok": False, "error": f"{symbol}: فقط خرید مجاز است (long-only)"}
    if tmode == 2 and direction == "BUY":
        return {"ok": False, "error": f"{symbol}: فقط فروش مجاز است (short-only)"}

    # Volume: clamp to the symbol's min/step AND its max.
    try:
        lot = float(body.get("lot") or s.get("mt5_lot") or 0.01)
    except (TypeError, ValueError):
        lot = 0.01
    step = info.volume_step or 0.01
    lot = max(info.volume_min or step, round(round(lot / step) * step, 8))
    if info.volume_max:
        lot = min(lot, info.volume_max)

    price = tick.ask if direction == "BUY" else tick.bid
    digits = info.digits

    # Entry-quality guard: refuse to enter when the live spread is abnormally
    # wide (news spikes / illiquid moments). The ceiling is opt-in — body
    # `max_spread` or settings `mt5_max_spread`, in broker points — so existing
    # setups are unaffected until they set one. Regardless, scale the allowed
    # slippage to the symbol: a fixed 30 points is far too tight on gold and
    # indices and causes needless requotes.
    point = info.point or 0.0
    spread_points = round((tick.ask - tick.bid) / point) if point else 0
    try:
        max_spread = float(body.get("max_spread") if body.get("max_spread") is not None
                           else s.get("mt5_max_spread") or 0)
    except (TypeError, ValueError):
        max_spread = 0.0
    if max_spread > 0 and spread_points > max_spread:
        return {"ok": False, "error":
                f"اسپرد پهن است ({spread_points} امتیاز > سقفِ {max_spread:.0f}) — ورود لغو شد"}
    deviation = min(500, max(30, spread_points * 3))

    # Round to the broker's TICK SIZE, not just its digit count: on symbols
    # where tick_size > point (indices, some crypto) a digit-rounded level is
    # off-grid and the order is rejected as "invalid price".
    tick_size = info.trade_tick_size or point or 0.0

    def _snap(v):
        if not tick_size:
            return round(v, digits)
        return round(round(v / tick_size) * tick_size, digits)

    def level(key):
        try:
            v = float(body.get(key))
            return _snap(v) if v > 0 else None
        except (TypeError, ValueError):
            return None

    sl, tp = level("sl"), level("tp")
    # Drop levels that ended up on the wrong side of the live price
    # (stale chart vs market) instead of getting a broker reject.
    if sl is not None and ((direction == "BUY") != (sl < price)):
        sl = None
    if tp is not None and ((direction == "BUY") != (tp > price)):
        tp = None

    # ---- broker stop distance: MT5 refuses SL/TP closer to price than
    # trade_stops_level points ("Invalid stops", retcode 10016). ATR stops on a
    # 1-minute chart routinely land inside it. Push each level out to the
    # minimum instead of eating the reject; if that would invert the level's
    # meaning we drop it and say so. freeze_level additionally forbids touching
    # levels near price at all, so respect the larger of the two. ----
    stops_pts = int(getattr(info, "trade_stops_level", 0) or 0)
    freeze_pts = int(getattr(info, "trade_freeze_level", 0) or 0)
    min_dist = max(stops_pts, freeze_pts) * point
    adjusted = []
    if min_dist > 0:
        if sl is not None and abs(price - sl) < min_dist:
            sl = _snap(price - min_dist if direction == "BUY" else price + min_dist)
            adjusted.append("SL")
        if tp is not None and abs(tp - price) < min_dist:
            tp = _snap(price + min_dist if direction == "BUY" else price - min_dist)
            adjusted.append("TP")
    # A pushed-out SL can only ever move away from price, so it stays valid; a
    # pushed-out TP likewise. Re-verify the side anyway (defensive).
    if sl is not None and ((direction == "BUY") != (sl < price)):
        sl = None
    if tp is not None and ((direction == "BUY") != (tp > price)):
        tp = None

    # Enough free margin? order_calc_margin answers before the broker does.
    try:
        need = mt5.order_calc_margin(
            mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL,
            symbol, lot, price)
        acct0 = mt5.account_info()
        if need is not None and acct0 is not None and need > acct0.margin_free:
            return {"ok": False, "error":
                    f"مارجینِ آزاد کافی نیست: نیاز {need:.2f} > آزاد {acct0.margin_free:.2f} "
                    f"{acct0.currency} — لات را کم کن"}
    except Exception:
        pass  # margin calc unsupported → let the broker decide

    # Shadow (paper) mode: decide exactly as in live, but record a hypothetical
    # fill at the REAL bid/ask instead of sending. Spread and side are modelled
    # honestly, which is the whole point of shadow trading.
    if body.get("shadow"):
        rec = {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "symbol": symbol,
               "dir": direction, "volume": lot, "price": price,
               "bid": round(tick.bid, digits), "ask": round(tick.ask, digits),
               "spread_points": spread_points, "sl": sl, "tp": tp,
               "comment": str(body.get("comment") or "")[:40], "shadow": True}
        _shadow_add(rec)
        return {"ok": True, "shadow": True, "symbol": symbol, "volume": lot,
                "price": rec["price"], "sl": sl, "tp": tp,
                "adjusted": adjusted or None}

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": lot,
        "type": mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL,
        "price": price,
        "deviation": deviation,
        "magic": 26012,
        "comment": str(body.get("comment") or "TradingAgents")[:26],
        "type_time": mt5.ORDER_TIME_GTC,
    }
    if sl is not None:
        request["sl"] = sl
    if tp is not None:
        request["tp"] = tp

    # De-dup: the auto-engine and network retries can fire the same signal
    # twice within a second or two. Reserve the (symbol, dir) slot before
    # sending and refuse a duplicate inside a short window; a failed send frees
    # the slot again so a legitimate retry still goes through. `force` bypasses
    # it for deliberate pyramiding.
    now = time.time()
    dedup_key = (symbol, direction)
    if not body.get("force"):
        last = _RECENT_ORDERS.get(dedup_key)
        if last is not None and now - last < _DEDUP_WINDOW_S:
            return {"ok": False, "error":
                    f"سفارشِ تکراری {direction} {symbol} در {_DEDUP_WINDOW_S:.0f} ثانیهٔ اخیر — رد شد (force برای دور زدن)"}
    _RECENT_ORDERS[dedup_key] = now

    # Brokers disagree on filling modes — walk through them on 'unsupported'.
    result = None
    for filling in (mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN):
        result = mt5.order_send({**request, "type_filling": filling})
        if result is not None and result.retcode != 10030:  # unsupported filling
            break
    if result is None:
        _RECENT_ORDERS.pop(dedup_key, None)  # failed send — allow a retry
        return {"ok": False, "error": f"order_send failed: {mt5.last_error()[1]}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        _RECENT_ORDERS.pop(dedup_key, None)  # rejected — allow a retry
        return {"ok": False, "error": f"[{result.retcode}] {result.comment}"}

    acct = mt5.account_info()
    return {"ok": True, "order": result.order, "deal": result.deal,
            "symbol": symbol, "volume": lot,
            "price": round(result.price or price, digits),
            "sl": sl, "tp": tp,
            # levels the broker's minimum stop distance forced us to move
            "adjusted": adjusted or None,
            "account": None if acct is None else
            {"login": acct.login, "balance": round(acct.balance, 2),
             "equity": round(acct.equity, 2), "currency": acct.currency}}


def _pos_dir(mt5, p):
    return "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL"


def _mt5_positions():
    """Open positions with live P/L — the manage half of the trade loop."""
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"enabled": False, "positions": []}
    out = {"enabled": True, "connected": False, "positions": []}
    mt5, err = _mt5_connect(s)
    if err:
        out["error"] = err
        return out
    acct = mt5.account_info()
    if acct is None:
        out["error"] = f"MT5 login failed: {mt5.last_error()[1]}"
        return out
    out["connected"] = True
    out["account"] = {"login": acct.login, "server": acct.server,
                      "balance": round(acct.balance, 2),
                      "equity": round(acct.equity, 2),
                      "margin_free": round(acct.margin_free, 2),
                      "profit": round(acct.profit, 2),
                      "currency": acct.currency}
    positions = mt5.positions_get() or ()
    rows = []
    for p in positions:
        tick = mt5.symbol_info_tick(p.symbol)
        info = mt5.symbol_info(p.symbol)
        digits = info.digits if info else 5
        cur = (tick.bid if p.type == mt5.POSITION_TYPE_BUY else tick.ask) if tick else p.price_current
        rows.append({
            "ticket": p.ticket, "symbol": p.symbol, "dir": _pos_dir(mt5, p),
            "volume": p.volume, "price_open": round(p.price_open, digits),
            "price_current": round(cur, digits),
            "sl": p.sl or None, "tp": p.tp or None,
            "profit": round(p.profit, 2), "swap": round(p.swap, 2),
            "comment": p.comment, "digits": digits,
            "magic": p.magic,
        })
    # Newest first so a just-placed trade lands at the top.
    out["positions"] = sorted(rows, key=lambda x: x["ticket"], reverse=True)
    _guard_fields(out, s, acct)
    return out


def _find_position(mt5, ticket):
    for p in (mt5.positions_get() or ()):
        if p.ticket == ticket:
            return p
    return None


def _mt5_close(body):
    """Close a position fully or partially (opposite market deal)."""
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"ok": False, "error": "MT5 auto-trade disabled in settings"}
    mt5, err = _mt5_connect(s)
    if err:
        return {"ok": False, "error": err}
    try:
        ticket = int(body.get("ticket"))
    except (TypeError, ValueError):
        return {"ok": False, "error": "bad ticket"}
    p = _find_position(mt5, ticket)
    if p is None:
        return {"ok": False, "error": "position not found (already closed?)"}

    info = mt5.symbol_info(p.symbol)
    tick = mt5.symbol_info_tick(p.symbol)
    if info is None or tick is None:
        return {"ok": False, "error": f"no market data for {p.symbol}"}

    # Partial close: clamp the requested volume to the position and lot step.
    step = info.volume_step or 0.01
    vol = p.volume
    if body.get("volume") is not None:
        try:
            req = float(body["volume"])
            vol = max(info.volume_min or step, round(round(req / step) * step, 8))
            vol = min(vol, p.volume)
        except (TypeError, ValueError):
            vol = p.volume

    is_buy = p.type == mt5.POSITION_TYPE_BUY
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "position": ticket,
        "symbol": p.symbol,
        "volume": vol,
        "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
        "price": tick.bid if is_buy else tick.ask,
        "deviation": 30,
        "magic": p.magic,
        "comment": "TA close",
        "type_time": mt5.ORDER_TIME_GTC,
    }
    result = None
    for filling in (mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN):
        result = mt5.order_send({**request, "type_filling": filling})
        if result is not None and result.retcode != 10030:
            break
    if result is None:
        return {"ok": False, "error": f"close failed: {mt5.last_error()[1]}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"ok": False, "error": f"[{result.retcode}] {result.comment}"}
    return {"ok": True, "ticket": ticket, "closed": vol,
            "price": round(result.price or 0, info.digits),
            "partial": vol < p.volume}


def _mt5_modify(body):
    """Move SL/TP on an open position — e.g. jump the stop to break-even."""
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"ok": False, "error": "MT5 auto-trade disabled in settings"}
    mt5, err = _mt5_connect(s)
    if err:
        return {"ok": False, "error": err}
    try:
        ticket = int(body.get("ticket"))
    except (TypeError, ValueError):
        return {"ok": False, "error": "bad ticket"}
    p = _find_position(mt5, ticket)
    if p is None:
        return {"ok": False, "error": "position not found (already closed?)"}
    info = mt5.symbol_info(p.symbol)
    digits = info.digits if info else 5

    def level(key, fallback):
        if body.get(key) is None:
            return fallback
        if body.get(key) == 0:
            return 0.0  # explicit clear
        try:
            return round(float(body[key]), digits)
        except (TypeError, ValueError):
            return fallback

    # "breakeven": convenience flag → set SL to the entry price.
    sl = round(p.price_open, digits) if body.get("breakeven") else level("sl", p.sl)
    tp = level("tp", p.tp)
    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": ticket,
        "symbol": p.symbol,
        "sl": sl or 0.0,
        "tp": tp or 0.0,
    }
    result = mt5.order_send(request)
    if result is None:
        return {"ok": False, "error": f"modify failed: {mt5.last_error()[1]}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"ok": False, "error": f"[{result.retcode}] {result.comment}"}
    return {"ok": True, "ticket": ticket, "sl": sl or None, "tp": tp or None}


def _mt5_symbol_info(body):
    """Broker-truth contract facts for a symbol, plus an optional risk-based lot.

    Replaces the frontend's guessed contract sizes (which return null for
    indices/crypto/stocks and blank the risk line). Given {symbol} it returns
    the real trade_contract_size / tick value & size / volume min-step-max;
    given entry+sl it adds the money-at-risk per 1.0 lot; given risk (account
    currency) or risk_pct (% of live equity) it adds a suggested lot sized to
    that risk from the broker's own tick value — correct for FX, metals,
    indices and crypto alike.
    """
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"ok": False, "error": "MT5 auto-trade disabled in settings"}
    mt5, err = _mt5_connect(s)
    if err:
        return {"ok": False, "error": err}
    name = _mt5_resolve_symbol(mt5, str(body.get("symbol") or "").upper().strip(),
                               s.get("mt5_suffix") or "")
    if not name:
        return {"ok": False, "error": f"symbol {body.get('symbol')!r} not found at this broker"}
    info = mt5.symbol_info(name)
    if info is None:
        return {"ok": False, "error": f"no symbol info for {name}"}

    tick_size = info.trade_tick_size or info.point or 0.0
    tick_value = getattr(info, "trade_tick_value_loss", 0.0) or info.trade_tick_value or 0.0
    out = {"ok": True, "symbol": name, "digits": info.digits, "point": info.point,
           "contract_size": info.trade_contract_size,
           "tick_size": tick_size, "tick_value": tick_value,
           "volume_min": info.volume_min, "volume_step": info.volume_step,
           "volume_max": info.volume_max or None, "currency": info.currency_profit}

    def num(key):
        try:
            v = float(body.get(key))
            return v if v > 0 else None
        except (TypeError, ValueError):
            return None

    entry, sl = num("entry"), num("sl")
    if entry is not None and sl is not None and tick_size and tick_value:
        sl_dist = abs(entry - sl)
        risk_per_lot = (sl_dist / tick_size) * tick_value
        out["sl_distance"] = round(sl_dist, info.digits)
        out["risk_per_lot"] = round(risk_per_lot, 2)
        acct = mt5.account_info()
        equity = acct.equity if acct else None
        risk_money = num("risk")
        risk_pct = num("risk_pct")
        if risk_money is None and risk_pct is not None and equity:
            risk_money = equity * (risk_pct / 100.0)
        if risk_money and risk_per_lot > 0:
            step = info.volume_step or 0.01
            lot = int((risk_money / risk_per_lot) / step) * step  # floor to step
            lot = max(info.volume_min or step, round(lot, 8))
            if info.volume_max:
                lot = min(lot, info.volume_max)
            out["equity"] = round(equity, 2) if equity else None
            out["risk_money"] = round(risk_money, 2)
            out["suggested_lot"] = round(lot, 2)
    return out


@app.get("/api/mt5/status")
async def mt5_status():
    return await asyncio.to_thread(_mt5_status)


@app.get("/api/mt5/positions")
async def mt5_positions():
    return await asyncio.to_thread(_mt5_positions)


@app.post("/api/mt5/symbol_info")
async def mt5_symbol_info(body: dict):
    return await asyncio.to_thread(_mt5_symbol_info, body)


def _mt5_journal(days):
    """Realized trade journal + performance from the broker's own deal history:
    closed trades, a realized-equity curve, and per-strategy stats grouped by the
    order comment tag (TA-<tag> / TA:<id> set by the auto-trade path)."""
    import datetime

    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"ok": False, "error": "MT5 auto-trade disabled in settings"}
    mt5, err = _mt5_connect(s)
    if err:
        return {"ok": False, "error": err}
    try:
        days = max(1, min(365, int(days or 30)))
    except (TypeError, ValueError):
        days = 30
    to_dt = datetime.datetime.now()
    req_from = time.time() - days * 86400
    # Fetch a wide window so each position's OPENING deal — which carries the
    # strategy tag AND the entry commission — is present even for trades opened
    # before the requested window; then aggregate EVERY deal by position so one
    # closed position = one trade (partial closes don't inflate counts, and the
    # entry commission is included in realized P/L).
    deals = mt5.history_deals_get(to_dt - datetime.timedelta(days=365), to_dt) or ()
    pos = {}
    for d in deals:
        g = pos.get(d.position_id)
        if g is None:
            g = pos[d.position_id] = {"pnl": 0.0, "tag": "", "in_type": None,
                                      "symbol": d.symbol, "vol": 0.0,
                                      "close_time": 0, "close_price": 0.0}
        g["pnl"] += d.profit + d.swap + d.commission
        if d.symbol:
            g["symbol"] = d.symbol
        if d.entry == mt5.DEAL_ENTRY_IN:
            g["tag"] = d.comment or g["tag"]
            g["in_type"] = d.type
            g["vol"] = d.volume
        elif d.type in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL) and d.time >= g["close_time"]:
            g["close_time"] = int(d.time)
            g["close_price"] = round(d.price, 5)
    rows = []
    for pid, g in pos.items():
        # Only positions CLOSED inside the requested window, with a known entry.
        if g["close_time"] < req_from or g["in_type"] is None:
            continue
        rows.append({
            "position": pid, "symbol": g["symbol"],
            "dir": "BUY" if g["in_type"] == mt5.DEAL_TYPE_BUY else "SELL",
            "volume": g["vol"], "price": g["close_price"],
            "profit": round(g["pnl"], 2), "time": g["close_time"], "tag": g["tag"],
        })
    rows.sort(key=lambda x: x["time"])

    curve, cum = [], 0.0
    strat = {}
    for row in rows:
        cum += row["profit"]
        curve.append({"time": row["time"], "equity": round(cum, 2)})
        # Only the app's own comment (TA-<tag>/TA:<id>) is a strategy; broker
        # close comments ([tp ..]/[sl ..]) and manual trades group as "manual".
        raw = row["tag"] or ""
        tag = (raw.replace("TA-", "").replace("TA:", "").strip() or "manual"
               if raw.startswith("TA-") or raw.startswith("TA:") else "manual")
        a = strat.setdefault(tag, {"tag": tag, "trades": 0, "wins": 0,
                                   "profit": 0.0, "gw": 0.0, "gl": 0.0})
        a["trades"] += 1
        a["profit"] += row["profit"]
        if row["profit"] >= 0:
            a["wins"] += 1
            a["gw"] += row["profit"]
        else:
            a["gl"] += -row["profit"]
    per = [{"tag": a["tag"], "trades": a["trades"],
            "winRate": round(100 * a["wins"] / a["trades"], 1) if a["trades"] else None,
            "profit": round(a["profit"], 2),
            "profitFactor": round(a["gw"] / a["gl"], 2) if a["gl"] > 0 else None}
           for a in strat.values()]
    per.sort(key=lambda x: x["profit"], reverse=True)

    wins = sum(1 for r in rows if r["profit"] >= 0)
    acct = mt5.account_info()
    return {"ok": True, "days": days, "trades": rows[-120:][::-1], "curve": curve,
            "perStrategy": per,
            "summary": {"count": len(rows), "wins": wins,
                        "winRate": round(100 * wins / len(rows), 1) if rows else None,
                        "profit": round(sum(r["profit"] for r in rows), 2)},
            "account": None if acct is None else
            {"balance": round(acct.balance, 2), "equity": round(acct.equity, 2),
             "currency": acct.currency}}


@app.get("/api/mt5/journal")
async def mt5_journal(days: int = 30):
    return await asyncio.to_thread(_mt5_journal, days)


@app.post("/api/mt5/rearm")
async def mt5_rearm():
    """Clear the safety lock and reset the health counter (manual re-arm)."""
    def go():
        _clear_lock("رفع قفل دستی")
        _HEALTH["fails"] = 0
        return {"ok": True, "lock": _lock_state()}
    return await asyncio.to_thread(go)


@app.post("/api/mt5/lock")
async def mt5_lock_now():
    """Panic button: trip the safety lock now (disarm auto-trade)."""
    def go():
        _apply_lock("manual", "قفلِ دستی توسط کاربر")
        return {"ok": True, "lock": _lock_state()}
    return await asyncio.to_thread(go)


@app.post("/api/mt5/close")
async def mt5_close(body: dict):
    result = await asyncio.to_thread(_mt5_close, body)
    if result.get("ok"):
        await asyncio.to_thread(telegram_send, (
            f"🔒 بستن پوزیشن TradingAgents\n#{result['ticket']} "
            f"{'نصف' if result.get('partial') else 'کامل'} · "
            f"{result.get('closed')} lot @ {result.get('price')}"))
    return result


@app.post("/api/mt5/modify")
async def mt5_modify(body: dict):
    return await asyncio.to_thread(_mt5_modify, body)


@app.post("/api/mt5/order")
async def mt5_order(body: dict):
    result = await asyncio.to_thread(_mt5_order, body)
    if result.get("ok"):
        await asyncio.to_thread(telegram_send, (
            f"🤖 اتوترید TradingAgents\n{result['symbol']} {body.get('dir')} "
            f"{result['volume']} lot @ {result['price']}\n"
            f"SL {result.get('sl') or '—'} · TP {result.get('tp') or '—'}"))
    return result


def telegram_send(text, reply_markup=None):
    """Send a message via the configured bot. Returns None or an error str.
    With reply_markup, attaches an inline keyboard (Approve/Reject buttons)."""
    s = load_settings()
    if not (s.get("tg_enabled") and s.get("tg_token") and s.get("tg_chat")):
        return "telegram not configured"
    try:
        import urllib.parse
        import urllib.request

        payload = {"chat_id": s["tg_chat"], "text": text}
        if reply_markup is not None:
            payload["reply_markup"] = json.dumps(reply_markup)
        data = urllib.parse.urlencode(payload).encode()
        with urllib.request.urlopen(
                f"https://api.telegram.org/bot{s['tg_token']}/sendMessage",
                data=data, timeout=15) as r:
            ok = json.load(r).get("ok")
        return None if ok else "telegram API returned not-ok"
    except Exception as e:
        return f"{type(e).__name__}: {e}"


@app.post("/api/notify")
async def notify(body: dict):
    err = await asyncio.to_thread(telegram_send, str(body.get("text", ""))[:3500])
    return {"ok": err is None, "error": err}


# ---- two-way Telegram: propose a trade with Approve/Reject buttons and let the
# phone fire it. Pending proposals live in memory keyed by a short id encoded in
# the button callback_data; a poll loop consumes callback_query updates. ----

_TG_PENDING = {}  # id -> {"body": {...order...}, "ts": float}


def _tg_api(s, method, params):
    import urllib.parse
    import urllib.request
    try:
        data = urllib.parse.urlencode(params).encode()
        with urllib.request.urlopen(
                f"https://api.telegram.org/bot{s['tg_token']}/{method}",
                data=data, timeout=30) as r:
            return json.load(r)
    except Exception:
        return None


def _tg_handle_update(s, u):
    cq = u.get("callback_query")
    if not cq:
        return
    data = str(cq.get("data") or "")
    frm = str((cq.get("from") or {}).get("id") or "")
    chat = str(((cq.get("message") or {}).get("chat") or {}).get("id") or "")
    allowed = str(s.get("tg_chat") or "")
    if allowed and allowed not in (frm, chat):  # only the configured chat may act
        _tg_api(s, "answerCallbackQuery",
                {"callback_query_id": cq.get("id"), "text": "unauthorized"})
        return
    action, _, pid = data.partition(":")
    pend = _TG_PENDING.pop(pid, None)
    msg_id = (cq.get("message") or {}).get("message_id")
    base = (cq.get("message") or {}).get("text", "")
    if action == "taok" and pend:
        result = _mt5_order(pend["body"])
        note = (f"✅ اجرا شد #{result.get('order')} @ {result.get('price')}"
                if result.get("ok") else f"✖ خطا: {result.get('error')}")
    elif action == "tano" and pend:
        note = "✖ رد شد"
    else:
        note = "⌛ منقضی شد"
    _tg_api(s, "answerCallbackQuery", {"callback_query_id": cq.get("id"), "text": note[:180]})
    if msg_id:
        _tg_api(s, "editMessageText",
                {"chat_id": chat, "message_id": msg_id, "text": f"{base}\n\n{note}"})


async def telegram_loop():
    offset = 0
    while True:
        try:
            s = load_settings()
            if s.get("tg_enabled") and s.get("tg_token") and s.get("tg_chat"):
                res = await asyncio.to_thread(
                    _tg_api, s, "getUpdates",
                    {"offset": offset, "timeout": 0,
                     "allowed_updates": json.dumps(["callback_query"])})
                for u in (res or {}).get("result", []):
                    offset = max(offset, u.get("update_id", 0) + 1)
                    await asyncio.to_thread(_tg_handle_update, s, u)
            now = time.time()  # prune proposals older than an hour
            for k in [k for k, v in _TG_PENDING.items() if now - v["ts"] > 3600]:
                _TG_PENDING.pop(k, None)
        except Exception:
            pass
        await asyncio.sleep(3)


@app.post("/api/mt5/propose")
async def mt5_propose(body: dict):
    """Send a trade to Telegram with Approve/Reject buttons instead of firing it
    now — tapping Approve on the phone executes it via the same MT5 order path."""
    s = load_settings()
    if not (s.get("tg_enabled") and s.get("tg_token") and s.get("tg_chat")):
        return {"ok": False, "error": "telegram not configured"}
    pid = uuid.uuid4().hex[:8]
    _TG_PENDING[pid] = {"body": body, "ts": time.time()}
    text = (f"🔔 پیشنهاد معامله TradingAgents\n"
            f"{body.get('symbol')} {body.get('dir')} {body.get('lot') or ''} lot\n"
            f"SL {body.get('sl') or '—'} · TP {body.get('tp') or '—'}"
            + (f"\n{body.get('comment')}" if body.get('comment') else ""))
    markup = {"inline_keyboard": [[
        {"text": "✅ تأیید", "callback_data": f"taok:{pid}"},
        {"text": "✖ رد", "callback_data": f"tano:{pid}"},
    ]]}
    err = await asyncio.to_thread(telegram_send, text, markup)
    if err:
        _TG_PENDING.pop(pid, None)
        return {"ok": False, "error": err}
    return {"ok": True, "id": pid}


# ---- price alerts (checked server-side, fire telegram even with no tab open) ----

@app.get("/api/alerts")
async def get_alerts():
    return load_settings().get("alerts", [])


@app.post("/api/alerts")
async def add_alert(body: dict):
    ticker = normalize_ticker(body.get("ticker"))
    op = body.get("op") if body.get("op") in (">=", "<=") else ">="
    try:
        price = float(body.get("price"))
    except (TypeError, ValueError):
        return JSONResponse({"error": "bad price"}, status_code=400)
    s = load_settings()
    alerts = s.get("alerts", [])
    alerts.append({"id": uuid.uuid4().hex[:8], "ticker": ticker, "op": op,
                   "price": price, "active": True,
                   "created": time.strftime("%Y-%m-%d %H:%M")})
    s["alerts"] = alerts[-30:]
    save_settings(s)
    return {"ok": True, "alerts": s["alerts"]}


@app.delete("/api/alerts/{alert_id}")
async def delete_alert(alert_id: str):
    s = load_settings()
    s["alerts"] = [a for a in s.get("alerts", []) if a.get("id") != alert_id]
    save_settings(s)
    return {"ok": True, "alerts": s["alerts"]}


def _fetch_prices(symbols):
    """Prices for the alert loop — broker tick first, yfinance for the rest."""
    import yfinance as yf

    out = dict(_mt5_prices(symbols))
    for sym in symbols:
        if sym in out:
            continue
        try:
            hist = yf.Ticker(sym).history(period="1d", interval="1m")
            if len(hist) == 0:
                hist = yf.Ticker(sym).history(period="5d")
            if len(hist):
                out[sym] = float(hist["Close"].iloc[-1])
        except Exception:
            pass
    return out


def _trail_check():
    """Ratchet the stop toward price on in-profit TA positions (percent trail),
    only ever moving the SL in the locking direction. Runs in a thread."""
    s = load_settings()
    if not (s.get("mt5_enabled") and s.get("mt5_trail")):
        return
    try:
        pct = float(s.get("mt5_trail_pct") or 0) / 100.0
    except (TypeError, ValueError):
        pct = 0.0
    if pct <= 0:
        return
    mt5, err = _mt5_connect(s)
    if err:
        return
    for p in (mt5.positions_get() or ()):
        if p.magic != 26012:
            continue
        info = mt5.symbol_info(p.symbol)
        tick = mt5.symbol_info_tick(p.symbol)
        if info is None or tick is None:
            continue
        digits = info.digits
        is_buy = p.type == mt5.POSITION_TYPE_BUY
        price = tick.bid if is_buy else tick.ask
        dist = price * pct
        if is_buy and price > p.price_open:
            new_sl = round(price - dist, digits)
            if new_sl < price and (not p.sl or new_sl > p.sl):
                _mt5_modify({"ticket": p.ticket, "sl": new_sl})
        elif (not is_buy) and price < p.price_open:
            new_sl = round(price + dist, digits)
            if new_sl > price and (not p.sl or new_sl < p.sl):
                _mt5_modify({"ticket": p.ticket, "sl": new_sl})


async def trail_loop():
    while True:
        try:
            await asyncio.to_thread(_trail_check)
        except Exception:
            pass
        await asyncio.sleep(25)


def _reconcile():
    """After a (re)start, report the open TA-tagged positions so a crash mid-
    trade doesn't leave the operator blind. magic 26012 = placed by this app."""
    s = load_settings()
    if not s.get("mt5_enabled"):
        return
    mt5, err = _mt5_connect(s)
    if err:
        return
    ta = [p for p in (mt5.positions_get() or ()) if p.magic == 26012]
    if ta:
        lines = "\n".join(
            f"#{p.ticket} {p.symbol} {'BUY' if p.type == mt5.POSITION_TYPE_BUY else 'SELL'} "
            f"{p.volume} @ {p.price_open} · P/L {round(p.profit, 2)}" for p in ta)
        telegram_send(f"♻️ راه‌اندازی TradingAgents — {len(ta)} پوزیشنِ بازِ ربات:\n{lines}")


async def reconcile_startup():
    await asyncio.sleep(4)  # let the server settle before touching MT5
    try:
        await asyncio.to_thread(_reconcile)
    except Exception:
        pass


def _in_blackout(s):
    """Current local time inside a user 'HH:MM-HH:MM' blackout window (news /
    thin session) where auto-trade entries should pause. Returns the window or None."""
    spec = str(s.get("mt5_blackout") or "").strip()
    if not spec:
        return None
    now = time.strftime("%H:%M")
    for win in spec.split(","):
        a, _, b = win.strip().partition("-")
        a, b = a.strip(), b.strip()
        if a and b and a <= now <= b:
            return win.strip()
    return None


def _losing_streak(mt5):
    """Count consecutive most-recent LOSING TradingAgents (magic 26012) trades,
    from the broker's own deal history — the read the streak lockout guards on."""
    import datetime
    to_dt = datetime.datetime.now()
    deals = mt5.history_deals_get(to_dt - datetime.timedelta(days=14), to_dt) or ()
    pos = {}
    for d in deals:
        g = pos.setdefault(d.position_id, {"pnl": 0.0, "t": 0, "opened": False, "magic": 0})
        g["pnl"] += d.profit + d.swap + d.commission
        g["t"] = max(g["t"], int(d.time))
        if d.entry == mt5.DEAL_ENTRY_IN:
            g["opened"] = True
            g["magic"] = d.magic
    closed = sorted((g for g in pos.values() if g["opened"] and g["magic"] == 26012),
                    key=lambda g: g["t"], reverse=True)
    streak = 0
    for g in closed:
        if g["pnl"] < 0:
            streak += 1
        else:
            break
    return streak


def _health_check():
    """One watchdog tick: track MT5 connection health and the day's drawdown,
    tripping or clearing the safety lock accordingly. Runs in a worker thread."""
    s = load_settings()
    if not (s.get("mt5_enabled") and s.get("mt5_guard")):
        _HEALTH["fails"] = 0
        return
    mt5, err = _mt5_connect(s)
    acct = None if err else mt5.account_info()
    if err or acct is None:
        _HEALTH["fails"] += 1
        if _HEALTH["fails"] >= 3:  # ride out a single transient blip
            _apply_lock("disconnect", f"اتصال MT5 قطع است ({err or 'account_info null'})")
        return
    _HEALTH["fails"] = 0
    # Reconnected → drop a stale disconnect lock automatically.
    lock = s.get("mt5_lock") or {}
    if lock.get("locked") and lock.get("reason") == "disconnect":
        _clear_lock("اتصال برقرار شد")
    # Daily baseline: reset each new day (and forgive a prior daily-loss lock).
    today = time.strftime("%Y-%m-%d")
    day = s.get("mt5_day") or {}
    if day.get("date") != today:
        s = load_settings()
        s["mt5_day"] = {"date": today, "start_equity": round(acct.equity, 2)}
        save_settings(s)
        if (s.get("mt5_lock") or {}).get("reason") == "daily_loss":
            _clear_lock("روز جدید")
        day = s["mt5_day"]
    # Daily loss cap (opt-in): drawdown from the day's opening equity.
    cap = float(s.get("mt5_max_daily_loss") or 0)
    if cap > 0:
        dd = acct.equity - day.get("start_equity", acct.equity)
        if dd <= -cap:
            _apply_lock("daily_loss", f"ضرر روز {dd:.2f} {acct.currency} از سقف {cap:.0f} گذشت")

    # Consecutive-loss lockout (opt-in): N losing TA trades in a row → lock; a
    # win (streak below the cap) lifts a streak lock automatically.
    streak_cap = int(s.get("mt5_max_streak") or 0)
    if streak_cap > 0:
        streak = _losing_streak(mt5)
        lk = s.get("mt5_lock") or {}
        if streak >= streak_cap:
            _apply_lock("loss_streak", f"{streak} ضررِ متوالی از سقفِ {streak_cap} رد شد")
        elif lk.get("locked") and lk.get("reason") == "loss_streak" and streak < streak_cap:
            _clear_lock("استریکِ ضرر شکست")


async def health_loop():
    while True:
        try:
            await asyncio.to_thread(_health_check)
        except Exception:
            pass
        await asyncio.sleep(45)


# ---- auto-execution engine -------------------------------------------------
# Each "armed" row is (ticker, strategy, timeframe, lot, mode). Every few
# seconds we pull that symbol's candles straight from the terminal, evaluate the
# strategy with the SAME code the chart runs, and act on a genuinely fresh
# signal. Two hard rules keep this honest:
#   * mode defaults to "shadow" — a hypothetical fill logged at the real
#     bid/ask. Live money requires an explicit, per-row opt-in.
#   * a signal fires at most once: we remember (bar time, direction) per row,
#     persisted, so a restart can't replay an old entry.
# Every existing guard (kill-switch, blackout, spread, dedup, exposure cap,
# broker stop distance, free margin) still runs — this only decides *when*.

_AUTO_INTRADAY = {"1m", "5m", "15m", "1h"}
_AUTO_MAX_BARS_SINCE = 1  # only act on the current or previous bar's signal


def _armed_rows(s):
    rows = s.get("mt5_armed") or []
    return [r for r in rows if isinstance(r, dict) and r.get("enabled")]


async def _auto_tick():
    s = load_settings()
    if not (s.get("mt5_enabled") and s.get("mt5_auto")):
        return
    rows = _armed_rows(s)
    if not rows:
        return
    if (s.get("mt5_lock") or {}).get("locked"):
        return  # safety lock: no new entries, shadow included (it must mirror live)

    fired = dict(s.get("mt5_fired") or {})
    changed = False
    for row in rows:
        rid = str(row.get("id") or f"{row.get('ticker')}:{row.get('strategy')}:{row.get('tf')}")
        ticker, strat_id = row.get("ticker"), row.get("strategy")
        tf = row.get("tf") or "1m"
        if not ticker or not strat_id:
            continue
        intraday = tf in _AUTO_INTRADAY
        count = 720 if intraday else 800
        snap = await asyncio.to_thread(_mt5_snapshot, ticker, tf, count, True)
        if not snap.get("ok"):
            continue
        res = await engine_eval({"strategy": strat_id, "bars": snap["bars"],
                                 "intraday": intraday})
        if not res or not res.get("ok"):
            continue
        sig, last = res.get("signal"), res.get("last")
        if sig in (None, "WAIT") or not last:
            continue
        if (res.get("barsSince") or 0) > _AUTO_MAX_BARS_SINCE:
            continue
        try:
            min_strength = float(row.get("min_strength") or 0)
        except (TypeError, ValueError):
            min_strength = 0
        if min_strength and (res.get("strength") or 0) < min_strength:
            continue

        stamp = f"{last.get('time')}:{last.get('dir')}"
        if fired.get(rid) == stamp:
            continue  # this exact signal already acted on

        shadow = str(row.get("mode") or "shadow") != "live"
        body = {"symbol": ticker, "dir": last["dir"], "lot": row.get("lot"),
                "sl": last.get("sl"), "tp": last.get("tp1"),
                "comment": f"TA-{strat_id}"[:26], "shadow": shadow}
        out = await asyncio.to_thread(_mt5_order, body)
        fired[rid] = stamp  # mark regardless: never spam a rejected signal
        changed = True
        tag = "🌓 سایه" if shadow else "🤖 زنده"
        if out.get("ok"):
            await asyncio.to_thread(telegram_send, (
                f"{tag} — اجرای خودکار {strat_id}\n"
                f"{out.get('symbol')} {last['dir']} {out.get('volume')} @ {out.get('price')}\n"
                f"SL {out.get('sl') or '—'} · TP {out.get('tp') or '—'}"
                + (f"\n⚠ سطوح تنظیم شد: {', '.join(out['adjusted'])}" if out.get("adjusted") else "")))
        else:
            await asyncio.to_thread(telegram_send,
                                    f"{tag} — سیگنالِ {strat_id} اجرا نشد: {out.get('error')}")

    if changed:
        s2 = load_settings()
        s2["mt5_fired"] = fired
        save_settings(s2)


async def auto_loop():
    while True:
        try:
            await _auto_tick()
        except Exception:
            pass
        await asyncio.sleep(4)


@app.get("/api/arm")
async def get_arm():
    s = load_settings()
    return {"auto": bool(s.get("mt5_auto")), "items": s.get("mt5_armed") or []}


@app.post("/api/arm")
async def post_arm(body: dict):
    """Replace the armed-strategy table. Rows default to shadow mode; going
    live is always an explicit per-row choice."""
    s = load_settings()
    items = []
    for r in (body.get("items") or [])[:20]:
        if not isinstance(r, dict) or not r.get("ticker") or not r.get("strategy"):
            continue
        items.append({
            "id": str(r.get("id") or uuid.uuid4().hex[:8]),
            "ticker": str(r["ticker"]).upper().strip(),
            "strategy": str(r["strategy"]),
            "tf": str(r.get("tf") or "1m"),
            "lot": r.get("lot") or None,
            "min_strength": r.get("min_strength") or 0,
            "mode": "live" if r.get("mode") == "live" else "shadow",
            "enabled": bool(r.get("enabled")),
        })
    s["mt5_armed"] = items
    if "auto" in body:
        s["mt5_auto"] = bool(body["auto"])
    save_settings(s)
    return {"ok": True, "auto": bool(s.get("mt5_auto")), "items": items}


async def alert_loop():
    while True:
        try:
            s = load_settings()
            active = [a for a in s.get("alerts", []) if a.get("active")]
            if active:
                prices = await asyncio.to_thread(
                    _fetch_prices, sorted({a["ticker"] for a in active}))
                changed = False
                for a in active:
                    p = prices.get(a["ticker"])
                    if p is None:
                        continue
                    hit = p >= a["price"] if a["op"] == ">=" else p <= a["price"]
                    if hit:
                        a["active"] = False
                        a["triggered_at"] = time.strftime("%Y-%m-%d %H:%M")
                        a["triggered_price"] = round(p, 4)
                        changed = True
                        await asyncio.to_thread(
                            telegram_send,
                            f"⏰ هشدار قیمت TradingAgents\n{a['ticker']} به "
                            f"{p:,.2f} رسید (شرط: {a['op']} {a['price']:,.2f})")
                if changed:
                    save_settings(s)
        except Exception:
            pass
        await asyncio.sleep(60)


# ---- daily scheduled analysis (uses the last run's configuration) ----

async def run_scheduled():
    s = load_settings()
    cfg = s.get("last_run")
    if not cfg:
        return
    cmd = [
        worker_python(), "-u", str(WORKER_PATH),
        "--ticker", cfg.get("ticker", "GC=F"),
        "--date", time.strftime("%Y-%m-%d"),
        "--provider", cfg.get("provider", "ollama"),
        "--model", cfg.get("model", "qwen2.5:7b"),
        "--rounds", str(cfg.get("rounds", 1)),
        "--language", cfg.get("language", "Persian"),
        "--analysts", cfg.get("analysts", "market,social,news,fundamentals"),
        "--cache-ttl", str(int(s.get("llm_cache_min") or 0)),
    ]
    env = {**os.environ, **read_dotenv(),
           "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, env=env, cwd=str(PROJECT_DIR))
    signal = decision = reports = None
    started = time.time()
    try:
        while True:
            if time.time() - started > 2400:  # 40 min hard cap
                proc.kill()
                break
            raw = await proc.stdout.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            msg = parse_line(line)
            if msg["type"] == "signal":
                signal = msg["data"]
            elif msg["type"] == "decision":
                decision = msg["data"]
            elif msg["type"] == "reports":
                reports = msg["data"]
        await proc.wait()
    finally:
        if proc.returncode is None:
            proc.kill()
    if decision is None and signal is None:
        await asyncio.to_thread(
            telegram_send, "🤖 اجرای زمان‌بندی‌شده TradingAgents ناموفق بود")
        return
    entry = {"ts": time.strftime("%Y-%m-%d %H:%M"),
             "ticker": cfg.get("ticker", ""), "date": time.strftime("%Y-%m-%d"),
             "decision": str(decision or (signal or {}).get("direction", "")),
             "provider": cfg.get("provider", ""), "model": cfg.get("model", ""),
             "language": cfg.get("language", ""), "signal": signal,
             "reports": reports, "source": "scheduler"}
    items = load_history()
    items.insert(0, entry)
    save_history(items)
    sig = signal or {}
    await asyncio.to_thread(telegram_send, (
        f"🤖 تحلیل زمان‌بندی‌شده TradingAgents\n"
        f"{entry['ticker']} — {entry['decision']}\n"
        + (f"ورود {sig.get('entry')} · حد ضرر {sig.get('stop_loss')} · "
           f"هدف‌ها {sig.get('take_profit_1')} / {sig.get('take_profit_2')}"
           if sig.get("entry") is not None else "")))


async def scheduler_loop():
    while True:
        try:
            s = load_settings()
            if s.get("sched_enabled") and s.get("sched_time"):
                today = time.strftime("%Y-%m-%d")
                if (time.strftime("%H:%M") == s.get("sched_time")
                        and s.get("sched_last") != today):
                    s["sched_last"] = today
                    save_settings(s)
                    asyncio.create_task(run_scheduled())
        except Exception:
            pass
        await asyncio.sleep(20)


@app.on_event("startup")
async def start_background_tasks():
    # One-time migration: encrypt a legacy plaintext MT5 password at rest.
    try:
        s = load_settings()
        if s.get("mt5_password") and not str(s["mt5_password"]).startswith(_PW_MARK):
            s["mt5_password"] = _enc_pw(s["mt5_password"])
            save_settings(s)
    except Exception:
        pass
    asyncio.create_task(alert_loop())
    asyncio.create_task(scheduler_loop())
    asyncio.create_task(health_loop())
    asyncio.create_task(trail_loop())
    asyncio.create_task(reconcile_startup())
    asyncio.create_task(telegram_loop())
    asyncio.create_task(auto_loop())


@app.post("/api/shutdown")
async def shutdown():
    """Power button in the UI — exits the server after the response flushes."""
    loop = asyncio.get_running_loop()
    loop.call_later(0.4, lambda: os._exit(0))
    return {"ok": True}


MARKERS = ("STAGE", "PRICES", "REPORTS", "DECISION", "SIGNAL", "ERROR")


def parse_line(raw):
    """Worker stdout line → typed message for the browser."""
    for m in MARKERS:
        tag = f"@@{m}@@"
        if raw.startswith(tag):
            body = raw[len(tag):]
            if m == "STAGE":
                return {"type": "stage", "data": body}
            try:
                return {"type": m.lower(), "data": json.loads(body)}
            except json.JSONDecodeError:
                return {"type": m.lower(), "data": body}
    return {"type": "log", "data": raw}


@app.websocket("/ws/run")
async def ws_run(ws: WebSocket):
    await ws.accept()
    proc = None
    try:
        cfg = json.loads(await ws.receive_text())
        ticker = normalize_ticker(cfg.get("ticker"))
        analysts = ",".join(cfg.get("analysts") or
                            ["market", "social", "news", "fundamentals"])
        # Remember this run's config (minus the API key) for the scheduler.
        s = load_settings()
        s["last_run"] = {"ticker": ticker, "provider": cfg.get("provider"),
                         "model": cfg.get("model"),
                         "rounds": int(cfg.get("rounds", 1)),
                         "language": cfg.get("language", "Persian"),
                         "analysts": analysts}
        save_settings(s)
        cmd = [
            worker_python(), "-u", str(WORKER_PATH),
            "--ticker", ticker,
            "--date", str(cfg.get("date")),
            "--provider", str(cfg.get("provider", "ollama")),
            "--model", str(cfg.get("model", "qwen2.5:7b")),
            "--rounds", str(int(cfg.get("rounds", 1))),
            "--language", str(cfg.get("language", "Persian")),
            "--analysts", analysts,
            "--cache-ttl", str(int(s.get("llm_cache_min") or 0)),
        ]
        env = {**os.environ, **read_dotenv(),
               "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
        api_key = (cfg.get("apiKey") or "").strip()
        env_var = PROVIDER_ENV.get(cfg.get("provider"))
        if api_key and env_var:
            env[env_var] = api_key

        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env=env, cwd=str(PROJECT_DIR),
        )

        async def pump():
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if line:
                    await ws.send_json(parse_line(line))
            code = await proc.wait()
            await ws.send_json({"type": "exit", "data": code})

        async def listen():
            # The only client message is {"action": "stop"}.
            while True:
                msg = json.loads(await ws.receive_text())
                if msg.get("action") == "stop" and proc.returncode is None:
                    proc.kill()

        pump_task = asyncio.create_task(pump())
        listen_task = asyncio.create_task(listen())
        done, pending = await asyncio.wait(
            {pump_task, listen_task}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({"type": "error", "data": f"{type(e).__name__}: {e}"})
        except Exception:
            pass
    finally:
        if proc and proc.returncode is None:
            proc.kill()
        try:
            await ws.close()
        except Exception:
            pass


if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str):
        file = STATIC_DIR / path
        if path and file.is_file():
            return FileResponse(file)
        return FileResponse(STATIC_DIR / "index.html")
