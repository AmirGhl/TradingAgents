import { useEffect, useRef } from "react";
import { motion } from "motion/react";

/** Auto-scrolling terminal-style live log. */
export default function LiveLog({ lines, emptyText, running }) {
  const boxRef = useRef(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = boxRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (!lines.length)
    return (
      <div className="log-empty">
        <motion.div
          className="orb"
          animate={{ scale: [1, 1.12, 1], opacity: [0.75, 1, 0.75] }}
          transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
        />
        {emptyText}
      </div>
    );

  return (
    <div
      className="log"
      ref={boxRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      aria-live="polite"
      aria-busy={running}
    >
      {lines.map((l, i) => (
        <span key={i} className={`ln ${l.kind || ""}`}>
          {l.text}
        </span>
      ))}
    </div>
  );
}
