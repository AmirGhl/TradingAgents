import { motion } from "motion/react";

const ICONS = {
  market: "📈",
  social: "💬",
  news: "📰",
  fundamentals: "🏦",
  research: "⚖️",
  trader: "💼",
  risk: "🛡️",
  portfolio: "🏛️",
};

/**
 * Agent pipeline chips. `statuses` maps stage-key → "idle" | "run" | "done".
 */
export default function Pipeline({ stages, statuses, labels }) {
  return (
    <motion.div
      className="pipeline"
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.05 } } }}
    >
      {stages.map((key) => {
        const st = statuses[key] || "idle";
        return (
          <motion.div
            key={key}
            className={`stage ${st === "run" ? "run" : ""} ${st === "done" ? "done" : ""}`}
            variants={{
              hidden: { opacity: 0, y: 12 },
              visible: { opacity: 1, y: 0 },
            }}
          >
            <span className="ico">{st === "done" ? "✓" : ICONS[key]}</span>
            {labels[key]}
            {st === "run" && (
              <motion.span
                className="ring"
                animate={{ opacity: [0.2, 1, 0.2], scale: [1, 1.03, 1] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
          </motion.div>
        );
      })}
    </motion.div>
  );
}
