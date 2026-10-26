import type { Screen } from "../../state/store.ts";
import type { Way } from "../../ui/swipe.ts";

/** The phone's screens in a line, left to right: the list, then a worktree's three faces in the
 * order the segmented control shows them. A swipe moves one step along it. */
export const FACES = ["home", "chat", "preview", "changes"] as const satisfies readonly Screen[];

/** which side of `from` a neighbour `to` stands on, for the stylesheet */
export const sideOf = (from: Screen, to: Screen): "left" | "right" =>
  FACES.indexOf(to) < FACES.indexOf(from) ? "left" : "right";

/** The screen a swipe `way` from `from` reaches, or null for nothing that way. A finger moving
 * right pulls in the screen to the left. The preview is in the line only while the worktree has
 * one; nothing is left of the list, and nothing right of the code. The list is left by a swipe
 * only for `back`, the face it just came from (backFace): otherwise a row's own slide owns the
 * sideways move there. */
export function swipeTo(from: Screen, way: Way, previewed: boolean, back: Screen | null = null): Screen | null {
  if (from === "home") {
    if (way !== "left" || !back || back === "home") return null;
    return back === "preview" && !previewed ? "chat" : back;
  }
  const line = FACES.filter((f) => f !== "preview" || previewed);
  const at = line.indexOf(from);
  if (at < 0) return null;
  return line[at + (way === "right" ? -1 : 1)] ?? null;
}
