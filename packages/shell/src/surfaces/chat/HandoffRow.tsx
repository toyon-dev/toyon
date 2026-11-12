// The pieces list's quiet rows in the transcript, once it is answered: that the go is making the
// worktrees, what each piece became, or that nothing started. An open list has no row here: it is
// read on the plan, and a held one is answered with the plan card. The file the list sat on stays
// a press away from the row, since once the card is gone nothing else in the chat names it. What
// a queued piece became when its sibling landed is a row of its own, since it comes long after,
// and so is a sibling's landing, which another project reports back the same way.

import { Fragment } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import type { ChatItem } from "../../state/store.ts";
import { openOut } from "../../ui/links.ts";
import { landedWhat, prWord } from "../recap.ts";
import { type DaemonPress, DaemonRow } from "./DaemonRow.tsx";
import { type HandoffItem, startingPieces } from "./handoff.ts";
import { WorktreeChip } from "./WorktreeChip.tsx";

export function HandoffRow({ item, worktreeId }: { item: HandoffItem; worktreeId?: string | null }) {
  const sock = useSock();
  const dispatch = useDispatch();
  if (item.state === "held" || item.state === "proposed") return null;
  // the file the list sat on: the agent's plan when the list rode beside a plan card, else the
  // page Toyon wrote for it, each with the section drawn at its head
  const plan = item.plan;
  const file: DaemonPress | undefined =
    plan && worktreeId
      ? {
          label: "details",
          tip: item.companion ? "Read the plan beside the chat" : "Read the list beside the chat",
          onPress: () => openFile({ sock, dispatch }, { worktreeId, path: plan, view: "preview" }),
        }
      : undefined;
  if (item.state === "going") {
    // the worktrees being made, by name, the same sentence the done row reads: a title with the
    // idle dot until the daemon says its worktree is up, then the row's own chip, whose dot is
    // the rail's. The dots say where the list stands, so no word says it is starting; one shines
    // only where there is nothing to name, since the sentence cannot be empty
    const names = startingPieces(item);
    return (
      <DaemonRow icon="handoff" word="handed off" tone="accent" at={item.ts}>
        <span className="daemon-text">
          {names.length === 0 ? (
            /* the shine rides an inline span: the text column fills the row, and a band sized to
               that is wider than the word, so it lit all at once rather than sweeping */
            <span className="live-text">starting</span>
          ) : (
            names.map((n, i) => (
              <Fragment key={n.pieceId}>
                {i > 0 && (i === names.length - 1 ? " and " : ", ")}
                {n.worktreeId ? (
                  <WorktreeChip id={n.worktreeId} title={n.title} />
                ) : (
                  <span className="handoff-wait">
                    {n.title}
                    <span className="dot idle" />
                  </span>
                )}
                {n.repoName ? ` in ${n.repoName}` : ""}
              </Fragment>
            ))
          )}
        </span>
      </DaemonRow>
    );
  }
  if (item.state === "declined") {
    return (
      // the word already says nothing started, so the reason is the sentence where there is one
      <DaemonRow icon="close" word="not handed off" tone="quiet" at={item.ts} press={file}>
        <span className="daemon-text">{item.reason ?? "nothing started"}</span>
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
      icon="handoff"
      word="handed off"
      tone="accent"
      at={item.ts}
      below={errors.length ? errors.map((o) => `${titled(o.pieceId)}: ${o.error}`).join("; ") : undefined}
      press={file}
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
      <DaemonRow icon="handoff" word="handed off" tone="accent" at={item.ts}>
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
 * work waited for it, that the wait is over. What that main received is the line under it: the
 * sentence names whose work it was, which is the news here, and the subjects are what came back. */
export function PieceLandedRow({ item }: { item: Extract<ChatItem, { kind: "piece-landed" }> }) {
  const url = item.url;
  const what = item.subjects && landedWhat({ subjects: item.subjects });
  return (
    <DaemonRow
      icon="check"
      word={item.again ? "landed again" : "landed"}
      tone="aqua"
      at={item.ts}
      below={what}
      press={url ? { label: prWord(url), tip: "Open the pull request", onPress: () => openOut(url) } : undefined}
    >
      {/* the worktree is its chip; work in another project is named with where */}
      <span className="daemon-text">
        <WorktreeChip id={item.worktreeId} title={item.title} />
        {item.same ? "" : ` in ${item.repoName}`}
        {item.awaited && ", which the work here waited for"}
      </span>
    </DaemonRow>
  );
}
