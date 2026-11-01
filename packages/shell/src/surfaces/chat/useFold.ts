import { type RefObject, useEffect } from "react";
import { foldedAt } from "./fold.ts";

/**
 * The box's fold on the phone, and the lengths the stylesheet rides on. On the phone the box is
 * the log's last child, sticky at its foot (chat.css): with `--fold` as a negative bottom offset it rides down
 * with the end of the transcript, pixel for pixel in the compositor, and stops with its top rows
 * on screen. Nothing here runs per scroll frame for the ride. This measures the box as its shape
 * changes and writes three lengths on the wrap: `--fold`, how far it may ride, its height less
 * its folded rows, and zero on the desk or for a box the fold cannot take; `--keep`, what of it
 * stays on screen at the end of the ride,
 * for the pill that stands on it; and `--cover`, what of the scrollport it covers as the reader
 * stands, the whole box or past the ride its folded rows, for what brings a row into view. On
 * the desk the box stands under the log, so none of this is found and nothing is written.
 *
 * The folded rows are measured by folding the box in place for one layout and putting it back
 * before anything paints: they are content the box renders (a plan row, the field's first line,
 * a card's question) and not a number the stylesheet knows.
 *
 * `reading` in the store is by place, a reader past the ride's extent: the bar's strip folds and
 * the field's ghost takes its one-line form (Composer). Read off scroll events, which flip the
 * flag at the threshold and write nothing per frame.
 */
export function useFold(logRef: RefObject<HTMLElement | null>, on: boolean, setReading: (on: boolean) => void): void {
  useEffect(() => {
    const log = logRef.current;
    const wrap = log?.parentElement;
    const box = log?.querySelector<HTMLElement>(":scope > .chat-input");
    if (!log || !wrap || !box) {
      setReading(false);
      return;
    }
    let extent = 0;
    let folded = false;
    let full = 0;
    let kept = 0;
    const cover = () => wrap.style.setProperty("--cover", `${folded ? kept : full}px`);
    const measure = () => {
      full = box.offsetHeight;
      kept = full;
      if (on && box.classList.contains("foldable")) {
        // the box folded for the layout shortens the log, and a log at its end is clamped back by
        // the difference, which the restored height does not undo: the place is put back by hand
        const top = log.scrollTop;
        box.classList.add("fold-measure");
        kept = box.offsetHeight;
        box.classList.remove("fold-measure");
        log.scrollTop = top;
      }
      extent = full - kept;
      wrap.style.setProperty("--fold", `${extent}px`);
      wrap.style.setProperty("--keep", `${kept}px`);
      cover();
    };
    const place = () => {
      if (!on) return;
      const next = foldedAt(log.scrollHeight - log.scrollTop - log.clientHeight, extent, folded);
      if (next === folded) return;
      folded = next;
      cover();
      setReading(folded);
    };
    measure();
    place();
    log.addEventListener("scroll", place, { passive: true });
    const ro = new ResizeObserver(() => {
      measure();
      place();
    });
    ro.observe(box);
    // the box's shape changes under the same height (a card arriving, the caret leaving a blank
    // field). The measure's own toggle is two records that leave the class list as it was, and
    // acting on them would measure without end.
    let classes = box.className;
    const mo = new MutationObserver(() => {
      if (box.className === classes) return;
      classes = box.className;
      measure();
      place();
    });
    mo.observe(box, { attributes: true, attributeFilter: ["class"] });
    return () => {
      log.removeEventListener("scroll", place);
      ro.disconnect();
      mo.disconnect();
      for (const v of ["--fold", "--keep", "--cover"]) wrap.style.removeProperty(v);
      setReading(false);
    };
  }, [logRef, on, setReading]);
}
