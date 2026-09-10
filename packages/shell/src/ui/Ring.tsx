import { cx } from "./cx.ts";
import "./ring.css";

/**
 * A fraction as a ring: how full something is, at an Icon's size, in currentColor. It carries no
 * label of its own; the element it sits in says what is filling and by how much, in its tooltip.
 */
export function Ring({ fraction, className }: { fraction: number; className?: string }) {
  const r = 5.5;
  const circumference = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <svg className={cx("ring", className)} viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
      <circle className="ring-track" cx="7" cy="7" r={r} />
      <circle className="ring-fill" cx="7" cy="7" r={r} strokeDasharray={`${circumference * f} ${circumference}`} />
    </svg>
  );
}
