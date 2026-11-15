import type { Point } from "../../ui/place.ts";

/** a sweep across the chips should not flash each one up; the same wait a tooltip takes */
export const PEEK_DELAY = 150;

export type PeekHover = {
  /** the pointer is over the chip; `moved` is whether the hand put it there */
  enter(at: Point, moved: boolean): void;
  /** a mousemove over the chip */
  move(at: Point): void;
  /** the pointer is off the chip; `moved` is whether the hand took it off */
  leave(at: Point, moved: boolean): void;
  /** a mousemove anywhere, while the peek is held */
  away(at: Point): void;
  /** a press: on the chip, or anywhere while the peek is held */
  press(): void;
};

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

/**
 * When a chip's peek is up. It answers the hand, not the page: a transcript that scrolls as a reply
 * streams in carries the chip out from under a resting pointer, and closing there took the picture
 * away from someone who was looking at it and had not moved. So a peek whose chip leaves that way is
 * held, and stays until the pointer moves or presses. The same rule the other way round: a chip
 * carried under a resting pointer does not open, or it would come up unasked and then be held.
 *
 * `hold` says when the caller should feed `away` and `press` from the whole document.
 */
export function createPeekHover({
  show,
  hide,
  hold,
  wait = (fn) => {
    const t = setTimeout(fn, PEEK_DELAY);
    return () => clearTimeout(t);
  },
}: {
  show: () => void;
  hide: () => void;
  hold: (on: boolean) => void;
  /** run `fn` after the delay; returns its cancel */
  wait?: (fn: () => void) => () => void;
}): PeekHover {
  let cancel: (() => void) | null = null;
  let up = false;
  /** where the pointer sat when the chip arrived under it */
  let rest: Point | null = null;
  /** where the pointer sat when the chip left from under it, with the peek up */
  let held: Point | null = null;

  const release = () => {
    if (!held) return;
    held = null;
    hold(false);
  };
  const arm = () => {
    cancel?.();
    cancel = wait(() => {
      cancel = null;
      up = true;
      show();
    });
  };
  const close = () => {
    cancel?.();
    cancel = null;
    rest = null;
    release();
    if (!up) return;
    up = false;
    hide();
  };

  return {
    enter(at, moved) {
      // the chip came back under the pointer: an ordinary hover again
      if (held) return release();
      if (moved) arm();
      else rest = at;
    },
    move(at) {
      if (!rest || same(at, rest)) return;
      rest = null;
      arm();
    },
    leave(at, moved) {
      if (up && !moved) {
        held = at;
        hold(true);
        return;
      }
      close();
    },
    away(at) {
      // a browser may re-send a move at the same place after a scroll; that is still the page
      if (held && !same(at, held)) close();
    },
    press: close,
  };
}
