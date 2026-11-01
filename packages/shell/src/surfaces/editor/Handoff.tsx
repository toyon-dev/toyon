// What a plan hands off, as a track under the editor pane's head: the plan first, when the page
// has one, then one pill per piece in the track's order (chat/handoff.ts), led by the mark the
// chat's handed-off row wears. A segmented track and not the pane's own strip, because the strip
// in the head read as the file's title, a caption over the text, and was passed over. The head
// keeps the file's title and its actions. A pill is a title, with the row's dot once the piece
// became a worktree, as the rail draws it: the open piece's fate is the line under its title, so
// a word on the pill said it twice. The pills keep to one line and scroll, with a fade on the edge
// that has more. A list of one has no track: there is nothing to switch between. A piece's page
// is its title, then a line only when the line says something the pill does not (bylineShown),
// then its text at a document's scale. The track stays put while the text scrolls, and a sibling
// opening the origin's plan sees the same track.

import type { AttachmentRef, Piece, PieceFate } from "@toyon/shared";
import { useMemo, useRef, useState } from "react";
import { useSock, useStore, useUrls } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { type TabItem, Tabs, type TabsProps } from "../../ui/Tabs.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { FileChip } from "../chat/FileChip.tsx";
import {
  bylineShown,
  deciding,
  effectiveFate,
  fateSentence,
  fatesFor,
  fateWord,
  type HandoffItem,
  leadHeading,
  type PieceStanding,
  pieceFate,
  pieceMark,
  pieceOrder,
  pieceStanding,
  waitOf,
} from "../chat/handoff.ts";
import { ImageChip } from "../chat/ImageChip.tsx";
import { PasteChip } from "../chat/PasteChip.tsx";
import { PickChip } from "../chat/PickChip.tsx";
import { WorktreeChip } from "../chat/WorktreeChip.tsx";
import { dotClass } from "../util.ts";
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
      return "Skipped: nothing happened to it.";
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
 * The track's pills: the plan's when the page has one (`plan` is its label and the path its tip
 * names), then the pieces. A pill is a title, with the row's dot once the piece became a
 * worktree; its fate is the line under the open page's title, and the pill's tip for the rest.
 * `current` and `onPick` are the pane's, since the open pill is the pane's state and not the
 * list's. Nothing for a page with no list, and nothing for one pill, which has nothing to switch
 * to.
 */
export function usePieceTabs(
  item: HandoffItem | null,
  plan: { label: string; path: string } | null,
  current: string,
  onPick: (id: string) => void,
): Omit<TabsProps<string>, "end"> | undefined {
  const rows = useStore((s) => s.visible);
  const label = plan?.label;
  const path = plan?.path;
  return useMemo(() => {
    if (!item) return undefined;
    const items: TabItem<string>[] = [];
    if (label !== undefined && path !== undefined) items.push({ id: "plan", label, tip: tip(path) });
    for (const piece of pieceOrder(item)) {
      const mark = pieceMark(item, piece);
      // the row's own dot, so the track reads as the rail does; a row gone from the rail has none
      const row = "worktreeId" in mark ? rows.find((r) => r.worktree.id === mark.worktreeId) : undefined;
      const words = deciding(item)
        ? fateSentence(piece, effectiveFate(item, piece), waitOf(item, piece))
        : standingWords(pieceStanding(item, piece));
      items.push({
        id: piece.id,
        lead: row ? <span className={`dot ${dotClass(row)}`} /> : null,
        label: piece.title,
        tip: tip(words),
      });
    }
    if (items.length < 2) return undefined;
    return { items, current, onPick, owner: "handoff", label: "the plan and what it hands off", segmented: true };
  }, [item, label, path, current, onPick, rows]);
}

/** The track under the pane's head: the handed-off mark, then the pills on one line. Pills past
 * the edge scroll, and the edge they are past fades, so the row says there is more; the open pill
 * is brought into view whenever it changes, since the default one can sit past the edge. */
export function HandoffTrack({ tabs }: { tabs: Omit<TabsProps<string>, "end"> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });
  // the fades follow the list: read on its scroll and on its size, and again when the pills change
  useOnChange([tabs.items], () => {
    const list = ref.current?.querySelector<HTMLElement>(".tabs-list");
    if (!list) return;
    const read = () => {
      const at = list.scrollLeft;
      const start = at > 1;
      const end = at + list.clientWidth < list.scrollWidth - 1;
      setMore((m) => (m.start === start && m.end === end ? m : { start, end }));
    };
    read();
    list.addEventListener("scroll", read, { passive: true });
    const seen = new ResizeObserver(read);
    seen.observe(list);
    return () => {
      list.removeEventListener("scroll", read);
      seen.disconnect();
    };
  });
  useOnChange([tabs.current], () => {
    ref.current
      ?.querySelector<HTMLElement>('.tabs-list [data-state~="current"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  return (
    <div
      ref={ref}
      className="editor-handoff-track"
      data-more-start={more.start ? "" : undefined}
      data-more-end={more.end ? "" : undefined}
    >
      <span className="editor-handoff-mark" {...tip("Handed off from this plan")}>
        <Icon name="spawn" />
      </span>
      <Tabs {...tabs} />
    </div>
  );
}

/** what became of the open piece, as the line over its text states it: the tip's words, with
 * the row's chip in place of its name where there is a row to open */
function Standing({ item, piece }: { item: HandoffItem; piece: Piece }) {
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

/** A piece's page, read as the plan's file is, at a document's scale with its links and images
 * resolved against the file the list sits on. The title first: the text's own opening heading,
 * else the piece's title. Then a line, when it says something the pill does not: while the list
 * is the person's it states the fate and offers the others; once answered, what became of the
 * piece with the row to open. Then the attachments the piece carries, and its text. `alone`: the
 * page has no track over it, so the line is the only place the fate is said. */
export function PiecePage({
  item,
  piece,
  alone,
  worktreeId,
  path,
  version,
  openSeq,
  focus,
  onChat,
}: {
  item: HandoffItem;
  piece: Piece;
  alone: boolean;
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
  const { title, rest } = useMemo(() => leadHeading(piece.plan), [piece.plan]);
  const byline = bylineShown(item, piece, alone) && (
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
  );
  // the title wears the document's own h1, so the page reads as the plan's file does
  const lead = (
    <div className="md md-preview editor-piece-head">
      <h1>{title ?? piece.title}</h1>
      {byline}
      <Chips refs={piece.attachments} worktreeId={worktreeId} />
    </div>
  );
  return (
    <MarkdownPreview
      text={rest}
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
