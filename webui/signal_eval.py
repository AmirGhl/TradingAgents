"""Evaluate past GUI signals against actual price action.

Reads a JSON list of jobs from stdin:
  [{"i": 0, "ticker": "GC=F", "date": "2026-06-29", "dir": "BUY",
    "entry": 4134.6, "sl": 4066.0, "tp1": 4238.0, "tp2": 4340.0}, ...]

Prints a JSON list of {"i": ..., "outcome": ...} where outcome is one of:
  tp2, tp1, sl, open, no_entry, ?

Convention: after TP1 is hit the stop is assumed moved to break-even, so a
later return to entry closes the trade as tp1 (not sl).
"""

import json
import sys

import yfinance as yf


def evaluate(job):
    hist = yf.Ticker(job["ticker"]).history(start=job["date"])
    if len(hist) < 1:
        return "?"
    entry, sl = job["entry"], job["sl"]
    tp1, tp2 = job["tp1"], job["tp2"]
    long_side = job["dir"] != "SELL"
    entered = False
    hit_tp1 = False
    for _, row in hist.iterrows():
        hi, lo = float(row["High"]), float(row["Low"])
        if not entered:
            if lo <= entry <= hi:
                entered = True
            else:
                continue
        if long_side:
            if hit_tp1:
                if hi >= tp2:
                    return "tp2"
                if lo <= entry:
                    return "tp1"  # break-even stop after TP1
            else:
                if lo <= sl:
                    return "sl"
                if hi >= tp2:
                    return "tp2"
                if hi >= tp1:
                    hit_tp1 = True
        else:
            if hit_tp1:
                if lo <= tp2:
                    return "tp2"
                if hi >= entry:
                    return "tp1"
            else:
                if hi >= sl:
                    return "sl"
                if lo <= tp2:
                    return "tp2"
                if lo <= tp1:
                    hit_tp1 = True
    if not entered:
        return "no_entry"
    return "tp1" if hit_tp1 else "open"


def main():
    jobs = json.loads(sys.stdin.read() or "[]")
    out = []
    for job in jobs:
        try:
            out.append({"i": job["i"], "outcome": evaluate(job)})
        except Exception:
            out.append({"i": job["i"], "outcome": "?"})
    print(json.dumps(out))


if __name__ == "__main__":
    main()
