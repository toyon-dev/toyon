import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useState } from "react";
import { copyText } from "../../state/actions/deps.ts";
import { useTouch } from "../../state/selectors.ts";
import { IconButton } from "../../ui/Button.tsx";
import { blockText } from "./codeBlock.ts";

/** how long the control reads as done before it offers the copy again */
const COPIED_MS = 1500;
/** the control's distance from the block's top and right edges */
const INSET = 4;
/** a fenced block: rendered markdown's, or the one the ask's band holds when the band itself is
 * set in code */
const BLOCK = ".md pre, .card-code pre";

/** the fenced block an element is in, if any */
export function codeBlockAt(target: Element): HTMLElement | null {
  return target.closest<HTMLElement>(BLOCK);
}

/** the text of the fenced block under the pointer, for a menu opened on one */
export function codeAt(target: Element): string | null {
  const pre = codeBlockAt(target);
  return pre ? blockText(pre.textContent ?? "") : null;
}

/** A block and where its control goes. `nth` is the block's place among its root's, which is what
 * says "the same block" across a stream's re-renders: each one swaps the elements. */
type Corner = { pre: HTMLElement; nth: number; top: number; right: number };

const NONE: readonly Corner[] = [];

const blocksIn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(BLOCK)];

/** where the control goes inside `root`, which is positioned and may scroll: the block's top-right
 * corner, in the coordinates an absolute child of the root's padding box is placed in */
function cornerOf(root: HTMLElement, pre: HTMLElement, nth: number): Corner {
  const r = root.getBoundingClientRect();
  const p = pre.getBoundingClientRect();
  return {
    pre,
    nth,
    top: p.top - r.top + root.scrollTop + INSET,
    right: r.left + root.clientLeft + root.clientWidth - p.right + INSET,
  };
}

/** every block in `root` with its corner, and `prev` itself when none of them moved, so a read
 * that finds nothing new renders nothing */
function cornersIn(root: HTMLElement, prev: readonly Corner[]): readonly Corner[] {
  const next = blocksIn(root).map((pre, nth) => cornerOf(root, pre, nth));
  const same =
    next.length === prev.length &&
    next.every((c, i) => c.pre === prev[i]?.pre && c.top === prev[i]?.top && c.right === prev[i]?.right);
  return same ? prev : next;
}

/**
 * The copy controls for the fenced blocks in `root`: one in the corner of whichever block the
 * pointer is over, and on touch, where no pointer says which, one on every block. The blocks are
 * markup marked wrote and innerHTML put in, so React owns nothing inside them: a control is the
 * root's own child, laid over its block by measuring it, the way the composer's stop is laid over
 * the corner of its field. Nothing in the markup is positioned, so a control paints over it with
 * no rung of its own. The root is the pointer's boundary, so moving onto the control is still
 * hovering the block; a block re-rendered while it streams is off the page and takes the pointer's
 * next move to find again. Render what this returns as the root's last child, after the element
 * the markup goes into.
 */
export function useCodeCopy(root: RefObject<HTMLElement | null>): ReactNode {
  const touch = useTouch();
  const [hovered, setHovered] = useState<Corner | null>(null);
  const [all, setAll] = useState<readonly Corner[]>(NONE);
  // the block whose text is on the clipboard, while its control says so
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => {
    const el = root.current;
    // a finger's press is over the block only while it is down, and gone before it could land
    if (touch || !el) return;
    const over = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;
      // onto the control itself: still on its block, which it is not inside of
      if (e.target.closest(".code-copy")) return;
      const at = codeBlockAt(e.target);
      setHovered(at && el.contains(at) ? cornerOf(el, at, blocksIn(el).indexOf(at)) : null);
    };
    const leave = () => setHovered(null);
    el.addEventListener("pointerover", over);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerover", over);
      el.removeEventListener("pointerleave", leave);
    };
  }, [root, touch]);
  // On touch the corners are read after every render, because a render is how the markup changes:
  // the caller swaps it in ahead of this effect, and the controls land in the same paint.
  useLayoutEffect(() => {
    const el = root.current;
    if (touch && el) setAll((prev) => cornersIn(el, prev));
  });
  // And again when the root changes size with no render behind it: a turned phone rewraps the
  // prose above a block, a picture arrives over one. What a root that scrolls holds is taller
  // than the root and grows without it, so its first child, the markup, is watched as well.
  useEffect(() => {
    const el = root.current;
    if (!touch || !el) return;
    const ro = new ResizeObserver(() => setAll((prev) => cornersIn(el, prev)));
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [root, touch]);
  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const shown = touch ? all : hovered?.pre.isConnected ? [hovered] : NONE;
  return shown.map(({ pre, nth, top, right }) => {
    const done = copied === nth;
    return (
      <IconButton
        key={nth}
        className="code-copy"
        style={{ top, right }}
        icon={done ? "check" : "copy"}
        label={done ? "Copied" : "Copy code"}
        onClick={() => {
          copyText(blockText(pre.textContent ?? ""));
          setCopied(nth);
        }}
      />
    );
  });
}
