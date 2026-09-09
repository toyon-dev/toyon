import type { ReactNode } from "react";

/** One labeled row of a form: a label on the left, the control and its explanation on the right.
 * Shared by the setup pane and the new-project form on purpose. Those two are back to back in one
 * flow, since a project made here opens straight into the pane that asks how it runs, and two
 * adjacent forms built from different markup read as two different products. */
export function FormRow({ label, hint, children }: { label?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    // a label rather than a div: clicking the word focuses the control it names
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the caller's, passed as children, so the rule cannot see it
    <label className="form-row">
      <span className="form-label">{label}</span>
      <div className="form-control">
        {children}
        {hint && <span className="form-hint">{hint}</span>}
      </div>
    </label>
  );
}
