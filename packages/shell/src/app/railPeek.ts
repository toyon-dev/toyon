/** The walk's peek: a worktree walk on the collapsed rail peeks the panel open, the way an alt-tab
 * switcher shows while the modifier is down, and letting go of that modifier closes it. The walk has
 * three spellings on three modifiers (⌥↑/↓, ⌃Tab, ⌘⇧[ ]), so the one that fired the chord is the
 * one whose release ends the peek. */
export type WalkModifier = "Alt" | "Control" | "Meta";

/** the modifier a walk chord rode, from the keydown that matched it */
export function walkModifier(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }): WalkModifier | null {
  if (e.altKey) return "Alt";
  if (e.ctrlKey) return "Control";
  if (e.metaKey) return "Meta";
  return null;
}

/** how long a peek outlives the last walk press when its release is never seen: the preview frame
 * can hold the keyboard, and a keyup that lands there is not mirrored back */
export const PEEK_FALLBACK_MS = 1000;
