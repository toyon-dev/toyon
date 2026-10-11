import { useEffect } from "react";

/**
 * The preview's size, read in the bar.
 *
 * The frame is the app's whole window, so its box in CSS pixels is what the app inside reads as
 * its viewport, and a person dragging a dock edge is asking exactly that: how wide is it now. The
 * readout says it whenever a frame is on screen and follows every change, from any cause (a dock
 * or pane drag, a dock toggled, the window resized). It stays at rest: a glance after the drag is
 * when the number is read, and it sits in the bar's route field (TopBar.tsx), not over the frame,
 * where keeping it would cost the app its own chrome. Anywhere on the page is somewhere an app
 * keeps that, a centred header as much as a corner, and the bar's nav cluster already sits centred
 * over the preview, so the eye travels no further.
 */

export type Size = { w: number; h: number };

/** whole pixels, the way a browser's own readout says it */
export function readoutText(s: Size): string {
  return `${Math.round(s.w)} × ${Math.round(s.h)}`;
}

/** a box laid out at nothing is hidden, not sized: there is nothing to say of it */
export function measured(s: Size): boolean {
  return s.w > 0 && s.h > 0;
}

/** Says `el`'s box through `say` while `on`, and null otherwise and while the box is hidden. The
 * same whole pixels said twice is the store's to drop, so a sub-pixel move re-renders nothing. */
export function useSizeReadout(el: HTMLElement | null, on: boolean, say: (text: string | null) => void): void {
  useEffect(() => {
    if (!el || !on) {
      say(null);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r) return;
      const next = { w: r.width, h: r.height };
      say(measured(next) ? readoutText(next) : null);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      say(null);
    };
  }, [el, on, say]);
}
