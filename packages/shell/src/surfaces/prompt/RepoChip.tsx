import { useState } from "react";
import { useStore } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { ProjectPicker } from "../palettes/ProjectPicker.tsx";

/** which project the new worktree branches from. ⌘K is scoped to the active repo, and the scrim
 * covers the status bar pill that would name it. The switcher is the same
 * picker that pill drops, embedded rather than opened as an overlay of its own: `activate-repo`
 * leaves `overlay` alone, so the prompt stays up and the text already typed survives the switch.
 * Nothing to say with a single project, so nothing renders. */
export function RepoChip({ onClose }: { onClose?: () => void }) {
  const repos = useStore((s) => s.repos);
  const current = useStore((s) => s.activeRepoId);
  const [open, setOpen] = useState(false);
  const repo = repos.find((r) => r.id === current);
  if (!repo || repos.length < 2) return null;
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    // Escape inside the picker reaches app/keys.ts otherwise, which knows only about the store's
    // overlay and would shut the prompt behind it. Same rule the context menu writes down: the
    // topmost thing owns Escape, and this one is not in the store.
    <span
      className="repo-chip-wrap"
      onKeyDownCapture={(e) => {
        if (!open || e.key !== "Escape") return;
        e.stopPropagation();
        close();
      }}
    >
      <Button
        variant="outline"
        mono
        className="repo-chip"
        {...tip("the project this worktree branches from; click to switch")}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="repo-name">{repo.name}</span>
      </Button>
      {open && <ProjectPicker embedded onDone={close} />}
    </span>
  );
}
