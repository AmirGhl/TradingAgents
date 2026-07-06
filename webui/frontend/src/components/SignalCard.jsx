import { motion } from "motion/react";
import AnimatedNumber from "./AnimatedNumber.jsx";

function ConfidenceRing({ value, label }) {
  const R = 20;
  const C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="conf">
      <svg width="52" height="52" viewBox="0 0 52 52" role="img" aria-label={`${label}: ${pct}%`}>
        <circle cx="26" cy="26" r={R} fill="none" stroke="var(--border)" strokeWidth="5" />
        <motion.circle
          cx="26"
          cy="26"
          r={R}
          fill="none"
          stroke="var(--gold)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={C}
          initial={{ strokeDashoffset: C }}
          animate={{ strokeDashoffset: C * (1 - pct / 100) }}
          transition={{ type: "spring", stiffness: 60, damping: 20 }}
        />
      </svg>
      <div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 17, color: "var(--gold-hot)" }}>
          {value == null ? "—" : `${pct}%`}
        </div>
        {label}
      </div>
    </div>
  );
}

const DIR_CLASS = { BUY: "buy", SELL: "sell", HOLD: "hold" };
const DIR_FA = { BUY: "خرید", SELL: "فروش", HOLD: "نگه‌داری" };

/** Final decision + numeric trade levels, revealed with a spring. */
export default function SignalCard({ signal, decision, spotAdj, t, lang }) {
  const dir = (signal?.direction || String(decision || "").toUpperCase() || "HOLD").toUpperCase();
  const cls = DIR_CLASS[dir] || "hold";
  const levels = [
    { key: "entry", label: t.entry, value: signal?.entry, cls: "entry" },
    { key: "sl", label: t.stopLoss, value: signal?.stop_loss, cls: "sl" },
    { key: "tp1", label: t.tp1, value: signal?.take_profit_1, cls: "tp" },
    { key: "tp2", label: t.tp2, value: signal?.take_profit_2, cls: "tp" },
    { key: "rr", label: t.rr, value: signal?.risk_reward, cls: "rr", decimals: 1 },
    ...(signal?.atr ? [{ key: "atr", label: t.atr, value: signal.atr, cls: "" }] : []),
  ];

  return (
    <motion.div
      className="panel panel-pad"
      initial={{ opacity: 0, y: 26, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 120, damping: 18 }}
      style={{ marginBottom: 18 }}
    >
      <h3>{t.decision}</h3>
      <div className="sub">{signal?.issued_at || ""}</div>

      <div className="verdict">
        <motion.div
          className={`verdict-badge ${cls}`}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 240, damping: 14, delay: 0.15 }}
        >
          {dir}
          {lang === "fa" && (
            <span style={{ fontFamily: "var(--font-fa)", fontSize: 15, fontWeight: 700, marginInlineStart: 10 }}>
              {DIR_FA[dir]}
            </span>
          )}
        </motion.div>
        <ConfidenceRing value={signal?.confidence} label={t.confidence} />
      </div>

      <motion.div
        className="levels"
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.06, delayChildren: 0.25 } } }}
      >
        {levels.map((lv) => (
          <motion.div
            key={lv.key}
            className={`level ${lv.cls}`}
            variants={{
              hidden: { opacity: 0, y: 14 },
              visible: { opacity: 1, y: 0 },
            }}
          >
            <div className="k">{lv.label}</div>
            <div className="v">
              <AnimatedNumber value={lv.value} decimals={lv.decimals ?? 2} />
            </div>
          </motion.div>
        ))}
      </motion.div>

      {signal?.rationale && (
        <motion.div
          className="rationale"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.55 }}
        >
          {signal.rationale}
        </motion.div>
      )}

      {signal?.entry != null && spotAdj?.spread != null && (
        <div className="spot-levels">
          <div className="spot-title">
            {t.spotLevels.replace("{pair}", spotAdj.pair)}
            <span className="spot-spread" dir="ltr">
              {t.spread}: {spotAdj.spread.toFixed(2)}
            </span>
          </div>
          <div className="levels">
            {[
              { label: t.entry, value: signal.entry - spotAdj.spread, cls: "entry" },
              { label: t.stopLoss, value: signal.stop_loss - spotAdj.spread, cls: "sl" },
              { label: t.tp1, value: signal.take_profit_1 - spotAdj.spread, cls: "tp" },
              { label: t.tp2, value: signal.take_profit_2 - spotAdj.spread, cls: "tp" },
            ].map((x) => (
              <div key={x.label} className={`level ${x.cls}`}>
                <div className="k">{x.label}</div>
                <div className="v">
                  <AnimatedNumber value={x.value} decimals={2} />
                </div>
              </div>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {t.spotNote.replace("{pair}", spotAdj.pair)}
          </div>
        </div>
      )}
      {signal?.entry != null && spotAdj?.pair && spotAdj.spread == null && (
        <div className="hint" style={{ marginTop: 10, color: "var(--gold)" }}>
          ⚠ {t.spotUnavailable}
        </div>
      )}
    </motion.div>
  );
}
