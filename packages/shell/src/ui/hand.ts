import type { Point } from "./place.ts";

/**
 * Whether the hand moved the pointer, or the page moved under it. A list that scrolls under a
 * resting pointer fires the same enter and leave on its rows that a move does, at the coordinates
 * the pointer already had, so a hover that should answer the hand alone asks here which one it got.
 */

let last: Point | null = null;
let watching = false;

/** Start following the pointer; safe to call from every component that asks. Capture, so a
 * surface that stops a move from bubbling does not leave the place stale. */
export function watchHand(): void {
  if (watching) return;
  watching = true;
  document.addEventListener(
    "mousemove",
    (e) => {
      last = { x: e.clientX, y: e.clientY };
    },
    true,
  );
}

/** True when this enter or leave came from a move. A browser sends the boundary events of a move
 * ahead of its mousemove, so the place held here is still the one the pointer came from. Before
 * the first move there is nothing to compare with, and the event is taken as the hand's. */
export function handMoved(e: { clientX: number; clientY: number }): boolean {
  return !last || e.clientX !== last.x || e.clientY !== last.y;
}
