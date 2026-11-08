import type { OwnedWorktree, RepoInfo, TrunkStatus } from "@toyon/shared";
import { useSock } from "../../state/context.tsx";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import { cx } from "../../ui/cx.ts";
import { type Source, sourceOptions, sourcePick } from "./sourceChip.ts";
import "./chips.css";

/** Where one shared command runs for this worktree's page, shown where the prompt is typed so it is
 * never hidden state: main's copy, its own, or a remote. Click opens the three with a line each.
 * Held, in the colour a mode that waits on a person wears, when the page points at a remote and
 * this worktree has since changed what the command runs on. */
export function SourceChip({
  name,
  wt,
  repo,
  trunk,
  onClose,
}: {
  name: string;
  wt: OwnedWorktree;
  repo: RepoInfo;
  trunk: TrunkStatus | null;
  onClose?: () => void;
}) {
  const sock = useSock();
  const { value, held, hint, options } = sourceOptions(name, wt, repo, trunk);
  return (
    <ChipPicker<Source>
      value={value}
      options={options}
      onChange={(to) => {
        const pick = sourcePick(name, value, to, wt.worktree.id);
        if (!pick) return;
        if (pick.confirm && !window.confirm(pick.confirm)) return;
        sock?.send(pick.msg);
      }}
      onClose={onClose}
      className={cx("source-chip", held && "source-held")}
      hint={hint}
      placeholder={`where ${name} runs for this worktree`}
    />
  );
}
