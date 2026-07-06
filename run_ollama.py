"""
TradingAgents با Ollama + Qwen 2.5:7b
--------------------------------------
قبل از اجرا:
1. مطمئن شو Ollama داره اجرا میشه: ollama serve
2. مدل رو pull کرده باشی: ollama pull qwen2.5:7b
3. پکیج‌ها نصب باشن: pip install -e . (در پوشه پروژه)
"""

import sys
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG

# --- تنظیمات مدل ---
config = DEFAULT_CONFIG.copy()
config["llm_provider"] = "ollama"
config["deep_think_llm"] = "qwen2.5:7b"
config["quick_think_llm"] = "qwen2.5:7b"
config["max_debate_rounds"] = 1        # ۱ دور = سریع‌تر و کمتر مصرف منابع
config["max_risk_discuss_rounds"] = 1
config["output_language"] = "English"  # یا "Persian" اگه خروجی فارسی می‌خوای

# --- نماد و تاریخ ---
TICKER = "AAPL"          # نماد سهم (مثلاً AAPL, TSLA, NVDA)
DATE   = "2024-06-01"    # تاریخ تحلیل (نه خیلی جدید، داده‌های تاریخی بهتره)

print(f"\n{'='*50}")
print(f"  TradingAgents | Ollama | qwen2.5:7b")
print(f"  نماد: {TICKER}  |  تاریخ: {DATE}")
print(f"{'='*50}\n")

try:
    ta = TradingAgentsGraph(debug=True, config=config)
    print(f"[✓] گراف ساخته شد — در حال تحلیل {TICKER}...\n")

    state, decision = ta.propagate(TICKER, DATE)

    print(f"\n{'='*50}")
    print("  نتیجه تصمیم نهایی:")
    print(f"{'='*50}")
    print(decision)
    print(f"{'='*50}\n")

except ConnectionError as e:
    print(f"\n[خطا] نمیشه به Ollama وصل شد:")
    print(f"  {e}")
    print("\nراه‌حل: مطمئن شو Ollama داره اجرا میشه:")
    print("  ollama serve")
    sys.exit(1)

except Exception as e:
    print(f"\n[خطا] {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
