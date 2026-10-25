// The pieces list's quiet rows in the transcript, once it is answered: that the go is making the
// worktrees, what each piece became, or that the list was sent back. An open list has no row
// here: it is read on the plan, and a held one is answered with the plan card. What a queued piece
// became when its sibling landed is a row of its own, since it comes long after.

import type { ChatItem } from "../../state/store.ts";
import { DaemonRow } from "./DaemonRow.tsx";
import type { PiecesItem } from "./pieces.ts";
import { WorktreeChip } from "./WorktreeChip.tsx";

export function PiecesRow({ item }: { item: PiecesItem }) {
  if (item.state === "held" || item.state === "proposed") return null;
  if (item.state === "going") {
    return (
      <DaemonRow icon="spawn" word="split" tone="accent" at={item.ts}>
        <span className="daemon-text live-text">starting the worktrees</span>
      </DaemonRow>
    );
  }
  if (item.state === "declined") {
    return (
      <DaemonRow
        icon="close"
        word="not split"
        tone="quiet"
        at={item.ts}
        below={item.reason ? <div className="daemon-below row-dim">{item.reason}</div> : undefined}
      >
        <span className="daemon-text">the list was sent back</span>
      </DaemonRow>
    );
  }
  const piece = (pieceId: string) => item.pieces.find((p) => p.id === pieceId);
  const titled = (pieceId: string) => piece(pieceId)?.title ?? pieceId;
  const started = item.outcomes.filter((o) => o.fate === "worktree" && o.worktreeId);
  const queued = item.outcomes.filter((o) => o.fate === "worktree" && o.after);
  const sent = item.outcomes.filter((o) => o.fate === "send" && o.worktreeId);
  const here = item.outcomes.filter((o) => o.fate === "here").length;
  const errors = item.outcomes.filter((o) => o.error);
  // every worktree named is the chip a message draws it as; the piece's title stands where the
  // worktree is not one yet (queued) or where it names what was sent rather than where
  const parts: React.ReactNode[] = [];
  for (const o of started)
    parts.push(<WorktreeChip key={o.pieceId} id={o.worktreeId!} title={o.title ?? titled(o.pieceId)} />);
  for (const o of queued) {
    const after = piece(o.pieceId)?.after;
    parts.push(
      <span key={o.pieceId}>
        {titled(o.pieceId)} queued after {after ? <WorktreeChip id={after.id} title={after.branch} /> : o.after}
      </span>,
    );
  }
  for (const o of sent)
    parts.push(
      <span key={o.pieceId}>
        {titled(o.pieceId)} sent to <WorktreeChip id={o.worktreeId!} title={o.title} />
      </span>,
    );
  if (here) parts.push(<span key="here">{`${here} here`}</span>);
  return (
    <DaemonRow
      icon="spawn"
      word="split"
      tone="accent"
      at={item.ts}
      below={
        errors.length ? (
          <div className="daemon-below row-dim">{errors.map((o) => `${titled(o.pieceId)}: ${o.error}`).join("; ")}</div>
        ) : undefined
      }
    >
      <span className="daemon-text">
        {parts.length === 0
          ? "nothing started"
          : parts.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the separators are positional
              <span key={i}>
                {i > 0 && ", "}
                {p}
              </span>
            ))}
      </span>
    </DaemonRow>
  );
}

/** a queued piece's turn came, long after the list: its worktree is made, or it never will be */
export function PieceLaterRow({ item }: { item: Extract<ChatItem, { kind: "piece-later" }> }) {
  if (item.worktreeId) {
    return (
      <DaemonRow icon="spawn" word="split" tone="accent" at={item.ts}>
        <span className="daemon-text">
          <WorktreeChip id={item.worktreeId} title={item.title ?? "the worktree"} /> started, its branch having landed
        </span>
      </DaemonRow>
    );
  }
  return (
    <DaemonRow
      icon="close"
      word="dropped"
      tone="quiet"
      at={item.ts}
      below={item.reason ? <div className="daemon-below row-dim">{item.reason}</div> : undefined}
    >
      <span className="daemon-text">{item.title ?? "a queued piece"}</span>
    </DaemonRow>
  );
}
