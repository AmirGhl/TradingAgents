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
import sys
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


@app.get("/api/chart")
async def get_chart(ticker: str, range: str = "6mo", interval: str = "1d"):
    """OHLCV series for lightweight-charts (unix seconds)."""
    ticker = normalize_ticker(ticker)

    def fetch():
        import yfinance as yf

        hist = yf.Ticker(ticker).history(period=range, interval=interval)
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
        return {"ticker": ticker, "bars": bars}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


@app.get("/api/price")
async def get_price(tickers: str):
    # Keyed by the raw requested token so alias symbols (EURUSD, US30 …)
    # round-trip for the client.
    pairs = [(t.strip().upper(), normalize_ticker(t))
             for t in tickers.split(",") if t.strip()]

    def fetch():
        import yfinance as yf

        out = {}
        cache = {}
        for raw, sym in pairs:
            try:
                if sym not in cache:
                    hist = yf.Ticker(sym).history(period="1d", interval="1m")
                    if len(hist) == 0:
                        hist = yf.Ticker(sym).history(period="5d")
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


def _write_json(path, data):
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def load_settings():
    return _read_json(SETTINGS_PATH, {})


def save_settings(s):
    _write_json(SETTINGS_PATH, s)


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


@app.delete("/api/history")
async def clear_history():
    save_history([])
    return {"ok": True}


# ---- settings (telegram / scheduler / MT5 auto-trade) ----

SETTING_KEYS = {"tg_enabled", "tg_token", "tg_chat",
                "sched_enabled", "sched_time",
                "mt5_enabled", "mt5_login", "mt5_password", "mt5_server",
                "mt5_lot", "mt5_suffix"}


@app.get("/api/settings")
async def get_settings():
    s = load_settings()
    out = {k: s.get(k) for k in SETTING_KEYS}
    out["alerts"] = s.get("alerts", [])
    out["last_run"] = s.get("last_run")
    return out


@app.post("/api/settings")
async def post_settings(patch: dict):
    s = load_settings()
    for k in SETTING_KEYS & set(patch):
        s[k] = patch[k]
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
    if not mt5.initialize(login=login, password=s.get("mt5_password") or "",
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


def _mt5_status():
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"enabled": False}
    out = {"enabled": True, "connected": False,
           "lot": float(s.get("mt5_lot") or 0.01)}
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
                      "currency": acct.currency}
    return out


def _mt5_order(body):
    s = load_settings()
    if not s.get("mt5_enabled"):
        return {"ok": False, "error": "MT5 auto-trade disabled in settings"}
    mt5, err = _mt5_connect(s)
    if err:
        return {"ok": False, "error": err}

    direction = str(body.get("dir", "")).upper()
    if direction not in ("BUY", "SELL"):
        return {"ok": False, "error": f"bad direction {direction!r}"}
    symbol = _mt5_resolve_symbol(mt5, str(body.get("symbol") or "").upper().strip(),
                                 s.get("mt5_suffix") or "")
    if not symbol:
        return {"ok": False, "error": f"symbol {body.get('symbol')!r} not found at this broker"}

    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        return {"ok": False, "error": f"no market data for {symbol}"}

    # Volume: clamp to the symbol's min/step.
    try:
        lot = float(body.get("lot") or s.get("mt5_lot") or 0.01)
    except (TypeError, ValueError):
        lot = 0.01
    step = info.volume_step or 0.01
    lot = max(info.volume_min or step, round(round(lot / step) * step, 8))

    price = tick.ask if direction == "BUY" else tick.bid
    digits = info.digits

    def level(key):
        try:
            v = float(body.get(key))
            return round(v, digits) if v > 0 else None
        except (TypeError, ValueError):
            return None

    sl, tp = level("sl"), level("tp")
    # Drop levels that ended up on the wrong side of the live price
    # (stale chart vs market) instead of getting a broker reject.
    if sl is not None and ((direction == "BUY") != (sl < price)):
        sl = None
    if tp is not None and ((direction == "BUY") != (tp > price)):
        tp = None

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": lot,
        "type": mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL,
        "price": price,
        "deviation": 30,
        "magic": 26012,
        "comment": str(body.get("comment") or "TradingAgents")[:26],
        "type_time": mt5.ORDER_TIME_GTC,
    }
    if sl is not None:
        request["sl"] = sl
    if tp is not None:
        request["tp"] = tp

    # Brokers disagree on filling modes — walk through them on 'unsupported'.
    result = None
    for filling in (mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN):
        result = mt5.order_send({**request, "type_filling": filling})
        if result is not None and result.retcode != 10030:  # unsupported filling
            break
    if result is None:
        return {"ok": False, "error": f"order_send failed: {mt5.last_error()[1]}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"ok": False, "error": f"[{result.retcode}] {result.comment}"}

    acct = mt5.account_info()
    return {"ok": True, "order": result.order, "deal": result.deal,
            "symbol": symbol, "volume": lot,
            "price": round(result.price or price, digits),
            "sl": sl, "tp": tp,
            "account": None if acct is None else
            {"login": acct.login, "balance": round(acct.balance, 2),
             "equity": round(acct.equity, 2), "currency": acct.currency}}


@app.get("/api/mt5/status")
async def mt5_status():
    return await asyncio.to_thread(_mt5_status)


@app.post("/api/mt5/order")
async def mt5_order(body: dict):
    result = await asyncio.to_thread(_mt5_order, body)
    if result.get("ok"):
        await asyncio.to_thread(telegram_send, (
            f"🤖 اتوترید TradingAgents\n{result['symbol']} {body.get('dir')} "
            f"{result['volume']} lot @ {result['price']}\n"
            f"SL {result.get('sl') or '—'} · TP {result.get('tp') or '—'}"))
    return result


def telegram_send(text):
    """Send a message via the configured bot. Returns None or an error str."""
    s = load_settings()
    if not (s.get("tg_enabled") and s.get("tg_token") and s.get("tg_chat")):
        return "telegram not configured"
    try:
        import urllib.parse
        import urllib.request

        data = urllib.parse.urlencode(
            {"chat_id": s["tg_chat"], "text": text}).encode()
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
    import yfinance as yf

    out = {}
    for sym in symbols:
        try:
            hist = yf.Ticker(sym).history(period="1d", interval="1m")
            if len(hist) == 0:
                hist = yf.Ticker(sym).history(period="5d")
            if len(hist):
                out[sym] = float(hist["Close"].iloc[-1])
        except Exception:
            pass
    return out


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
    asyncio.create_task(alert_loop())
    asyncio.create_task(scheduler_loop())


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
