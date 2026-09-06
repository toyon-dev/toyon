import type { ReactNode } from "react";

/** the standard palette row: label left, hint right, "●" on the current choice */
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
      <span className="cmd-label">
        {current ? "● " : ""}
        {label}
      </span>
      {hint ? <span className="cmd-hint">{hint}</span> : null}
    </>
  );
}
