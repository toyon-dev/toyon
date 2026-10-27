// The Worktrees block at the head of a plan in the editor pane: the agent's list of what its work
// splits into, one line per piece with its fate at the end, read off the plan it sits on. The
// person answers the list with the plan card (or Toyon's own card in the box); a row here is a
// fold, the idiom a tool row in the chat uses: pressed, it opens under itself with one line that
// states its fate and offers the others, then the piece's text, the plan still below. One row is
// open at a time, and Escape folds it before the pane's own close. A list of one has nothing to
// choose between, so its piece stands open under its line with no fold to press. Once the list is
// answered the fate words give way to what each piece became, so the whole picture is one press
// away from any row, and a sibling opening the origin's plan sees the same block.

import type { AttachmentRef, Piece, PieceFate } from "@toyon/shared";
import { type KeyboardEvent, useMemo, useState } from "react";
import { useSock, useUrls } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { FileChip } from "../chat/FileChip.tsx";
import { ImageChip } from "../chat/ImageChip.tsx";
import { renderMarkdown } from "../chat/markdown.ts";
import { PasteChip } from "../chat/PasteChip.tsx";
import { PickChip } from "../chat/PickChip.tsx";
import {
  effectiveFate,
  fateSentence,
  fatesFor,
  fateWord,
  type PiecesItem,
  pieceFate,
  type Wait,
  waitOf,
} from "../chat/pieces.ts";
import { WorktreeChip } from "../chat/WorktreeChip.tsx";

function Chips({ refs, worktreeId }: { refs: AttachmentRef[]; worktreeId: string }) {
  const urls = useUrls();
  if (refs.length === 0) return null;
  return (
    <div className="editor-piece-chips">
      {refs.map((a) =>
        a.kind === "image" ? (
          <ImageChip
            key={`image-${a.n}`}
            className="in-chat"
            src={urls.attachment(worktreeId, a.file)}
            n={a.n}
            name={a.name}
            width={a.width}
            height={a.height}
            bytes={a.bytes}
          />
        ) : a.kind === "file" ? (
          <FileChip
            key={`file-${a.n}`}
            className="in-chat"
            name={a.name}
            bytes={a.bytes}
            href={a.text ? urls.attachment(worktreeId, a.file) : undefined}
          />
        ) : a.kind === "paste" ? (
          <PasteChip
            key={`paste-${a.n}`}
            className="in-chat"
            n={a.n}
            name={a.name}
            source={a.source}
            lines={a.lines}
            chars={a.chars}
            preview={a.preview}
            href={urls.attachment(worktreeId, a.file)}
          />
        ) : (
          <PickChip key={`pick-${a.n}`} className="in-chat" pick={a} worktreeId={worktreeId} />
        ),
      )}
    </div>
  );
}

