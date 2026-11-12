import { matchChord } from "@toyon/shared";
import { type CSSProperties, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx } from "./cx.ts";
import { DocumentFind } from "./DocumentFind.tsx";
import { diffDocument } from "./documentDiff.ts";
import { Float } from "./Float.tsx";
import { isFind } from "./find.ts";
import { useOnChange } from "./hooks.ts";
import { outlineCentre, outlineDepths } from "./outline.ts";
import { rowState } from "./rowState.ts";
import { isSelectAll, selectContents, selectedText } from "./selectAll.ts";
import "./document.css";

/** a heading the render produced, and the element it is, for the outline to read and scroll to.
 * `id` is its text with its place among the headings that share it, which is what stays put while
 * an agent is still writing the sections above it. */
type Heading = { id: string; level: number; depth: number; text: string; el: HTMLElement };

function readHeadings(root: HTMLElement): Heading[] {
  const seen = new Map<string, number>();
  // a heading that went is drawn (documentDiff.ts) and is no section of the document as it is:
  // one marked gone, and every one on the side of a split page that holds the page as it was
  const els = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")).filter(
    (el) => !el.closest(".document-gone, .document-split > :nth-child(odd)"),
  );
  const depths = outlineDepths(els.map((el) => Number(el.tagName[1])));
  return els.map((el, i) => {
    const text = el.textContent?.trim() ?? "";
    const nth = seen.get(text) ?? 0;
    seen.set(text, nth + 1);
    return { id: `${nth}\n${text}`, level: Number(el.tagName[1]), depth: depths[i]!, text, el };
  });
}

/** a heading counts as reached this far under the top edge, so the one just scrolled past the
 * edge is still the section being read rather than the next one down */
const REACHED = 48;
/** air kept above a heading jumped to: its own top margin is what the eye expects to find there */
const JUMP_AIR = 16;

/**
 * A document read for itself: rendered markdown filling the box it is given, scrolling as a whole,
 * with its headings as an outline down the left, its own find, and select-all meaning the document.
 * A file in the editor pane and the release notes in the centre are the same thing read the same
 * way; what differs is where a link goes, which the caller says. `html` is already sanitized
 * markdown output. `openSeq` ticks when the caller wants the document to take the keyboard again
 * (a pane opened on it), and `focus` says whether it should. `onLink` takes a link inside the page
 * (one to a file beside it, or a section); an http link opens its tab untouched. `onChat` takes
 * what ⌘L selected, as the page draws it. `lead` is drawn at the head of the page, above the
 * markdown and scrolling with it, and stays out of the outline: a line of Toyon's own on a text
 * that is the agent's. `before` is the same document as it was, rendered the same way: with one,
 * the page is marked with what came and what went since (documentDiff.ts), in one column or,
 * with `split`, as it was beside as it is.
 */
