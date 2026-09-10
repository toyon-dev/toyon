import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, type PermissionMode, type RepoInfo } from "@toyon/shared";
import { STORAGE } from "../../state/keys.ts";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import { cx } from "../../ui/cx.ts";
import { usePersisted } from "../../ui/hooks.ts";
import "./mode.css";

/** the mode a new worktree of this repo starts in: remembered per repo in this browser */
export function useNewWorktreeMode(repo: RepoInfo | null): [PermissionMode, (m: PermissionMode) => void] {
  const [stored, setStored] = usePersisted<PermissionMode>(
    STORAGE.modePrefix + (repo?.id ?? ""),
    DEFAULT_PERMISSION_MODE,
    (raw) => (PERMISSION_MODES.some((m) => m.id === raw) ? (raw as PermissionMode) : DEFAULT_PERMISSION_MODE),
  );
  return [stored, setStored];
}

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
      pickVerb="sets it"
    />
  );
}
