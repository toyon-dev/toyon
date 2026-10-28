// The pieces of a plan as the editor pane's tab strip: the plan first, when the page has one, then
// one tab per piece in the strip's order (chat/pieces.ts), with the file's actions at the strip's
// end, the way the terminal pane heads itself with its streams. A tab's small word is the piece's
// fate while the list is the person's; once answered it gives way to what the piece became, and a
// piece that became a worktree wears that row's dot and age, as the rail draws it. A piece's page
// is its text at a document's scale under one line that states its fate and offers the others,
// or what it became and where to open it. The strip is the head, so it stays put while the text
// scrolls, and a sibling opening the origin's plan sees the same strip.

import type { AttachmentRef, Piece, PieceFate } from "@toyon/shared";
import { sentAt } from "@toyon/shared";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useSock, useStore, useUrls } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import type { TabItem, TabsProps } from "../../ui/Tabs.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { FileChip } from "../chat/FileChip.tsx";
import { ImageChip } from "../chat/ImageChip.tsx";
import { PasteChip } from "../chat/PasteChip.tsx";
import { PickChip } from "../chat/PickChip.tsx";
import {
  deciding,
  effectiveFate,
  fateSentence,
  fatesFor,
  fateWord,
  type PieceStanding,
  type PiecesItem,
  pieceFate,
  pieceMark,
  pieceOrder,
  pieceStanding,
  waitOf,
} from "../chat/pieces.ts";
import { WorktreeChip } from "../chat/WorktreeChip.tsx";
import { ago, dotClass } from "../util.ts";
import { MarkdownPreview } from "./MarkdownPreview.tsx";

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

/** what the piece became, as the tab's tip says it */
function standingWords(s: PieceStanding): string {
  const where = "repoName" in s && s.repoName ? ` in ${s.repoName}` : "";
  switch (s.kind) {
    case "starting":
      return "Starting.";
    case "failed":
      return `Could not start: ${s.error}`;
    case "here":
      return "This worktree's agent does it.";
    case "skipped":
      return "Skipped: nothing happened to this piece.";
    case "dropped":
      return s.reason;
    case "sent":
      return `Sent to ${s.title ?? "the worktree"}${where}.`;
    case "worktree":
      return `A worktree of its own${where}: ${s.title ?? "open it from the line above its text"}.`;
    case "queued":
      return `Queued until ${s.after ? (s.after.kind === "branch" ? s.after.branch : s.after.title) : (s.said ?? "its turn")} lands.`;
  }
}

/**
 * The strip for the pane's head: the plan's tab when the page has one (`plan` is its label and
 * the path its tip names), then the pieces. `current` and `onPick` are the pane's, since the open
 * tab is the pane's state and not the list's. Nothing for a page with no list.
 */
