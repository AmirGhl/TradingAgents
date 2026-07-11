"""
چک محیط — قبل از اجرای run_ollama.py این رو اجرا کن
"""
import json
import sys
import urllib.request

print("=== چک محیط TradingAgents + Ollama ===\n")

# 1. Python
print(f"[1] Python: {sys.version.split()[0]}")

# 2. پکیج‌های اصلی
packages = ["langchain_core", "langchain_openai", "langgraph", "yfinance"]
for pkg in packages:
    try:
        __import__(pkg.replace("-","_"))
        print(f"[2] {pkg}: ✓")
    except ImportError:
        print(f"[2] {pkg}: ✗  →  pip install {pkg}")

# 3. tradingagents
try:
    from tradingagents.default_config import DEFAULT_CONFIG  # noqa: F401
    print("[3] tradingagents: ✓")
except ImportError:
    print("[3] tradingagents: ✗  →  pip install -e .")

# 4. Ollama در حال اجرا هست؟
print("\n[4] بررسی Ollama...")
try:
    with urllib.request.urlopen("http://localhost:11434/api/tags", timeout=5) as r:
        data = json.loads(r.read())
        models = [m["name"] for m in data.get("models", [])]
        print("    Ollama: ✓  (در حال اجرا)")
        if models:
            print("    مدل‌های موجود:")
            for m in models:
                marker = " ← این رو داری" if "qwen2.5" in m else ""
                print(f"      - {m}{marker}")
        else:
            print("    هیچ مدلی pull نشده!")
            print("    →  ollama pull qwen2.5:7b")

        # چک qwen2.5:7b
        has_qwen = any("qwen2.5" in m for m in models)
        if not has_qwen:
            print("\n    [!] مدل qwen2.5:7b پیدا نشد!")
            print("        اجرا کن: ollama pull qwen2.5:7b")
        else:
            print("\n    [✓] qwen2.5:7b آماده‌ست!")

except Exception as e:
    print("    Ollama: ✗  (اجرا نیست یا پورت ۱۱۴۳۴ بسته‌ست)")
    print(f"    خطا: {e}")
    print("    →  ollama serve  را در یه ترمینال جداگانه اجرا کن")

print("\n=== پایان چک ===")
print("اگه همه چیز ✓ بود، اجرا کن: python run_ollama.py")
