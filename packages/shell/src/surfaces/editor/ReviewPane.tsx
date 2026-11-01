import { viewerOf } from "@toyon/shared";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { writeCopiedSource } from "../../app/copiedSource.ts";
import { previewBus } from "../../app/previewBus.ts";
import { fileItems, openFile } from "../../state/actions/file.ts";
import { addToChat } from "../../state/attach.ts";
import { useDispatch, useFileSync, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { useCommittedOpen, useLocalField, useTheme, useTurnOpen } from "../../state/selectors.ts";
import { type FileState, localOf, type ReviewPane as Review, reviewKey, worktreeById } from "../../state/store.ts";
import { cx } from "../../ui/cx.ts";
import { ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { type MenuEntry, SEP, useContextMenu } from "../../ui/menu.ts";
import { Pane } from "../../ui/Pane.tsx";
import { LineCounts } from "../changes/GitFileRow.tsx";
import { changeSections, type ReviewSection, reviewSections } from "../changes/rows.ts";
import { endCarry, startCarry } from "../chat/carried.ts";
import { shiftRanges, splitPath, xyClass, xyLetter } from "../util.ts";
import { estimateHeight } from "./diffFit.ts";
import { useWrap, WrapToggle } from "./WrapToggle.tsx";
import "./editor.css";
import "./review.css";

// the grammars come in with the editor, and a file is only shown once they can colour it
const Editor = lazy(async () => {
  const [editor] = await Promise.all([import("./Editor.tsx"), import("./grammar.ts").then((g) => g.grammarsReady)]);
  return editor;
});

/** a section past this many lines scrolls inside itself: a whole long file drawn at once would cost
 * its mount every time it came near the screen */
const SECTION_MAX_LINES = 400;

/** a press on a header folds it unless a second press follows: that one opens the file on its own */
const DOUBLE_MS = 220;

/** the code's line height, as the editor draws it: the mono's small size at 1.5 */
function lineHeight(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--size-mono-sm"));
  return (Number.isFinite(size) && size > 0 ? size : 11) * 1.5;
}

/** Every change of one worktree in one scroll, in the changes list's order. A row's press in the
 * list brings a file to the top; scrolling here moves the list's mark to the file under the top
 * edge. Each file is a section with its header held at the top while it is read, and its diff as
 * tall as its text, drawn only while it is near the screen. */
export function ReviewPane({
  review,
  height,
  full = false,
  onToggleFull,
  onDragStart,
}: {
  review: Review;
  height?: number | string;
  full?: boolean;
  onToggleFull?: () => void;
  onDragStart?: (e: React.PointerEvent) => void;
}) {
  const dispatch = useDispatch();
  const { worktreeId, at, seq, focus } = review;
  const git = useLocalField(worktreeId, "git");
  const turnOpen = useTurnOpen();
  const committedOpen = useCommittedOpen();
  const sections = useMemo(
    () => reviewSections(changeSections(git, { turn: turnOpen, committed: committedOpen })),
    [git, turnOpen, committedOpen],
  );
  const [wrap, setWrap] = useWrap();
  const scroller = useRef<HTMLDivElement>(null);
  const line = useMemo(lineHeight, []);

  // Near the screen, within a screen's height either way: a section there draws its editor and
  // holds its file, one further off is its header and its last height, so a long branch holds a
  // handful of editors whatever its length.
  const watchers = useRef(new Map<Element, (near: boolean) => void>());
  const observer = useRef<IntersectionObserver | null>(null);
  useLayoutEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) watchers.current.get(e.target)?.(e.isIntersecting);
      },
      { root: scroller.current, rootMargin: "100% 0px" },
    );
    observer.current = io;
    for (const el of watchers.current.keys()) io.observe(el);
    return () => io.disconnect();
  }, []);
  const watch = useCallback((el: Element, onNear: (near: boolean) => void) => {
    watchers.current.set(el, onNear);
    observer.current?.observe(el);
    return () => {
      watchers.current.delete(el);
      observer.current?.unobserve(el);
    };
  }, []);

  // A scroll that the review made (a jump, or a section above settling its height) leaves the
  // list's mark where the press put it; one a hand made moves the mark to what is under the top.
  // The hand is heard on the way down, ahead of a section that keeps a wheel from the code.
  const hand = useRef(false);
  // only the jump's own number moves the scroll: `at` also changes as a hand scrolls
  // biome-ignore lint/correctness/useExhaustiveDependencies: the seq names the jump
  useLayoutEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    hand.current = false;
    const el = at ? sc.querySelector<HTMLElement>(`[data-key="${CSS.escape(reviewKey(at))}"]`) : null;
    if (el) sc.scrollTop = el.offsetTop;
    if (focus) sc.focus({ preventScroll: true });
  }, [seq]);
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const handed = () => {
      hand.current = true;
    };
    let frame = 0;
    const onScroll = () => {
      if (!hand.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const all = sc.querySelectorAll<HTMLElement>(".review-section");
        if (all.length === 0) return;
        // at the end of the scroll the last file is the one being read, though it cannot reach the top
        const end = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
        let under: HTMLElement | undefined = all[0];
        if (end) under = all[all.length - 1];
        else for (const s of all) if (s.offsetTop <= sc.scrollTop + 1) under = s;
        const path = under?.dataset.path;
        if (!under || !path) return;
        const since = under.dataset.since;
        dispatch({ a: "review-at", worktreeId, at: since ? { path, since } : { path } });
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    for (const ev of ["wheel", "pointerdown", "touchstart", "keydown"])
      sc.addEventListener(ev, handed, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      sc.removeEventListener("scroll", onScroll);
      for (const ev of ["wheel", "pointerdown", "touchstart", "keydown"])
        sc.removeEventListener(ev, handed, { capture: true });
    };
  }, [dispatch, worktreeId]);

  // a branch with nothing left to read (landed, discarded, committed away) has nothing to review
  useEffect(() => {
    if (git && sections.length === 0) dispatch({ a: "close-editor" });
  }, [git, sections.length, dispatch]);

  const n = sections.length;
  return (
    <Pane
      kind="editor"
      className={cx("editor-pane review-pane", full && "full")}
      height={height}
      resizable={!full}
      onDragStart={onDragStart ?? (() => {})}
      title={`${n} changed ${n === 1 ? "file" : "files"}`}
      onClose={() => dispatch({ a: "close-editor" })}
      full={full}
      onToggleFull={onToggleFull}
      actions={<WrapToggle wrap={wrap} onWrap={setWrap} />}
    >
      <div className="editor-body">
        <div className="review-scroll" ref={scroller} tabIndex={-1}>
          {sections.map((s) => (
            <Section
              key={reviewKey(s.at)}
              section={s}
              worktreeId={worktreeId}
              wrap={wrap}
              line={line}
              scroller={scroller}
              watch={watch}
            />
          ))}
          <div className="review-end" />
        </div>
      </div>
    </Pane>
  );
}

