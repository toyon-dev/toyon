// The pieces section at the head of a plan in the editor pane: the agent's list of what its plan
// splits into, one row per piece with its fate beside it, read off the plan it sits on. The
// person moves a row here and answers the list with the plan card (or Toyon's own card in the
// box); a press goes to the daemon and comes back as the event every tab draws, one round trip.
// Once the list is answered the words give way to what each piece became, and a sibling opening
// the origin's plan sees the same section, so the whole picture is one press away from any row.

import type { AttachmentRef, Piece, PieceFate } from "@toyon/shared";
import { useMemo } from "react";
import { useSock, useUrls } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { FileChip } from "../chat/FileChip.tsx";
import { ImageChip } from "../chat/ImageChip.tsx";
import { renderMarkdown } from "../chat/markdown.ts";
import { PasteChip } from "../chat/PasteChip.tsx";
import { PickChip } from "../chat/PickChip.tsx";
import { effectiveFate, fatesFor, type PiecesItem, pieceFate } from "../chat/pieces.ts";
import { WorktreeChip } from "../chat/WorktreeChip.tsx";

const WORD: Record<Exclude<PieceFate, "send">, string> = { here: "here", worktree: "new worktree", skip: "skip" };

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

function Brief({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="editor-piece-brief md"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** what became of the piece, once the list was answered: the words give way to the outcome */
function Outcome({ item, piece }: { item: PiecesItem; piece: Piece }) {
  const outcome = item.outcomes.find((o) => o.pieceId === piece.id);
  const later = item.later.findLast((l) => l.pieceId === piece.id);
  if (item.state === "going") return <span className="editor-piece-tail live-text">starting</span>;
  if (!outcome) return null;
  if (outcome.error) return <span className="editor-piece-tail">{outcome.error}</span>;
  if (outcome.fate === "here") return <span className="editor-piece-tail">here</span>;
  if (outcome.fate === "skip") return <span className="editor-piece-tail">skipped</span>;
  if (outcome.fate === "send")
    return (
      <span className="editor-piece-tail">
        sent to{" "}
        {outcome.worktreeId ? (
          <WorktreeChip id={outcome.worktreeId} title={outcome.title} />
        ) : (
          (outcome.title ?? "the worktree")
        )}
      </span>
    );
  const made = outcome.worktreeId ? outcome : later?.worktreeId ? later : null;
  if (made?.worktreeId) {
    return (
      <span className="editor-piece-tail">
        started <WorktreeChip id={made.worktreeId} title={made.title} />
      </span>
    );
  }
  if (later?.reason) return <span className="editor-piece-tail">{later.reason}</span>;
  return (
    <span className="editor-piece-tail">
      queued until {piece.after ? <WorktreeChip id={piece.after.id} title={piece.after.branch} /> : outcome.after} lands
    </span>
  );
}

export function Pieces({ item, worktreeId }: { item: PiecesItem; worktreeId: string }) {
  const sock = useSock();
  const deciding = item.state === "held" || item.state === "proposed";
  const press = (piece: Piece, fate: PieceFate) => sock?.send(pieceFate(item, worktreeId, piece.id, fate));
  const skipAll = () => {
    for (const piece of item.pieces) if (effectiveFate(item, piece) !== "skip") press(piece, "skip");
  };
  const head = !deciding
    ? "Worktrees"
    : item.state === "held"
      ? "Worktrees · read off the plan; decided with the plan card"
      : "Worktrees · read off the plan; change any row";
  return (
    <section className="editor-pieces">
      <div className="editor-pieces-head section-title">
        <span>{head}</span>
        {deciding && (
          <Button variant="ghost" onClick={skipAll}>
            skip on all
          </Button>
        )}
      </div>
      {item.pieces.map((piece, i) => {
        const fate = effectiveFate(item, piece);
        return (
          <div key={piece.id} className="editor-piece">
            <div className="editor-piece-row">
              <span className="editor-piece-n">{i + 1}</span>
              <span className="editor-piece-title">{piece.title}</span>
              {deciding ? (
                <span className="editor-piece-fates">
                  {fatesFor(piece).map((w) =>
                    w === "send" && piece.to ? (
                      <Button key={w} variant="ghost" on={fate === w} onClick={() => press(piece, w)}>
                        <WorktreeChip id={piece.to.id} title={piece.to.branch} inert />
                      </Button>
                    ) : (
                      <Button key={w} variant="ghost" on={fate === w} onClick={() => press(piece, w)}>
                        {WORD[w as Exclude<PieceFate, "send">]}
                      </Button>
                    ),
                  )}
                </span>
              ) : (
                <Outcome item={item} piece={piece} />
              )}
            </div>
            <Brief text={piece.brief} />
            <Chips refs={piece.attachments} worktreeId={worktreeId} />
            {deciding && fate === "worktree" && piece.after && (
              <div className="editor-piece-tail row-dim">
                starts when <WorktreeChip id={piece.after.id} title={piece.after.branch} /> lands
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
