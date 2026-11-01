import { PERMISSION_MODES, type PermissionMode } from "@toyon/shared";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import { cx } from "../../ui/cx.ts";
import "./chips.css";

const describe = (id: PermissionMode) => PERMISSION_MODES.find((m) => m.id === id)?.description ?? "";

/** What the agent may do without asking, shown where the prompt is typed so it is never hidden
 * state. Click opens the three modes with a line each; `plan` and `ask` say so in the rail too. */
export function ModeChip({
  value,
  onChange,
  onClose,
}: {
  value: PermissionMode;
  onChange: (m: PermissionMode) => void;
  onClose?: () => void;
}) {
  return (
    <ChipPicker
      value={value}
      options={PERMISSION_MODES.map((m) => ({ id: m.id, label: m.name, description: m.description }))}
      onChange={onChange}
      onClose={onClose}
      className={cx("mode-chip", value !== "auto" && "mode-held")}
      hint={`${value}: ${describe(value)}. Click to change`}
      placeholder="what the agent may do without asking"
    />
  );
}
