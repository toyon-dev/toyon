import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { readingView } from "../../state/store.ts";
import { Float } from "../../ui/Float.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { rowState } from "../../ui/rowState.ts";
import { isSelectAll, selectContents } from "../../ui/selectAll.ts";
import { useMarkdown } from "../chat/markdown.ts";
import { assetPath, dirOf } from "../chat/markdownPaths.ts";
import { outlineDepths } from "./outline.ts";

/** a heading the render produced, and the element it is, for the outline to read and scroll to.
 * `id` is its text with its place among the headings that share it, which is what stays put while
 * an agent is still writing the sections above it. */
type Heading = { id: string; level: number; depth: number; text: string; el: HTMLElement };

function readHeadings(root: HTMLElement): Heading[] {
  const seen = new Map<string, number>();
  const els = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
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

/** a markdown file read rendered: the text the editor holds, so an agent writing it is seen as it
 * writes. `version` is the bytes on disk its relative images are served from; without one they are
 * left as written. */
export function MarkdownPreview({
  text,
  path,
  worktreeId,
  version,
  openSeq,
  focus,
}: {
  text: string;
  path: string;
  worktreeId: string;
  version: string | null | undefined;
  openSeq: number;
  focus: boolean;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const dir = dirOf(path);
  const html = useMarkdown(text, version === undefined ? undefined : { base: { worktreeId, dir, version } });
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [heads, setHeads] = useState<Heading[]>([]);
  const [at, setAt] = useState(-1);
  // nothing rendered takes focus on its own, so the body does, as a picture's does: Escape then
  // finds the pane
  useOnChange([openSeq], () => {
    if (focus) ref.current?.focus();
  });
  // the headings are read off the rendered DOM rather than the markdown, so they are the ones the
  // sanitizer let through, with the text the way it is drawn
  useOnChange([html], () => {
    if (ref.current) setHeads(readHeadings(ref.current));
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
    // a link inside the page would navigate the shell itself; one to a file beside it opens that file
    e.preventDefault();
    const target = assetPath(dir, href);
    if (target) openFile({ sock, dispatch }, { worktreeId, path: target, view: readingView(target) });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // the document is not editable, so the browser's select-all would take the whole shell with
    // it; here it means the document
    if (isSelectAll(e) && body.current) {
      e.preventDefault();
      selectContents(body.current);
    }
  };
  return (
    <>
      <div ref={ref} className="editor-viewer editor-preview" tabIndex={-1} onClick={onClick} onKeyDown={onKeyDown}>
        <div
          ref={body}
          className="md md-preview"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      <Outline heads={heads} at={at} onJump={jump} />
    </>
  );
}

/** The document's headings as a strip of ticks down the left of the body, one per heading and as
 * wide as its level is high, with the section being read set darker. Pointing at the strip opens
 * the same list with its titles, and a title jumps to its heading. The strip stays outside the
 * scroll box, so it holds still while the document moves under it. */
function Outline({ heads, at, onJump }: { heads: Heading[]; at: number; onJump: (i: number) => void }) {
  const [open, setOpen] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  // an outline of one heading says nothing the title does not
  if (heads.length < 2) return null;
  return (
    <>
      <div
        ref={strip}
        className="editor-outline"
        aria-hidden
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setOpen(true);
        }}
        // a finger cannot hover, so a tap opens it and the list's outside press closes it
        onClick={() => setOpen((o) => !o)}
      >
        {heads.map((h, i) => (
          <span
            key={h.id}
            className="editor-outline-tick"
            data-level={h.level}
            data-state={rowState({ current: i === at })}
          />
        ))}
      </div>
      {open && (
        <Float
          className="editor-outline-list"
          anchor={() => strip.current?.getBoundingClientRect() ?? null}
          // over the strip, so its ticks become the rows' own and the pointer never leaves it on the way
          placement={{ side: "right", align: "center", cover: true }}
          trigger={strip.current}
          onDismiss={() => setOpen(false)}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setOpen(false);
          }}
        >
          {heads.map((h, i) => (
            <button
              key={h.id}
              type="button"
              className="row editor-outline-row"
              data-level={h.level}
              data-state={rowState({ current: i === at })}
              onClick={() => onJump(i)}
            >
              <span className="editor-outline-gutter">
                <span
                  className="editor-outline-tick"
                  data-level={h.level}
                  data-state={rowState({ current: i === at })}
                />
              </span>
              <span className="editor-outline-label" style={{ "--outline-depth": h.depth } as CSSProperties}>
                {h.text}
              </span>
            </button>
          ))}
        </Float>
      )}
    </>
  );
}
