import { useEffect, useState } from "react";

/**
 * The preview's size, said while it changes.
 *
 * The frame is the app's whole window, so its box in CSS pixels is what the app inside reads as
 * its viewport, and a person dragging a dock edge is asking exactly that: how wide is it now. The
 * readout answers whenever the box changes, from any cause (a dock or pane drag, a dock toggled,
 * the window resized) and goes once the size has held for a moment. Nothing is said at rest, and
 * nothing on first measure: a size that was always so is not a change.
 */

/** how long the readout stays after the size last moved */
export const READOUT_MS = 900;

export type Size = { w: number; h: number };

/** whole pixels, the way a browser's own readout says it */
export function readoutText(s: Size): string {
  return `${Math.round(s.w)} × ${Math.round(s.h)}`;
}

/** whether an observation is a change worth saying: not the first one (nothing moved), not a box
 * laid out at nothing (hidden, not resized), and not the same whole pixels as last time */
export function isChange(prev: Size | null, next: Size): boolean {
  if (!prev) return false;
  if (next.w <= 0 || next.h <= 0) return false;
  return Math.round(prev.w) !== Math.round(next.w) || Math.round(prev.h) !== Math.round(next.h);
}

/** The readout for `el`'s box while `on`, null otherwise and at rest. A box that comes back after
 * being hidden starts over: whatever size it returns at is its first measure, not a change. */
export function useSizeReadout(el: HTMLElement | null, on: boolean): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!el || !on) {
      setText(null);
      return;
    }
    let prev: Size | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r) return;
      const next = { w: r.width, h: r.height };
      if (isChange(prev, next)) {
        setText(readoutText(next));
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => setText(null), READOUT_MS);
      }
      if (next.w > 0 && next.h > 0) prev = next;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
      setText(null);
    };
  }, [el, on]);
  return text;
}