function Text({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="editor-piece-text md"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** what a wait reads as at the row's end: this branch, another worktree's, or a piece of the
 * same list by its title */
function waitWords(wait: Wait, selfId: string): string {
  if (wait.kind === "piece") return `after ${wait.title} lands`;
  return wait.id === selfId ? "after this branch lands" : `after ${wait.branch} lands`;
}

/** the fate at the row's end while the list is still the person's to move: plain words, with
 * the target's chip for a send */
function FateWords({
  piece,
  fate,
  wait,
  selfId,
}: {
  piece: Piece;
  fate: PieceFate;
  wait: Wait | null;
  selfId: string;
}) {
  if (fate === "send" && piece.to) {
    return (
      <>
        sent to <WorktreeChip id={piece.to.id} title={piece.to.title} inert />
      </>
    );
  }
  return (
    <>
      {fateWord(piece, fate)}
      {fate === "worktree" && wait ? ` ${waitWords(wait, selfId)}` : ""}
    </>
  );
}

/** what became of the piece, once the list was answered: the words give way to the outcome */
function Outcome({ item, piece }: { item: PiecesItem; piece: Piece }) {
  const outcome = item.outcomes.find((o) => o.pieceId === piece.id);
  const later = item.later.findLast((l) => l.pieceId === piece.id);
  if (item.state === "going") return <span className="live-text">starting</span>;
  if (!outcome) return null;
  if (outcome.error) return <>{outcome.error}</>;
  if (outcome.fate === "here") return <>here</>;
  if (outcome.fate === "skip") return <>skipped</>;
  if (outcome.fate === "send") {
    return (
      <>
        sent to{" "}
        {outcome.worktreeId ? (
          <WorktreeChip id={outcome.worktreeId} title={outcome.title} />
        ) : (
          (outcome.title ?? "the worktree")
        )}
        {outcome.repoName ? ` in ${outcome.repoName}` : ""}
      </>
    );
  }
  const made = outcome.worktreeId ? outcome : later?.worktreeId ? later : null;
  if (made?.worktreeId) {
    return (
      <>
        <WorktreeChip id={made.worktreeId} title={made.title} />
        {"repoName" in made && made.repoName ? ` in ${made.repoName}` : ""}
      </>
    );
  }
  if (later?.reason) return <>{later.reason}</>;
  const after = piece.after;
  return (
    <>
      queued until{" "}
      {after && "id" in after ? <WorktreeChip id={after.id} title={after.branch} /> : (outcome.after ?? "its turn")}{" "}
      lands
    </>
  );
}

export function Pieces({ item, worktreeId }: { item: PiecesItem; worktreeId: string }) {
  const sock = useSock();
  // the row open under its line, one at a time: opening another folds it
  const [open, setOpen] = useState<string | null>(null);
  const deciding = item.state === "held" || item.state === "proposed";
  const lone = item.pieces.length === 1;
  const press = (piece: Piece, fate: PieceFate) => sock?.send(pieceFate(item, worktreeId, piece.id, fate));
  // an open row is one rung under the pane on the Escape ladder: the first Escape folds it, and
  // the pane never hears that one
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || open === null) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(null);
  };
  return (
    <section className="editor-pieces" onKeyDown={onKeyDown}>
      <div className="editor-pieces-title section-title">Worktrees</div>
      {deciding && item.stale && <div className="editor-pieces-note hint">the plan changed since these were read</div>}
      {item.pieces.map((piece) => {
        const fate = effectiveFate(item, piece);
        const wait = waitOf(item, piece);
        const others = deciding ? fatesFor(piece).filter((f) => f !== fate) : [];
        const line = (
          <>
            <span className="editor-piece-title">{piece.title}</span>
            <span className="editor-piece-fate hint">
              {deciding ? (
                <FateWords piece={piece} fate={fate} wait={wait} selfId={worktreeId} />
              ) : (
                <Outcome item={item} piece={piece} />
              )}
            </span>
          </>
        );
        const body = (
          <div className="editor-piece-body">
            {deciding && (
              <p className="editor-piece-line hint">
                {fateSentence(piece, fate, wait)}
                {others.length > 0 && (
                  <>
                    {" "}
                    Instead:{" "}
                    {others.map((f, i) => (
                      <span key={f}>
                        {i > 0 && " · "}
                        <Button variant="inline" onClick={() => press(piece, f)}>
                          {f === "send" && piece.to ? `send to ${piece.to.title}` : fateWord(piece, f)}
                        </Button>
                      </span>
                    ))}
                  </>
                )}
              </p>
            )}
            <Text text={piece.plan} />
            <Chips refs={piece.attachments} worktreeId={worktreeId} />
          </div>
        );
        // the only piece is not a fold: its line is read, not pressed, and the text is already there
        if (lone) {
          return (
            <div key={piece.id} className="editor-piece">
              <div className="editor-piece-row">{line}</div>
              {body}
            </div>
          );
        }
        return (
          <details
            key={piece.id}
            className="editor-piece"
            open={open === piece.id}
            onToggle={(e) => {
              if (e.currentTarget.open) setOpen(piece.id);
              else if (open === piece.id) setOpen(null);
            }}
          >
            <summary className="row editor-piece-row">{line}</summary>
            {body}
          </details>
        );
      })}
    </section>
  );
}
