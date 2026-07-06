import { useEffect, useRef } from "react";
import { useMotionValue, useSpring, useReducedMotion } from "motion/react";

const fmt = (v, decimals) =>
  Number(v).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

/** Numeric readout (tabular, LTR). The first value renders instantly —
 *  the spring only animates subsequent changes, so the number is always
 *  correct even if animation frames stall. */
export default function AnimatedNumber({ value, decimals = 2 }) {
  const ref = useRef(null);
  const first = useRef(true);
  const reduce = useReducedMotion();
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 90, damping: 22 });

  useEffect(() => {
    if (value == null || isNaN(value)) return;
    if (first.current || reduce) {
      first.current = false;
      mv.jump(Number(value));
      spring.jump(Number(value));
      if (ref.current) ref.current.textContent = fmt(value, decimals);
    } else {
      mv.set(Number(value));
    }
  }, [value, reduce, mv, spring, decimals]);

  useEffect(
    () =>
      spring.on("change", (v) => {
        if (ref.current) ref.current.textContent = fmt(v, decimals);
      }),
    [spring, decimals],
  );

  if (value == null || isNaN(value)) return <span>—</span>;
  return <span ref={ref}>{fmt(value, decimals)}</span>;
}
