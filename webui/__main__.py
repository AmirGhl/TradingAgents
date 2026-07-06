"""`python -m webui` — start the TradingAgents web UI."""

import os

import uvicorn

if __name__ == "__main__":
    host = os.environ.get("TRADINGAGENTS_WEB_HOST", "127.0.0.1")
    port = int(os.environ.get("TRADINGAGENTS_WEB_PORT", "8420"))
    print(f"TradingAgents Web UI → http://{host}:{port}")
    uvicorn.run("webui.server:app", host=host, port=port, log_level="warning")
