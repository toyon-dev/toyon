import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { copyText } from "../../state/actions/deps.ts";
import { IconButton } from "../../ui/Button.tsx";
import { blockText } from "./codeBlock.ts";

/** how long the control reads as done before it offers the copy again */
const COPIED_MS = 1500;
/** the control's distance from the block's top and right edges */
const INSET = 4;

/** the fenced block an element of rendered markdown is in, if any */
export function codeBlockAt(target: Element): HTMLElement | null {
  return target.closest<HTMLElement>(".md pre");
}

/** the text of the fenced block under the pointer, for a menu opened on one */
export function codeAt(target: Element): string | null {
  const pre = codeBlockAt(target);
  return pre ? blockText(pre.textContent ?? "") : null;
}

type Hovered = { pre: HTMLElement; top: number; right: number };

/** where the control goes inside `root`, which is positioned and may scroll: the block's top-right
 * corner, in the coordinates an absolute child of the root's padding box is placed in */
function cornerOf(root: HTMLElement, pre: HTMLElement): Hovered {
  const r = root.getBoundingClientRect();
  const p = pre.getBoundingClientRect();
  return {
    pre,
    top: p.top - r.top + root.scrollTop + INSET,
    right: r.left + root.clientLeft + root.clientWidth - p.right + INSET,
  };
}

/**
 * A copy control in the corner of whichever fenced block in `root` the pointer is over. The blocks
 * are markup marked wrote and innerHTML put in, so React owns nothing inside them: the control is
 * the root's own last child, laid over the block by measuring it, the way the composer's stop is
 * laid over the corner of its field. Nothing in the markup is positioned, so the control paints
 * over it with no rung of its own. The root is the pointer's boundary, so moving onto the control
 * is still hovering the block; a block re-rendered while it streams is off the page and takes the
 * pointer's next move to find again. Render what this returns as the root's last child, after the
 * div the markup goes into.
 */
export function useCodeCopy(root: RefObject<HTMLElement | null>): ReactNode {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  // the block whose text is on the clipboard, while the control says so
  const [copied, setCopied] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const over = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;
      // onto the control itself: still on its block, which it is not inside of
      if (e.target.closest(".code-copy")) return;
      const at = codeBlockAt(e.target);
      setHovered(at && el.contains(at) ? cornerOf(el, at) : null);
    };
    const leave = () => setHovered(null);
    el.addEventListener("pointerover", over);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerover", over);
      el.removeEventListener("pointerleave", leave);
    };
  }, [root]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  if (!hovered?.pre.isConnected) return null;
  const { pre, top, right } = hovered;
  const done = copied === pre;
  return (
    <IconButton
      className="code-copy"
      style={{ top, right }}
      icon={done ? "check" : "copy"}
      label={done ? "Copied" : "Copy code"}
      onClick={() => {
        copyText(blockText(pre.textContent ?? ""));
        setCopied(pre);
      }}
    />
  );
}
