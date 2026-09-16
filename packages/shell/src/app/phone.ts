import type { Store } from "../state/context.tsx";
import type { Frame } from "../state/store.ts";

/**
 * Which frame the shell draws, and whether it is being touched. Two facts, asked here and nowhere
 * else, and kept in the store: the reducer holds what depends on them (the desk's remembered
 * layout is never written from the phone) and every surface reads an answer rather than asking a
 * question of its own, which is how two answers come to disagree.
 *
 * The frame is about room. The desk's row of docks needs about 740px to exist at all, so below
 * NARROW_MAX a window of any kind draws the phone frame, which is also how the frame gets worked on
 * from a desktop browser. A touch device stays one column further, up to TOUCH_MAX: a phone held
 * sideways is 844px, which has the width for docks and none of the hover that drives them, and a
 * frame that flipped on every rotate would unmount every screen. Above TOUCH_MAX a touch device is a
 * tablet with room for the desk, and the desk answers touch itself.
 *
 * Touch is about input, and both frames read it: a tip needs a hover to leave on, a row's menu
 * needs a tap where the kebab wanted a pointer, and the desk's rail needs a tap to open where it
 * peeked.
 */

/** the width at and below which any window is the phone frame */
export const NARROW_MAX = 640;
/** the width at and below which a touch device is the phone frame. The least certain number here:
 * an 820px tablet lands on the phone frame where the desk might just fit. One constant to move. */
export const TOUCH_MAX = 1000;

export const FRAME_QUERY = `(max-width: ${NARROW_MAX}px), ((hover: none) and (max-width: ${TOUCH_MAX}px))`;
export const TOUCH_QUERY = "(hover: none)";

/** the frame for this window right now, to seed the store before anything renders */
export const frameNow = (): Frame => (window.matchMedia?.(FRAME_QUERY).matches ? "phone" : "desk");
/** whether this window has no hover right now, for the same seeding */
export const touchNow = (): boolean => window.matchMedia?.(TOUCH_QUERY).matches ?? false;

/**
 * Keeps the store's two facts current. A media query fires once, when its answer changes, where a
 * width in state would re-render every row on every frame of a drag. Installed once beside the
 * store, the way the float stack is; returns the uninstall.
 */
export function installFrame(store: Pick<Store, "dispatch">): () => void {
  const watch = (query: string, apply: (matches: boolean) => void) => {
    const mq = window.matchMedia?.(query);
    if (!mq) return () => {};
    const on = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  };
  const offFrame = watch(FRAME_QUERY, (m) => store.dispatch({ a: "frame", v: m ? "phone" : "desk" }));
  const offTouch = watch(TOUCH_QUERY, (m) => store.dispatch({ a: "touch", v: m }));
  return () => {
    offFrame();
    offTouch();
  };
}
