import { useEffect, useState } from "react";

/** Confidence calibration: how the AI signal's claimed confidence has actually
 *  played out (realized winrate per 10-point bucket), from evaluated history.
 *  Surfaces a suggested minimum confidence to trust before auto-trading. */
export default function CalibrationPanel({ t }) {
  const C = t.calib;
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/calibration")
      .then((r) => r.json())
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => { alive = false; };
  }, []);

  if (!data || !data.buckets?.length) return null;

  return (
    <div className="panel panel-pad plan-sect">
      <h3>{C.title}</h3>
      <div className="sub">{C.sub.replace("{n}", data.total)}</div>
      <div className="scan-wrap">
        <table className="scan-table" dir="ltr">
          <thead>
            <tr className="scan-head">
              <th>{C.confidence}</th>
              <th>{C.trades}</th>
              <th>{C.winrate}</th>
            </tr>
          </thead>
          <tbody>
            {data.buckets.map((b) => (
              <tr key={b.bucket}>
                <td className="mono">{b.bucket}–{b.bucket + 9}%</td>
                <td className="mono">{b.n}</td>
                <td className="mono" style={{ color: b.winrate >= 50 ? "var(--green)" : "var(--red)" }}>
                  {b.winrate}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        {data.suggested_threshold != null
          ? C.threshold.replace("{n}", data.suggested_threshold)
          : C.notEnough}
      </div>
    </div>
  );
}
