"""Worker process for the TradingAgents web UI.

Runs one analysis and streams agent output to stdout. The server parses the
@@-prefixed marker lines; everything else is shown verbatim in the live log.
Spawned by webui/server.py with the project root as cwd (so the
`tradingagents` package resolves from there).
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

# ---- LLM analysis cache: skip the (slow, rate-limited) multi-agent graph when
# the same (ticker, date, provider, model, analysts, rounds) was analyzed within
# the TTL and price hasn't moved more than ~0.5 ATR. Opt-in via --cache-ttl. ----

CACHE_PATH = Path(__file__).resolve().parent.parent / "gui_reports" / "llm_cache.json"


def _cache_key(ticker, date, provider, model, rounds, analysts):
    raw = f"{ticker}|{date}|{provider}|{model}|{rounds}|{','.join(sorted(analysts))}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _cache_read():
    try:
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _cache_write(store):
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Bound the store so it can't grow without limit.
        if len(store) > 50:
            store = dict(sorted(store.items(), key=lambda kv: kv[1].get("ts", 0))[-50:])
        CACHE_PATH.write_text(json.dumps(store), encoding="utf-8")
    except OSError:
        pass


def atr14(highs, lows, closes, period=14):
    """Wilder ATR of the last bar, or None if not enough data."""
    if len(closes) < period + 1:
        return None
    trs = [max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]),
               abs(lows[i] - closes[i - 1])) for i in range(1, len(closes))]
    atr = sum(trs[:period]) / period
    for tr in trs[period:]:
        atr = (atr * (period - 1) + tr) / period
    return atr


def _round_level(value, ref):
    digits = 4 if ref < 1 else (2 if ref < 100 else 1)
    return round(value, digits)


def fallback_signal(direction, prices, language):
    """Deterministic ATR-anchored levels — used when the LLM's JSON is
    missing or fails the sanity check, so the user always gets numbers."""
    closes, highs, lows = prices["close"], prices["high"], prices["low"]
    last = closes[-1]
    atr = atr14(highs, lows, closes) or last * 0.02
    lo20 = min(lows[-20:])
    if direction == "SELL":
        entry, sl = last, last + 1.5 * atr
        tp1, tp2 = last - 1.5 * atr, last - 3 * atr
    elif direction == "BUY":
        entry, sl = last, last - 1.5 * atr
        tp1, tp2 = last + 1.5 * atr, last + 3 * atr
    else:  # HOLD → conditional long plan at recent support
        entry = lo20
        sl = entry - 1.5 * atr
        tp1, tp2 = entry + 1.5 * atr, entry + 3 * atr
    if language == "Persian":
        note = "سطوح بر اساس ATR(14) و حمایت/مقاومت ۲۰ روزه محاسبه شده‌اند."
        if direction == "HOLD":
            note = "پلن شرطی: فقط در صورت رسیدن قیمت به حمایت ۲۰ روزه وارد شو. " + note
    else:
        note = "Levels anchored to ATR(14) and the 20-bar range."
        if direction == "HOLD":
            note = "Conditional plan: enter only at the 20-bar support. " + note
    return {"direction": direction, "confidence": None,
            "entry": _round_level(entry, last), "stop_loss": _round_level(sl, last),
            "take_profit_1": _round_level(tp1, last),
            "take_profit_2": _round_level(tp2, last),
            "risk_reward": round(abs(tp2 - entry) / max(abs(entry - sl), 1e-9), 1),
            "rationale": note}


def _sane(sig, direction):
    """Reject LLM levels that are ordered wrong for the trade direction."""
    try:
        e, sl = float(sig["entry"]), float(sig["stop_loss"])
        t1, t2 = float(sig["take_profit_1"]), float(sig["take_profit_2"])
    except (KeyError, TypeError, ValueError):
        return False
    if direction == "SELL":
        return t2 <= t1 < e < sl
    return sl < e < t1 <= t2  # BUY and conditional-HOLD plans are long


def build_signal(ta, args, prices, state, decision):
    """One extra quick-LLM call that turns the verdict into a numeric signal."""
    d = str(decision).upper()
    direction = "BUY" if "BUY" in d else ("SELL" if "SELL" in d else "HOLD")
    if not prices or len(prices.get("close", [])) < 21:
        return {"direction": direction, "confidence": None, "entry": None,
                "stop_loss": None, "take_profit_1": None, "take_profit_2": None,
                "risk_reward": None, "rationale": ""}

    closes, highs, lows = prices["close"], prices["high"], prices["low"]
    last = closes[-1]
    atr = atr14(highs, lows, closes) or last * 0.02
    lo20, hi20 = min(lows[-20:]), max(highs[-20:])
    verdict = str(state.get("final_trade_decision", ""))[:1500]

    prompt = f"""You are a professional trade-signal generator. Convert the analysis below into ONE strict JSON object. Output ONLY the JSON, nothing else.