const NO_FILE: FileState = { disk: null, conflict: null, blame: null };

/** one file of the review: its header, held at the top while it is read, and its diff */
function Section({
  section,
  worktreeId,
  wrap,
  line,
  scroller,
  watch,
}: {
  section: ReviewSection;
  worktreeId: string;
  wrap: boolean;
  line: number;
  scroller: React.RefObject<HTMLDivElement | null>;
  watch: (el: Element, onNear: (near: boolean) => void) => () => void;
}) {
  const { f, at } = section;
  const { path, since } = at;
  const key = reviewKey(at);
  const dispatch = useDispatch();
  const store = useStoreInstance();
  const sock = useSock();
  const files = useFileSync();
  const theme = useTheme();
  const state = useStore((s) => (s.editor?.kind === "review" ? (s.editor.files[key] ?? NO_FILE) : NO_FILE));
  const wtPath = useStore((s) => worktreeById(s, worktreeId)?.worktree.path);
  const cached = useStore((s) => localOf(s, worktreeId).changedRanges[path]);
  const fileRef = useMemo(() => ({ worktreeId, path, ...(since ? { since } : {}) }), [worktreeId, path, since]);

  const box = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    return el ? watch(el, setNear) : undefined;
  }, [watch]);
  const [folded, setFolded] = useState(false);
  const live = near && !folded;

  // held while drawn: read now, kept in step with the disk, and let go as it scrolls away
  useEffect(() => (live && files ? files.hold(fileRef) : undefined), [live, files, fileRef]);
  // the line offset the page's highlight is counted in, for the hover to light the right lines
  useEffect(() => {
    if (live && !cached) sock?.send({ t: "changed-ranges", worktreeId, path });
  }, [live, cached, sock, worktreeId, path]);

  // How tall the diff is: a guess from the counts until the editor says, then what it says, up to
  // a cap past which the rest is a double-click away.
  const cap = SECTION_MAX_LINES * line;
  const [height, setHeight] = useState(() => Math.min(cap, estimateHeight(f.add, f.del, line)));
  // A section above the screen that changes height (its editor measuring itself, a note under it)
  // moves the scroll by as much, so the text being read stays put. Measured on the whole section,
  // since more than the code's box can change. A fold is the reader's own: the folded file's header
  // goes to the top, and the next file rises to it.
  const measured = useRef<number | null>(null);
  const folding = useRef(false);
  useLayoutEffect(() => {
    const el = box.current;
    const sc = scroller.current;
    if (!el || !sc) return;
    const now = el.offsetHeight;
    const before = measured.current;
    measured.current = now;
    if (folding.current) {
      folding.current = false;
      if (el.offsetTop < sc.scrollTop) sc.scrollTop = el.offsetTop;
    } else if (before !== null && before !== now && el.offsetTop < sc.scrollTop) sc.scrollTop += now - before;
  });
  // how much a file past the cap holds beyond what the section shows, in lines
  const [beyond, setBeyond] = useState(0);
  const onContentHeight = useCallback(
    (px: number) => {
      setHeight(Math.min(cap, Math.ceil(px)));
      setBeyond(px > cap ? Math.round((px - cap) / line) : 0);
    },
    [cap, line],
  );

  const sync = useMemo(() => files?.bind(fileRef) ?? null, [files, fileRef]);
  const disk = state.disk;
  // what stands in for a file the review cannot draw as text, in a line where its code would be
  const said = state.error
    ? state.error
    : viewerOf(path)
      ? "a picture: double-click the header to see it"
      : disk?.binary
        ? "not a text file"
        : disk?.tooLarge
          ? "too large to open here"
          : null;

  // A wheel that goes up or down over the code moves the review, never the code inside its box: a
  // section has no scroll of its own to stop at, and one that did (a file past the cap) would hold
  // the reader inside it for its whole length. Taken ahead of Monaco, in the capture phase, and not
  // cancelled, so the browser scrolls the review with it. A sideways wheel is the code's, for long lines.
  const body = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the box comes and goes with the fold and the line that stands in for it
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const toReview = (e: WheelEvent) => {
      if (!e.ctrlKey && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) e.stopPropagation();
    };
    el.addEventListener("wheel", toReview, { capture: true, passive: true });
    return () => el.removeEventListener("wheel", toReview, { capture: true });
  }, [folded, said]);

  const openAlone = useCallback(
    () => openFile({ sock, dispatch }, { worktreeId, path, ...(since ? { since } : {}), focus: true }),
    [sock, dispatch, worktreeId, path, since],
  );
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(press.current), []);
  const cm = useContextMenu("changes");
  const menu = (): MenuEntry[] => [
    { id: "open-alone", label: "open on its own", onClick: openAlone },
    ...(state.conflict && files
      ? [
          { id: "reload", label: "reload from disk", onClick: () => files.reload(fileRef) },
          { id: "keep-mine", label: "keep mine", onClick: () => files.keepMine(fileRef) },
        ]
      : []),
    SEP,
    ...(wtPath
      ? fileItems({ id: worktreeId, dir: wtPath }, path, { discard: section.uncommitted, since }, { sock, dispatch })
      : []),
  ];
  const hover = (on: boolean) => {
    if (!on) previewBus.post(worktreeId, { type: "highlight-clear" });
    else if (cached) previewBus.post(worktreeId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
  };
  const lineOff = cached?.offset ?? 0;
  const { name, dir } = splitPath(path);

  return (
    <section ref={box} className="review-section" data-key={key} data-path={path} data-since={since}>
      <header
        className="review-head row row-sm git-file"
        data-folded={folded || undefined}
        data-tip={dir ? path : undefined}
        draggable
        onDragStart={(e) => startCarry(e, { kind: "paths", worktreeId, items: [{ path, folder: false }] })}
        onDragEnd={() => endCarry(store)}
        onClick={(e) => {
          if (e.detail > 1) return;
          press.current = setTimeout(() => {
            folding.current = true;
            setFolded((was) => !was);
          }, DOUBLE_MS);
        }}
        onDoubleClick={() => {
          clearTimeout(press.current);
          openAlone();
        }}
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
        {...cm.contextMenu(menu)}
      >
        <span className={`xy ${xyClass(f.xy)}`}>{xyLetter(f.xy)}</span>
        <span className="path">
          <span className="name">{name}</span>
          {dir && <span className="dir row-dim">{dir}</span>}
          {since && <span className="row-dim">last turn</span>}
        </span>
        <LineCounts f={f} />
      </header>
      {!folded &&
        (said ? (
          <div className="review-line">{said}</div>
        ) : (
          <div className="review-body" ref={body} style={{ height }}>
            {live && disk && sync && (
              <ErrorBoundary>
                <Suspense fallback={null}>
                  <Editor
                    key={key}
                    file={fileRef}
                    disk={disk}
                    blame={state.blame}
                    // a section reads its text or its diff; a rendered page is the file's own view
                    view={disk.before === "" || disk.before === disk.after ? "file" : "diff"}
                    openSeq={0}
                    focus={false}
                    readOnly={!disk.writable}
                    numbers
                    wrap={wrap}
                    theme={theme}
                    sync={sync}
                    fit="content"
                    onContentHeight={onContentHeight}
                    onCopy={(copied, lines, clipboard) =>
                      writeCopiedSource(clipboard, { worktreeId, path: copied, ...lines })
                    }
                    onChat={(taken, selection) =>
                      addToChat(
                        store,
                        selection && {
                          worktreeId,
                          text: selection.text,
                          source: { path: taken, startLine: selection.startLine, endLine: selection.endLine },
                        },
                      )
                    }
                    onNew={() => store.dispatch({ a: "open-draft" })}
                    onLineHover={(hovered) => {
                      if (hovered == null) previewBus.post(worktreeId, { type: "highlight-clear" });
                      else
                        previewBus.post(worktreeId, {
                          type: "highlight-file",
                          path,
                          ranges: [[hovered + lineOff, hovered + lineOff]],
                        });
                    }}
                  />
                </Suspense>
              </ErrorBoundary>
            )}
          </div>
        ))}
      {!folded && !said && beyond > 0 && (
        <div className="review-line">{`about ${beyond.toLocaleString("en")} more lines: double-click the header to read them all`}</div>
      )}
    </section>
  );
}
