export type DockSide = "left" | "right";

/** The width a drag sets: the pointer's distance from the dock's far edge, the one the handle is
 * not on. `side` is where the dock stands relative to its handle, so a dock measures the same way
 * whichever edge of the window it is on. Clamping is the caller's (clampW). */
export function dockWidthAt(dock: { left: number; right: number }, side: DockSide, clientX: number): number {
  return side === "left" ? clientX - dock.left : dock.right - clientX;
}
