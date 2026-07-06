import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { marked } from "marked";
import DOMPurify from "dompurify";

const KEYS = [
  "market_report",
  "sentiment_report",
  "news_report",
  "fundamentals_report",
  "investment_plan",
  "trader_investment_plan",
  "final_trade_decision",
];

export default function ReportTabs({ reports, t, dir }) {
  const [active, setActive] = useState("final_trade_decision");
  const html = useMemo(() => {
    const md = reports?.[active];
    if (!md) return null;
    return DOMPurify.sanitize(marked.parse(md));
  }, [reports, active]);

  return (
    <div className="panel panel-pad">
      <div className="rtabs" role="tablist">
        {KEYS.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={active === k}
            className={`rtab ${active === k ? "on" : ""}`}
            onClick={() => setActive(k)}
          >
            {t.reportTabs[k]}
            {reports?.[k] ? " •" : ""}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.div
          key={active}
          className="report-body"
          dir={dir}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22 }}
        >
          {html ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <div className="empty">{t.noReport}</div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
