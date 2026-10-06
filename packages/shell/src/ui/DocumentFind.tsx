import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { FindBox } from "./FindBox.tsx";
import { type Match, matchOffsets, nearestIndex, segmentsOf, spanOf, stepped } from "./find.ts";

/** the two highlight names the stylesheet paints: every match, and the one the reader is on */
const ALL = "find";
const CURRENT = "find-current";

/** the CSS highlight API paints a range with no change to the DOM under it; an engine without it
 * still gets the count, the stepping and the scroll, with only the wash missing */
const CAN_PAINT = typeof CSS !== "undefined" && "highlights" in CSS;

/** the text that is drawn: a folded row's body is in the DOM and off the screen, and a match in
 * it would count and scroll to nothing */
function shown(node: Text): boolean {
  const el = node.parentElement;
  if (!el) return false;
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}

function textNodesOf(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data.length > 0 && shown(t)) nodes.push(t);
  }
  return nodes;
}

type Found = { matches: Match[]; ranges: Range[] };
const NOTHING: Found = { matches: [], ranges: [] };

function search(body: HTMLElement, query: string): Found {
  if (!query) return NOTHING;
  const nodes = textNodesOf(body);
  const matches = matchOffsets(nodes.map((n) => n.data).join(""), query);
  const segments = segmentsOf(nodes.map((n) => n.data.length));
  const ranges = matches.map((m) => {
    const { from, to } = spanOf(segments, m);
    const range = document.createRange();
    range.setStart(nodes[from.i]!, from.at);
    range.setEnd(nodes[to.i]!, to.at);
    return range;
  });
  return { matches, ranges };
}

function paint(ranges: Range[], at: number) {
  if (!CAN_PAINT) return;
  CSS.highlights.set(ALL, new Highlight(...ranges.filter((_, i) => i !== at)));
  CSS.highlights.set(CURRENT, new Highlight(...(ranges[at] ? [ranges[at]] : [])));
}

function unpaint() {
  if (!CAN_PAINT) return;
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(CURRENT);
}

/** the first match at or below the top of the scroll box, wrapping to the first of all when every
 * match is above it; -1 with none */
function firstFrom(ranges: Range[], root: HTMLElement): number {
  if (ranges.length === 0) return -1;
  const top = root.getBoundingClientRect().top;
  const i = ranges.findIndex((r) => r.getBoundingClientRect().bottom >= top);
  return i === -1 ? 0 : i;
}

/** air kept between the match and the box's edge before the scroll box is left alone */
const MARGIN = 48;

/** the match brought a third of the way down the box, where a heading jumped to sits as well; one
 * already comfortably in view leaves the scroll where the reader put it */
function reveal(root: HTMLElement, range: Range) {
  const r = range.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  if (r.top >= box.top + MARGIN && r.bottom <= box.bottom - MARGIN) return;
  root.scrollTop += r.top - box.top - box.height / 3;
}

/**
 * Find in the document on screen, as the editor has for a file: a box over the top corner of the
 * text, the count, and the next and previous steps. Every match is washed and the current one
 * darker, the way Monaco marks them. The document is live under it (an agent may still be writing
 * the file, or the conversation), so the matches are read again whenever its DOM changes, with the
 * reader kept on the match they were on and the scroll left alone.
 *
 * `root` is the box that scrolls and `body` the element the text is read from; they may be one.
 * `seed` and `seq` are the box's own (FindBox): what the document had selected at the press.
 */
export function DocumentFind({
  root,
  body,
  seed,
  seq,
  onClose,
  onReveal,
}: {
  root: RefObject<HTMLElement | null>;
  body: RefObject<HTMLElement | null>;
  seed: string;
  seq: number;
  /** the match the reader was on when the box closed, for the document to keep as its selection */
  onClose: (current: Range | null) => void;
  /** the box was scrolled to bring a match into view, for a root that follows its own end */
  onReveal?: () => void;
}) {
  const [query, setQuery] = useState(seed);
  const [found, setFound] = useState<Found>(NOTHING);
  const [at, setAt] = useState(-1);
  // the same two as refs, for the read that decides the next index before the render that shows it
  const live = useRef({ found: NOTHING, at: -1 });
  // what the last read was for: a re-read of a changed document keeps the index, a new query moves
  // to the match nearest where the reader was
  const searched = useRef("");
  // whether the next paint also scrolls: a new query and a step do, a document changing under the
  // reader does not
  const show = useRef(false);
  // the document changing under the box: one re-read per frame however many nodes moved
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    let raf = 0;
    const observer = new MutationObserver(() => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setTick((t) => t + 1);
        });
    });
    // a fold opening or closing is an attribute, and changes what is shown without moving a node
    observer.observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [body]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the document changing under the search, which is what re-reads it
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const next = search(el, query);
    const fresh = query !== searched.current;
    searched.current = query;
    if (fresh) show.current = true;
    const { found: was, at: prev } = live.current;
    let index: number;
    if (!fresh) index = Math.min(prev, next.matches.length - 1);
    else if (was.matches[prev]) index = nearestIndex(next.matches, was.matches[prev].start);
    // the first query, or one typed over after every match went: start from what is on screen,
    // as the browser's find does, rather than from the top of a document read halfway down
    else index = root.current ? firstFrom(next.ranges, root.current) : nearestIndex(next.matches, 0);
    live.current = { found: next, at: index };
    setFound(next);
    setAt(index);
  }, [query, tick]);

  useLayoutEffect(() => {
    paint(found.ranges, at);
    const range = found.ranges[at];
    // a scroll asked for waits for a match to scroll to: the first render after a query has none yet
    if (!range) return;
    if (show.current && root.current) {
      reveal(root.current, range);
      onReveal?.();
    }
    show.current = false;
  }, [found, at, root, onReveal]);

  useLayoutEffect(() => unpaint, []);

  const count = found.matches.length;
  const step = (dir: 1 | -1) => {
    if (count === 0) return;
    show.current = true;
    const index = stepped(live.current.at, count, dir);
    live.current = { ...live.current, at: index };
    setAt(index);
  };
  const close = () => onClose(found.ranges[at] ?? null);

  return (
    <FindBox
      label="find in this document"
      query={query}
      onQuery={setQuery}
      seed={seed}
      seq={seq}
      status={query ? (count === 0 ? "no matches" : `${at + 1}/${count}`) : ""}
      none={count === 0}
      onStep={step}
      onClose={close}
    />
  );
}
