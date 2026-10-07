import { useId } from "react";
import { cx } from "./cx.ts";
import "./ring.css";

const clamp = (n: number | undefined) => Math.max(0, Math.min(1, Number.isFinite(n) ? (n as number) : 0));

/**
 * A fraction as a ring: how full something is, at an Icon's size, in currentColor. It carries no
 * label of its own; the element it sits in says what is filling and by how much, in its tooltip.
 *
 * `level` is a second fraction, drawn as a disc inside the ring filling from the bottom: a window
 * spent against a clock rather than a path walked and compacted back, so it reads as a level and
 * not as a second arc. Absent, the inside stays empty.
 */
export function Ring({ fraction, level, className }: { fraction: number; level?: number; className?: string }) {
  const r = 5.5;
  const circumference = 2 * Math.PI * r;
  const f = clamp(fraction);
  const clip = useId();
  // the disc sits inside the arc's inner edge with a stroke's width of air between them
  const disc = 3.5;
  const height = 2 * disc * clamp(level);
  return (
    <svg className={cx("ring", className)} viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
      {level !== undefined && (
        <>
          <clipPath id={clip}>
            <circle cx="7" cy="7" r={disc} />
          </clipPath>
          <rect
            className="ring-level"
            clipPath={`url(#${clip})`}
            x="0"
            y={7 + disc - height}
            width="14"
            height={height}
          />
        </>
      )}
      <circle className="ring-track" cx="7" cy="7" r={r} />
      <circle className="ring-fill" cx="7" cy="7" r={r} strokeDasharray={`${circumference * f} ${circumference}`} />
    </svg>
  );
}
