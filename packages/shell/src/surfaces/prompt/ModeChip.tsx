import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, type PermissionMode, type RepoInfo } from "@toyon/shared";
import { useCallback, useState } from "react";
import { STORAGE } from "../../state/keys.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { usePersisted } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { tip } from "../../ui/Tooltip.tsx";
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
export function ModeChip({ value, onChange }: { value: PermissionMode; onChange: (m: PermissionMode) => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      <Button
        variant="outline"
        mono
        className={cx("mode-chip", value !== "auto" && "mode-held")}
        {...tip(`${value}: ${describe(value)}. Click to change`)}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
      >
        {value} <Icon name="caret" className="icon-inline" />
      </Button>
      {anchor && (
        <Menu
          anchor={anchor}
          onClose={close}
          items={PERMISSION_MODES.map((m) => ({
            label: (
              <span className="mode-row">
                <b>{m.name}</b>
                <span className="mode-desc row-dim">{m.description}</span>
              </span>
            ),
            onClick: () => onChange(m.id),
          }))}
        />
      )}
    </>
  );
}