export function usePieceTabs(
  item: PiecesItem | null,
  plan: { label: string; path: string } | null,
  current: string,
  onPick: (id: string) => void,
): Omit<TabsProps<string>, "end"> | undefined {
  const rows = useStore((s) => s.visible);
  const archived = useStore((s) => s.archived);
  const label = plan?.label;
  const path = plan?.path;
  // the ages read in minutes, and a quiet list can go a long while without a frame: the rail's
  // own tick
  const [minute, setMinute] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMinute((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `minute` is the tick the ages are re-read on
  return useMemo(() => {
    if (!item) return undefined;
    const items: TabItem<string>[] = [];
    if (label !== undefined && path !== undefined) items.push({ id: "plan", label, tip: tip(path) });
    for (const piece of pieceOrder(item)) {
      const mark = pieceMark(item, piece);
      let lead: ReactNode = null;
      let word: string;
      if ("worktreeId" in mark) {
        // the row's own dot and age, so the strip reads as the rail does; a row gone to the
        // archive says so in the word, and nothing else about it is live
        const row = rows.find((r) => r.worktree.id === mark.worktreeId);
        if (row) {
          lead = <span className={`dot ${dotClass(row)}`} />;
          word = ago(sentAt(row.worktree));
        } else {
          const gone = Object.values(archived)
            .flat()
            .some((a) => a.id === mark.worktreeId);
          word = gone ? "archived" : "gone";
        }
      } else {
        word = mark.word;
      }
      const words = deciding(item)
        ? fateSentence(piece, effectiveFate(item, piece), waitOf(item, piece))
        : standingWords(pieceStanding(item, piece));
      items.push({
        id: piece.id,
        lead,
        label: (
          <>
            {piece.title}
            <span className="editor-tab-mark">{word}</span>
          </>
        ),
        tip: tip(words),
      });
    }
    return { items, current, onPick, owner: "pieces", label: "the plan and its pieces" };
  }, [item, label, path, current, onPick, rows, archived, minute]);
}

/** what became of the open piece, as the line over its text states it: the tip's words, with
 * the row's chip in place of its name where there is a row to open */
function Standing({ item, piece }: { item: PiecesItem; piece: Piece }) {
  const s = pieceStanding(item, piece);
  const where = "repoName" in s && s.repoName ? ` in ${s.repoName}` : "";
  switch (s.kind) {
    case "starting":
      return <span className="live-text">starting</span>;
    case "failed":
    case "skipped":
    case "dropped":
      return <>{standingWords(s)}</>;
    case "sent":
      return (
        <>
          Sent to {s.worktreeId ? <WorktreeChip id={s.worktreeId} title={s.title} /> : (s.title ?? "the worktree")}
          {where}.
        </>
      );
    case "worktree":
      return (
        <>
          A worktree of its own{where}: <WorktreeChip id={s.worktreeId} title={s.title} />.
        </>
      );
    case "queued":
      return (
        <>
          Queued until{" "}
          {s.after?.kind === "branch" ? (
            <WorktreeChip id={s.after.id} title={s.after.branch} />
          ) : (
            (s.after?.title ?? s.said ?? "its turn")
          )}{" "}
          lands.
        </>
      );
    case "here": {
      // the wait the origin's own work named: a branch by its row, a piece by the worktree it
      // became, which the line under the box says too for as long as it stands
      const after = piece.after;
      const on = after && "piece" in after ? item.pieces.find((p) => p.id === after.piece) : undefined;
      const became = on ? pieceStanding(item, on) : null;
      const wait =
        after && "id" in after ? (
          <WorktreeChip id={after.id} title={after.title} />
        ) : became && (became.kind === "worktree" || became.kind === "sent") && became.worktreeId ? (
          <WorktreeChip id={became.worktreeId} title={became.title ?? on?.title} />
        ) : on ? (
          on.title
        ) : null;
      return wait ? <>This worktree's agent does it, once {wait} lands.</> : <>This worktree's agent does it.</>;
    }
  }
}

/** A piece's page: its text read as the plan's file is, at a document's scale with its links and
 * images resolved against the file the list sits on, under one line. While the list is the
 * person's the line states the fate and offers the others; once answered it says what became of
 * the piece, with the row to open. The attachments the piece carries sit under the line. */
export function PiecePage({
  item,
  piece,
  worktreeId,
  path,
  version,
  openSeq,
  focus,
  onChat,
}: {
  item: PiecesItem;
  piece: Piece;
  worktreeId: string;
  /** the file the list sits on, which the piece's relative links and images are read from */
  path: string;
  version: string | null | undefined;
  openSeq: number;
  focus: boolean;
  onChat: (selected: string) => void;
}) {
  const sock = useSock();
  const press = (fate: PieceFate) => sock?.send(pieceFate(item, worktreeId, piece.id, fate));
  const fate = effectiveFate(item, piece);
  const wait = waitOf(item, piece);
  const others = deciding(item) ? fatesFor(piece, item.pieces).filter((f) => f !== fate) : [];
  const lead = (
    <div className="editor-piece-lead">
      <p className="editor-piece-line hint">
        {deciding(item) ? (
          <>
            {/* the rows were read off a plan that is no longer the one on disk: said first, since
                the sentence after it is about rows that may no longer match the text */}
            {item.stale && "The plan changed since these were read. "}
            {fateSentence(piece, fate, wait)}
            {others.length > 0 && (
              <>
                {" "}
                Instead:{" "}
                {others.map((f, i) => (
                  <span key={f}>
                    {i > 0 && " · "}
                    <Button variant="inline" onClick={() => press(f)}>
                      {f === "send" && piece.to ? `send to ${piece.to.title}` : fateWord(piece, f)}
                    </Button>
                  </span>
                ))}
              </>
            )}
          </>
        ) : (
          <Standing item={item} piece={piece} />
        )}
      </p>
      <Chips refs={piece.attachments} worktreeId={worktreeId} />
    </div>
  );
  return (
    <MarkdownPreview
      text={piece.plan}
      path={path}
      worktreeId={worktreeId}
      version={version}
      openSeq={openSeq}
      focus={focus}
      onChat={onChat}
      lead={lead}
    />
  );
}
