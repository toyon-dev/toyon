import type { OwnedWorktree, RepoInfo, TrunkStatus } from "@toyon/shared";
import { useSock } from "../../state/context.tsx";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import { cx } from "../../ui/cx.ts";
import type { DaemonSocket } from "../../ws.ts";
import { type Source, sourceOptions, sourcePick } from "./sourceChip.ts";
import "./chips.css";

/** a move of one shared command for this worktree's page, from the chip or the flip's card in the
 * chat: the question first where there is one (handing a proc back to main's drops what it held),
 * then the frame; nothing for the row that is already the value */
export function pickSource(sock: DaemonSocket | null, name: string, from: Source, to: Source, worktreeId: string) {
  const pick = sourcePick(name, from, to, worktreeId);
  if (!pick) return;
  if (pick.confirm && !window.confirm(pick.confirm)) return;
  sock?.send(pick.msg);
}

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
      onChange={(to) => pickSource(sock, name, value, to, wt.worktree.id)}
      onClose={onClose}
      className={cx("source-chip", held && "source-held")}
      hint={hint}
      placeholder={`where ${name} runs for this worktree`}
    />
  );
}
