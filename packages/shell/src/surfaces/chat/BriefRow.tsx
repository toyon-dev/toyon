// A message another worktree's agent wrote into this chat: the brief for a piece of its plan, or
// a handoff from another project. The agent here was sent it as a message, and the transcript
// holds it as one, but nobody typed it, so it is not the person's bubble: it is a row of Toyon's
// own, the mirror of the origin's split row, saying where it came from. The brief itself opens
// beside the chat on a press: in the briefs list on the origin while that file is there, the one
// place the composer's own press goes, so the two presses never open two copies of one text;
// otherwise as a document out of the transcript rather than a file, since in plan mode the
// origin's plan file holds the plan and not the brief, a handoff has no file at all, and the
// origin may be archived by the time it is read.

import type { Brief } from "@toyon/shared";
import type { ReactNode } from "react";
import { nextSeq } from "../../state/actions/file.ts";
import { useDispatch } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { rowState } from "../../ui/rowState.ts";
import { DaemonRow } from "./DaemonRow.tsx";
import { fileWord, useOriginFile } from "./originFile.ts";
import { WorktreeChip } from "./WorktreeChip.tsx";

/** the brief as the pane shows it: the origin agent's words, and the note under a rule */
export function briefDocument(brief: Brief): string {
  return brief.note ? `${brief.text.trimEnd()}\n\n---\n\nYou added: ${brief.note}\n` : brief.text;
}

export function BriefRow({
  brief,
  worktreeId,
  marked,
  children,
}: {
  brief: Brief;
  worktreeId?: string | null;
  /** the row the log marks: a search hit's */
  marked?: boolean;
  /** what the message attached, as the chips a sent message draws */
  children?: ReactNode;
}) {
  const dispatch = useDispatch();
  const list = useOriginFile(brief.file);
  const chip = <WorktreeChip id={brief.origin.id} title={brief.origin.title} />;
  const open = () => {
    if (brief.file && list.origin) return list.open();
    dispatch({
      a: "open-loose",
      v: {
        // the pane keys on a worktree, and the chat the row is in lends its id
        worktreeId: worktreeId ?? brief.origin.id,
        name: "brief.md",
        text: briefDocument(brief),
        binary: false,
        tooLarge: false,
        source: { kind: "text" },
        seq: nextSeq(),
      },
    });
  };
  return (
    <DaemonRow
      icon="spawn"
      word={brief.via}
      tone="accent"
      data-state={rowState({ cursor: marked })}
      below={[brief.note ? `you added: ${brief.note}` : undefined, children]}
    >
      <span className="daemon-text">
        {brief.via === "handoff" ? (
          <>
            from {chip}
            {brief.origin.project ? ` in ${brief.origin.project}` : ""}
          </>
        ) : brief.plan ? (
          <>
            from {fileWord(!!brief.file)} in {chip}
          </>
        ) : (
          <>from {chip}</>
        )}
        {" · "}
        <Button
          variant="inline"
          data-tip={
            brief.file && list.origin
              ? `Read the brief in ${brief.file.path}, beside the chat`
              : "Read the brief beside the chat"
          }
          onClick={open}
        >
          the brief
        </Button>
      </span>
    </DaemonRow>
  );
}
