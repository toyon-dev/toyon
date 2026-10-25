import { type RefObject, useEffect } from "react";
import { foldAt } from "./fold.ts";

/**
 * The phone's foot riding the end of the transcript. On the screen the log runs the whole column
 * and the foot (the box, with the lead row's intro over it) stands on it, so the log's padding is
 * what keeps the last row above the box, and while the reader scrolls up the foot slides down
 * with the end of the transcript, pixel for pixel, as far as the box's fold (fold.ts). A ride is a
 * translate and nothing else: the log's height holds, so no row is laid out again per frame, and
 * the tail's pin, which answers the log resizing, has nothing to answer. Past the extent the box
 * is folded, which is `reading` in the store: the box swaps to its line (Composer) and the bar's
 * strip goes. Measured here and not kept in state, because the ride changes on every scroll
 * event and a value in state would render the log for each.
 *
 * The extent is the box's full height less its folded height, read by folding the box in place
 * for a layout and putting it back before anything paints: the folded line is content the box
 * renders (the field's one line, a card's question) and not a number the stylesheet knows.
 *
 * Written on the panel: `--ride` is the translate as applied (none while the box is not one the
 * fold can take, or stands folded), `--foot` the foot at its full height, which the log pads for
 * folded or not (a fold that shortened the padding would move the reader nearer the end, which
 * unfolds it), and `--foot-show` what of it is on screen, for the pill above it.
 */
export function useFold(
  panelRef: RefObject<HTMLElement | null>,
  logRef: RefObject<HTMLElement | null>,
  on: boolean,
  pinned: () => boolean,
  setReading: (on: boolean) => void,
): void {
  useEffect(() => {
    const panel = panelRef.current;
    const log = logRef.current;
    const wrap = log?.parentElement;
    const box = panel?.querySelector<HTMLElement>(":scope > .chat-input");
    if (!on || !panel || !log || !wrap || !box) {
      setReading(false);
      return;
    }
    let extent = 0;
    let folded = false;
    // the foot as it stands, and at its full height
    let shown = 0;
    let foot = 0;
    const foldable = () => box.classList.contains("foldable");
    const feet = () => [...panel.children].filter((c): c is HTMLElement => c !== wrap && c instanceof HTMLElement);
    const measure = () => {
      const lean = box.classList.contains("lean");
      if (foldable()) {
        box.classList.toggle("lean", !lean);
        const other = box.offsetHeight;
        box.classList.toggle("lean", lean);
        extent = lean ? other - box.offsetHeight : box.offsetHeight - other;
      }
      shown = feet().reduce((h, c) => h + c.offsetHeight, 0);
      foot = lean ? shown + extent : shown;
      panel.style.setProperty("--foot", `${foot}px`);
    };
    const apply = () => {
      const gap = log.scrollHeight - log.scrollTop - log.clientHeight;
      const next = foldAt(gap, extent, folded);
      const ride = foldable() && !box.classList.contains("lean") ? next.ride : 0;
      panel.style.setProperty("--ride", `${ride}px`);
      panel.style.setProperty("--foot-show", `${shown - ride}px`);
      if (next.folded !== folded) {
        folded = next.folded;
        setReading(folded);
      }
    };
    measure();
    apply();
    log.addEventListener("scroll", apply, { passive: true });
    const ro = new ResizeObserver(() => {
      const was = foot;
      measure();
      apply();
      // the foot growing (a card arriving, a draft climbing) pads the log further, which puts the
      // end under the box: a reader at the end stays at it, as on the desk, where the log gives
      // way to the box and the pin answers that
      if (foot > was && pinned()) log.scrollTop = log.scrollHeight;
    });
    for (const c of feet()) ro.observe(c);
    // the box's shape changes under the same class list (a card folding, the caret arriving), and
    // the intro comes and goes with the lead row's draft. The measure's own toggle is two records
    // that leave the class list as it was, and acting on them would measure without end.
    let classes = box.className;
    const mo = new MutationObserver((records) => {
      let changed = false;
      for (const r of records) {
        if (r.type !== "childList") continue;
        changed = true;
        for (const n of r.addedNodes) if (n instanceof HTMLElement) ro.observe(n);
        for (const n of r.removedNodes) if (n instanceof HTMLElement) ro.unobserve(n);
      }
      if (box.className !== classes) {
        classes = box.className;
        changed = true;
      }
      if (!changed) return;
      measure();
      apply();
    });
    mo.observe(box, { attributes: true, attributeFilter: ["class"] });
    mo.observe(panel, { childList: true });
    return () => {
      log.removeEventListener("scroll", apply);
      ro.disconnect();
      mo.disconnect();
      for (const v of ["--ride", "--foot", "--foot-show"]) panel.style.removeProperty(v);
      setReading(false);
    };
  }, [panelRef, logRef, on, pinned, setReading]);
}
