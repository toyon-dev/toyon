// The pieces list's quiet rows in the transcript, once it is answered: that the go is making the
// worktrees, what each piece became, or that nothing started. An open list has no row here: it is
// read on the plan, and a held one is answered with the plan card. The file the list sat on stays
// a press away from the row, since once the card is gone nothing else in the chat names it. What
// a queued piece became when its sibling landed is a row of its own, since it comes long after,
// and so is a sibling's landing, which another project reports back the same way.

import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import type { ChatItem } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { DaemonRow } from "./DaemonRow.tsx";
import type { HandoffItem } from "./handoff.ts";
import { WorktreeChip } from "./WorktreeChip.tsx";

export function HandoffRow({ item, worktreeId }: { item: HandoffItem; worktreeId?: string | null }) {
  const sock = useSock();
  const dispatch = useDispatch();
  if (item.state === "held" || item.state === "proposed") return null;
  // the file the list sat on: the agent's plan when the list rode beside a plan card, else the
  // page Toyon wrote for it, each with the section drawn at its head
  const plan = item.plan;
  const file =
    plan && worktreeId ? (
      <Button
        variant="inline"
        onClick={() => openFile({ sock, dispatch }, { worktreeId, path: plan, view: "preview" })}
      >
        {item.companion ? "the plan" : "the list"}
      </Button>
    ) : null;
  if (item.state === "going") {
    return (
      <DaemonRow icon="spawn" word="handed off" tone="accent" at={item.ts}>
        {/* the shine rides an inline span: the text column fills the row, and a band sized to
            that is wider than the words, so they lit all at once rather than sweeping */}
        <span className="daemon-text">
          <span className="live-text">starting the worktrees</span>
        </span>
      </DaemonRow>
    );
  }
  if (item.state === "declined") {
    return (
      <DaemonRow icon="close" word="not handed off" tone="quiet" at={item.ts} below={item.reason}>
        <span className="daemon-text">
          nothing started
          {file && <> · {file}</>}
        </span>
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
  // every worktree named is the chip a message draws it as, with its project after it when that
  // is not this one; the piece's title stands where the worktree is not one yet (queued) or
  // where it names what was sent rather than where. A piece queued after the worktree this
  // transcript belongs to says "this branch": its chip would name the row the reader is in
  const parts: React.ReactNode[] = [];
  for (const o of started)
    parts.push(
      <span key={o.pieceId}>
        <WorktreeChip id={o.worktreeId!} title={o.title ?? titled(o.pieceId)} />
        {o.repoName ? ` in ${o.repoName}` : ""}
      </span>,
    );
  for (const o of queued) {
    const after = piece(o.pieceId)?.after;
    parts.push(
      <span key={o.pieceId}>
        {titled(o.pieceId)} queued after{" "}
        {after && "id" in after ? (
          after.id === worktreeId ? (
            "this branch"
          ) : (
            <WorktreeChip id={after.id} title={after.branch} />
          )
        ) : (
          o.after
        )}
      </span>,
    );
  }
  for (const o of sent)
    parts.push(
      <span key={o.pieceId}>
        {titled(o.pieceId)} sent to <WorktreeChip id={o.worktreeId!} title={o.title} />
        {o.repoName ? ` in ${o.repoName}` : ""}
      </span>,
    );
  if (here) parts.push(<span key="here">{`${here} here`}</span>);
  return (
    <DaemonRow
      icon="spawn"
      word="handed off"
      tone="accent"
      at={item.ts}
      below={errors.length ? errors.map((o) => `${titled(o.pieceId)}: ${o.error}`).join("; ") : undefined}
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
        {file && <> · {file}</>}
      </span>
    </DaemonRow>
  );
}

/** a queued piece's turn came, long after the list: its worktree is made, or it never will be */
export function PieceLaterRow({ item }: { item: Extract<ChatItem, { kind: "piece-later" }> }) {
  if (item.worktreeId) {
    return (
      <DaemonRow icon="spawn" word="handed off" tone="accent" at={item.ts}>
        <span className="daemon-text">
          <WorktreeChip id={item.worktreeId} title={item.title ?? "the worktree"} /> started, its branch having landed
        </span>
      </DaemonRow>
    );
  }
  return (
    <DaemonRow icon="close" word="dropped" tone="quiet" at={item.ts} below={item.reason}>
      <span className="daemon-text">{item.title ?? "a queued worktree"}</span>
    </DaemonRow>
  );
}

/** a worktree made from a piece of this one's work landed, with its pull request when the landing
 * was one: the record of the piece closing, read where it was opened. On the worktree that waited
 * for that branch before it started, the same row says it landed again; on the origin whose own
 * work waited for it, that the wait is over. */
export function PieceLandedRow({ item }: { item: Extract<ChatItem, { kind: "piece-landed" }> }) {
  return (
    <DaemonRow icon="check" word={item.again ? "landed again" : "landed"} tone="aqua" at={item.ts}>
      {/* a sibling of this project is its chip; work in another project is named with where. Its
          pull request follows in the sentence, as the list follows the handoff row's */}
      <span className="daemon-text">
        {item.same ? <WorktreeChip id={item.worktreeId} title={item.title} /> : `${item.title} in ${item.repoName}`}
        {item.awaited && ", which the work here waited for"}
        {item.url && (
          <>
            {" "}
            ·{" "}
            <Button variant="inline" onClick={() => window.open(item.url, "_blank")}>
              the PR
            </Button>
          </>
        )}
      </span>
    </DaemonRow>
  );
}
