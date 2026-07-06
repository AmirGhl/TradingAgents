"""TradingAgents Launcher — double-click → web UI in the browser.

Windowless bootstrapper (no tkinter): if the server already answers on the
port it just opens the browser; otherwise it spawns `python -m webui` from
the project venv, waits for the port, then opens the browser and exits —
the server keeps running in the background (stop it with the ⏻ button in
the web UI's top bar).

Diagnostics: server output goes to webui_server.log; launcher crashes are
written to launcher_error.log and shown in a native message box.
"""

import os
import subprocess
import sys
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path

WEB_PORT = int(os.environ.get("TRADINGAGENTS_WEB_PORT", "8420"))
WEB_URL = f"http://127.0.0.1:{WEB_PORT}"
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def project_dir():
    base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
    return base.resolve()


def alert(title, text):
    """Native Win32 message box — no GUI toolkit required."""
    if os.name == "nt":
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, str(text), str(title), 0x10)
    else:
        print(f"{title}: {text}", file=sys.stderr)


def venv_python():
    """Project interpreter: the portable runtime/ first (works on any
    machine the folder is copied to), then the local dev venv."""
    root = project_dir()
    sub = "Scripts" if os.name == "nt" else "bin"
    name = "python.exe" if os.name == "nt" else "python"
    for p in (root / "runtime" / name, root / "venv" / sub / name):
        if p.exists():
            return str(p)
    return None


def port_alive():
    # Probe the static index, not /api/config — the boot check must be a
    # zero-work endpoint so polling can never back the server up.
    try:
        with urllib.request.urlopen(f"{WEB_URL}/", timeout=2.5):
            return True
    except Exception:
        return False


def main():
    if port_alive():
        webbrowser.open(WEB_URL)
        return

    py = venv_python()
    if not py:
        alert("TradingAgents",
              "پوشه runtime یا venv کنار برنامه پیدا نشد.\n"
              f"مسیر جستجو: {project_dir()}\n\n"
              "اگر این پوشه را کپی کرده‌ای، مطمئن شو پوشه runtime همراهش آمده باشد.")
        sys.exit(1)

    log_path = project_dir() / "webui_server.log"
    # Append (never truncate): a second launcher instance or a previous
    # crash must not wipe the evidence, and -u keeps the log realtime.
    log = open(log_path, "a", encoding="utf-8", errors="replace")
    log.write(f"\n--- launcher {time.strftime('%Y-%m-%d %H:%M:%S')} starting server ---\n")
    log.flush()
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(
        [py, "-u", "-m", "webui"], cwd=str(project_dir()),
        creationflags=CREATE_NO_WINDOW,
        stdout=log, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, env=env)

    for _ in range(90):  # up to ~45 s
        if port_alive():
            webbrowser.open(WEB_URL)
            return
        if proc.poll() is not None:
            # Server process died — maybe another instance grabbed the port
            # in the same instant; one final check before reporting failure.
            time.sleep(1)
            if port_alive():
                webbrowser.open(WEB_URL)
                return
            break
        time.sleep(0.5)

    tail = ""
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
        tail = "\n".join(lines[-6:])
    except OSError:
        pass
    alert("TradingAgents",
          "سرور وب بالا نیامد.\n\n"
          + (f"آخرین خطا:\n{tail}\n\n" if tail else "")
          + f"لاگ کامل: {log_path}")
    sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — last-resort diagnostics for the exe
        err_log = project_dir() / "launcher_error.log"
        try:
            err_log.write_text(traceback.format_exc(), encoding="utf-8")
        except OSError:
            pass
        alert("TradingAgents Launcher",
              f"خطا در اجرای لانچر:\n{type(e).__name__}: {e}\n\nجزئیات: {err_log}")
        sys.exit(1)