Final decision from the analyst team: {direction}
Risk-team verdict (excerpt): {verdict}

Market snapshot for {args.ticker}:
- Last close: {last}
- ATR(14): {round(atr, 4)}
- 20-bar high (resistance): {hi20}
- 20-bar low (support): {lo20}

Rules:
- "direction" must be "{direction}" (consistent with the team's decision).
- Anchor prices to the last close. Stop-loss 1-2 ATR from entry; take_profit_1 about 1.5-2.5 ATR; take_profit_2 about 2.5-4 ATR. Respect the support/resistance levels.
- For SELL: stop above entry, targets below. For BUY: stop below entry, targets above.
- If direction is HOLD, give a conditional BUY plan with entry near support.
- "confidence": integer 0-100 reflecting how strong and unanimous the analysis is.
- "risk_reward": |take_profit_2 - entry| / |entry - stop_loss|, one decimal.
- "rationale": at most 2 short sentences in {"Persian (فارسی)" if args.language == "Persian" else "English"}.

JSON schema:
{{"direction": "...", "confidence": 0, "entry": 0.0, "stop_loss": 0.0, "take_profit_1": 0.0, "take_profit_2": 0.0, "risk_reward": 0.0, "rationale": "..."}}"""

    try:
        result = ta.quick_thinking_llm.invoke(prompt)
        content = result.content if hasattr(result, "content") else str(result)
        content = str(content)
        obj = json.loads(content[content.find("{"):content.rfind("}") + 1])
        if not _sane(obj, direction):
            raise ValueError("levels failed sanity check")
        obj["direction"] = direction
        for key in ("entry", "stop_loss", "take_profit_1", "take_profit_2"):
            obj[key] = _round_level(float(obj[key]), last)
        obj["risk_reward"] = round(float(obj.get("risk_reward") or
                                         abs(obj["take_profit_2"] - obj["entry"])
                                         / max(abs(obj["entry"] - obj["stop_loss"]), 1e-9)), 1)
        try:
            obj["confidence"] = max(0, min(100, int(obj.get("confidence"))))
        except (TypeError, ValueError):
            obj["confidence"] = None
        obj["rationale"] = str(obj.get("rationale", ""))[:400]
        return obj
    except Exception:
        return fallback_signal(direction, prices, args.language)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--provider", default="ollama",
                        choices=["ollama", "anthropic", "groq", "openrouter"])
    parser.add_argument("--model", default="qwen2.5:7b")
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--language", default="English")
    parser.add_argument("--analysts", default="market,social,news,fundamentals",
                        help="comma-separated subset of: market,social,news,fundamentals")
    parser.add_argument("--max-retries", type=int, default=4,
                        help="LLM SDK retry budget for transient errors (429/5xx). 0 disables.")
    parser.add_argument("--cache-ttl", type=int, default=0,
                        help="Minutes to reuse a cached analysis for the same "
                             "ticker/date/model when price barely moved. 0 = off.")
    args = parser.parse_args()

    valid = {"market", "social", "news", "fundamentals"}
    analysts = [a for a in args.analysts.split(",") if a.strip() in valid]
    if not analysts:
        analysts = sorted(valid)

    print("@@STAGE@@loading", flush=True)

    # Price series first — the chart tab shows it immediately, and the cache
    # check needs the current price/ATR before deciding to run the graph.
    prices = None
    try:
        import yfinance as yf

        hist = yf.Ticker(args.ticker).history(period="6mo")
        if len(hist) >= 2:
            prices = {
                "dates": [d.strftime("%Y-%m-%d") for d in hist.index],
                "open": [round(float(v), 2) for v in hist["Open"]],
                "high": [round(float(v), 2) for v in hist["High"]],
                "low": [round(float(v), 2) for v in hist["Low"]],
                "close": [round(float(v), 2) for v in hist["Close"]],
                "volume": [int(v) for v in hist["Volume"]],
            }
            print("@@PRICES@@" + json.dumps(prices), flush=True)
    except Exception:
        prices = None

    cur_price = prices["close"][-1] if prices and prices.get("close") else None
    cur_atr = (atr14(prices["high"], prices["low"], prices["close"])
               if prices and len(prices.get("close", [])) >= 15 else None)
    ckey = _cache_key(args.ticker, args.date, args.provider, args.model, args.rounds, analysts)

    # Cache hit → emit the stored analysis and skip the multi-agent LLM run
    # entirely (saves tokens and dodges the rate limit) — unless price moved.
    if args.cache_ttl > 0 and cur_price is not None:
        ent = _cache_read().get(ckey)
        if ent and (time.time() - ent.get("ts", 0)) < args.cache_ttl * 60:
            moved = bool(cur_atr and ent.get("price") is not None
                         and abs(cur_price - ent["price"]) > 0.5 * cur_atr)
            if not moved:
                print("♻ cache hit — reusing a recent analysis (no LLM call)", flush=True)
                print("@@REPORTS@@" + json.dumps(ent["reports"], ensure_ascii=False), flush=True)
                print("@@DECISION@@" + json.dumps(ent["decision"], ensure_ascii=False), flush=True)
                if ent.get("signal"):
                    print("@@SIGNAL@@" + json.dumps(ent["signal"], ensure_ascii=False), flush=True)
                print("@@STAGE@@done", flush=True)
                return

    from tradingagents.default_config import DEFAULT_CONFIG
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    config = DEFAULT_CONFIG.copy()
    config["llm_provider"] = args.provider
    config["deep_think_llm"] = args.model
    config["quick_think_llm"] = args.model
    config["max_debate_rounds"] = args.rounds
    config["max_risk_discuss_rounds"] = args.rounds
    config["output_language"] = args.language
    # Let the LLM SDK ride out transient rate limits (429) and 5xx with its own
    # exponential backoff instead of crashing the run — free-tier cloud models
    # (OpenRouter/Groq) throttle upstream unpredictably.
    if args.max_retries and args.max_retries > 0:
        config["llm_max_retries"] = args.max_retries

    ta = TradingAgentsGraph(selected_analysts=analysts, debug=True, config=config)
    print("@@STAGE@@running", flush=True)

    state, decision = ta.propagate(args.ticker, args.date)

    reports = {
        "market_report": state.get("market_report", ""),
        "sentiment_report": state.get("sentiment_report", ""),
        "news_report": state.get("news_report", ""),
        "fundamentals_report": state.get("fundamentals_report", ""),
        "investment_plan": state.get("investment_plan", ""),
        "trader_investment_plan": state.get("trader_investment_plan", ""),
        "final_trade_decision": state.get("final_trade_decision", ""),
    }
    print("@@REPORTS@@" + json.dumps(reports, ensure_ascii=False), flush=True)
    print("@@DECISION@@" + json.dumps(str(decision), ensure_ascii=False), flush=True)

    try:
        signal = build_signal(ta, args, prices, state, decision)
    except Exception:
        signal = None
    if signal:
        signal["issued_at"] = time.strftime("%Y-%m-%d %H:%M")
        if prices and len(prices.get("close", [])) >= 21:
            a = atr14(prices["high"], prices["low"], prices["close"])
            if a:
                signal["atr"] = round(a, 4)
        print("@@SIGNAL@@" + json.dumps(signal, ensure_ascii=False), flush=True)

    # Store the fresh result so a quick re-run within the TTL reuses it.
    if args.cache_ttl > 0 and cur_price is not None:
        store = _cache_read()
        store[ckey] = {"ts": time.time(), "price": cur_price,
                       "reports": reports, "decision": str(decision), "signal": signal}
        _cache_write(store)

    print("@@STAGE@@done", flush=True)


def _friendly_error(exc: Exception) -> str:
    """Turn a raw SDK exception into a short, actionable line for the UI.

    Rate-limit errors from free-tier providers carry a huge JSON blob that is
    useless to a user; collapse it to a one-liner instead.
    """
    name = type(exc).__name__
    text = str(exc)
    if "RateLimit" in name or " 429" in text or "rate-limit" in text.lower():
        return ("Rate limit — the model provider is throttling requests "
                "(free-tier limit). Wait a minute and retry, or use your own "
                "API key / a paid model. | محدودیت نرخ درخواست؛ کمی صبر کن و "
                "دوباره اجرا کن یا از کلید/مدل شخصی استفاده کن.")
    if "AuthenticationError" in name or " 401" in text:
        return (f"Authentication failed — check the API key for this provider. "
                f"| کلید API این ارائه‌دهنده اشتباه یا خالی است. ({name})")
    return f"{name}: {text}"


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("@@ERROR@@" + json.dumps(_friendly_error(e), ensure_ascii=False), flush=True)
        import traceback

        traceback.print_exc()
        sys.exit(1)
