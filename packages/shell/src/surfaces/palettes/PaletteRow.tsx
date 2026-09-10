import type { ReactNode } from "react";

/** the standard palette row: label left, hint right, and the current choice marked the way every
 * other selected row in the app is marked, with a bar down its leading edge */
export function PaletteRow({
  label,
  hint,
  current = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  current?: boolean;
}) {
  return (
    <>
      {current && <span className="row-current" aria-hidden="true" />}
      <span className="picker-label">{label}</span>
      {hint ? <span className="picker-hint row-dim">{hint}</span> : null}
    </>
  );
}