export function Document({
  html,
  before,
  split = false,
  openSeq = 0,
  focus = true,
  onLink,
  onChat,
  lead,
}: {
  html: string;
  before?: string;
  split?: boolean;
  openSeq?: number;
  focus?: boolean;
  onLink?: (href: string) => void;
  onChat?: (selected: string) => void;
  lead?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const page = useMemo(() => (before === undefined ? html : diffDocument(before, html, split)), [before, html, split]);
  const [heads, setHeads] = useState<Heading[]>([]);
  const [at, setAt] = useState(-1);
  // the find box: open with what was selected at the press, and `seq` ticking on each press since
  const [find, setFind] = useState<{ seed: string; seq: number } | null>(null);
  const closeFind = (current: Range | null) => {
    setFind(null);
    // the box goes, the match stays: as the reader's selection, where ⌘L can take it to the chat
    if (current) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(current);
    }
    ref.current?.focus();
  };
  // nothing rendered takes focus on its own, so the body does, as a picture's does: Escape then
  // finds what holds the document
  useOnChange([openSeq], () => {
    if (focus) ref.current?.focus();
  });
  // the headings are read off the rendered DOM rather than the markdown, so they are the ones the
  // sanitizer let through, with the text the way it is drawn; off the body alone, so a lead's
  // own heading is not a section of the document
  useOnChange([page], () => {
    setHeads(body.current ? readHeadings(body.current) : []);
  });
  // the section being read: the last heading above the top edge, re-read on every scroll frame
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      // at the end of the document the last heading is being read whether or not it could reach
      // the top edge, which a short last section never lets it
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 1) {
        setAt(heads.length - 1);
        return;
      }
      const y = root.scrollTop + REACHED;
      let i = -1;
      for (let k = 0; k < heads.length; k++) if (heads[k]!.el.offsetTop <= y) i = k;
      setAt(i);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    root.addEventListener("scroll", onScroll);
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [heads]);
  const jump = (i: number) => {
    const el = heads[i]?.el;
    ref.current?.scrollTo({ top: Math.max(0, el ? el.offsetTop - JUMP_AIR : 0), behavior: "smooth" });
  };
  const onClick = (e: React.MouseEvent) => {
    const link = (e.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!href || link?.target === "_blank") return;
    // a link inside the page would navigate the shell itself
    e.preventDefault();
    onLink?.(href);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // the browser's find reads the whole shell, the rail and the chat with it, and counts what is
    // not on screen; here it means the document, as the editor's own find means the file. A
    // selection at the press is what is looked for, as the editor's is.
    if (isFind(e)) {
      e.preventDefault();
      e.stopPropagation();
      const seed = (body.current && selectedText(body.current)) ?? "";
      setFind((f) => ({ seed: seed || f?.seed || "", seq: (f?.seq ?? 0) + 1 }));
      return;
    }
    // with the box open and the hand back in the document, Escape closes the box before anything
    // above it on the ladder
    if (e.key === "Escape" && find) {
      e.stopPropagation();
      closeFind(null);
      return;
    }
    // the document is not editable, so the browser's select-all would take the whole shell with
    // it; here it means the document
    if (isSelectAll(e) && body.current) {
      e.preventDefault();
      selectContents(body.current);
      return;
    }
    // ⌘L with a selection is add-to-chat, as in the editor; with none it goes on to the window,
    // where the chord toggles the chat. Handled here it is also kept from the window, whose toggle
    // would close the chat the selection just went to
    if (onChat && matchChord(e)?.id === "composer" && body.current) {
      const selected = selectedText(body.current);
      if (!selected) return;
      e.preventDefault();
      e.stopPropagation();
      onChat(selected);
    }
  };
  return (
    <>
      <div ref={ref} className="document" tabIndex={-1} onClick={onClick} onKeyDown={onKeyDown}>
        {lead}
        <div
          ref={body}
          className={cx("md md-preview", before !== undefined && split && "document-split")}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
          dangerouslySetInnerHTML={{ __html: page }}
        />
      </div>
      {find && <DocumentFind root={ref} body={body} seed={find.seed} seq={find.seq} onClose={closeFind} />}
      <Outline heads={heads} at={at} onJump={jump} />
    </>
  );
}

/** The document's headings as a strip of ticks down the left of the body, one per heading and as
 * wide as its level is high, with the section being read set darker. Pointing at the strip opens
 * the titles in its place, stepped in by depth with no ticks beside them, the way a paper's
 * contents read; a title jumps to its heading. The strip stays outside the scroll box, so it
 * holds still while the document moves under it. The titles take half the window at most: more
 * of them scroll inside the box, which opens on the section being read and under the hand. */
function Outline({ heads, at, onJump }: { heads: Heading[]; at: number; onJump: (i: number) => void }) {
  // open, and how far down the window the hand that opened it was
  const [hand, setHand] = useState<number | null>(null);
  const open = hand !== null;
  const strip = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement | null>(null);
  // contents longer than the box open on the section being read, in the middle of it. On opening
  // only: a title pressed moves the document, and the list must not move under the pointer
  useLayoutEffect(() => {
    const box = open ? list.current : null;
    const row = box?.querySelector<HTMLElement>('[data-state~="current"]');
    if (box && row) box.scrollTop = row.offsetTop - (box.clientHeight - row.offsetHeight) / 2;
  }, [open]);
  // an outline of one heading says nothing the title does not
  if (heads.length < 2) return null;
  return (
    <>
      <div
        ref={strip}
        className="document-outline"
        aria-hidden
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setHand((y) => y ?? e.clientY);
        }}
        // a finger cannot hover, so a tap opens it and the list's outside press closes it
        onClick={(e) => setHand((y) => (y === null ? e.clientY : null))}
      >
        {heads.map((h, i) => (
          <span
            key={h.id}
            className="document-outline-tick"
            data-level={h.level}
            data-state={rowState({ current: i === at })}
          />
        ))}
      </div>
      {hand !== null && (
        <Float
          className="document-outline-list"
          anchor={() => {
            const rect = strip.current?.getBoundingClientRect();
            if (!rect) return null;
            const y = outlineCentre(rect, hand, list.current?.offsetHeight ?? 0);
            return { left: rect.left, right: rect.right, top: y, bottom: y };
          }}
          // over the strip, so the pointer that opened it never leaves it on the way
          placement={{ side: "right", align: "center", cover: true }}
          trigger={strip.current}
          boxRef={list}
          onDismiss={() => setHand(null)}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setHand(null);
          }}
        >
          {heads.map((h, i) => (
            <button
              key={h.id}
              type="button"
              className="row document-outline-row"
              data-level={h.level}
              data-state={rowState({ current: i === at })}
              onClick={() => onJump(i)}
            >
              <span className="document-outline-label" style={{ "--outline-depth": h.depth } as CSSProperties}>
                {h.text}
              </span>
            </button>
          ))}
        </Float>
      )}
    </>
  );
}
