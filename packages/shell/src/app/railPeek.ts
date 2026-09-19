/** The walk's peek: a worktree walk on the collapsed rail peeks the panel open, the way an alt-tab
 * switcher shows while the modifier is down, and letting go of that modifier closes it. The walk has
 * three spellings on three modifiers (⌥↑/↓, ⌃Tab, ⌘⇧[ ]), so the one that fired the chord is the
 * one whose release ends the peek. */
export type WalkModifier = "Alt" | "Control" | "Meta";

type Mods = { altKey: boolean; ctrlKey: boolean; metaKey: boolean };

/** the modifier a walk chord rode, from the keydown that matched it */
export function walkModifier(e: Mods): WalkModifier | null {
  if (e.altKey) return "Alt";
  if (e.ctrlKey) return "Control";
  if (e.metaKey) return "Meta";
  return null;
}

/** whether the modifier a walk rode is still down, read off any later event that reports the
 * modifiers. The release itself can go unseen: a keyup that lands in a preview frame is mirrored
 * back only by a bridge that knows to, and one that lands in another window never comes. The next
 * key or pointer event says where the key stands, and that is enough to end a peek it outlived. */
export function modifierHeld(e: Mods, mod: WalkModifier): boolean {
  if (mod === "Alt") return e.altKey;
  if (mod === "Control") return e.ctrlKey;
  return e.metaKey;
}
