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

/** How long the modifier stays down after a lone walk press before the rail shows for it. A tap
 * of the chord is a switch and nothing else, the way a tap of alt-tab swaps windows without the
 * switcher; the switcher is for a hand that is still holding, or that presses again to walk on. */
export const PEEK_HOLD_MS = 200;

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The peek's state: which modifier the hold rides, and whether the rail has been earned yet.
 * `show` is called with the rail's answer, at most once per change. */
export function createWalkPeek(show: (on: boolean) => void, timers: Timers = realTimers) {
  let mod: WalkModifier | null = null;
  let shown = false;
  let pending: unknown = null;
  const open = () => {
    if (shown) return;
    shown = true;
    show(true);
  };
  const settle = () => {
    if (pending === null) return;
    timers.clear(pending);
    pending = null;
  };
  const end = () => {
    settle();
    mod = null;
    if (!shown) return;
    shown = false;
    show(false);
  };
  return {
    /** a walk press: the first under a hold waits to see if the hold lasts, any later one under
     * the same hold (a second step, or the key's own repeat) shows the rail now */
    press(e: Mods) {
      const held = mod !== null;
      mod = walkModifier(e);
      settle();
      if (!mod) return;
      if (held) open();
      else {
        pending = timers.set(() => {
          pending = null;
          open();
        }, PEEK_HOLD_MS);
      }
    },
    /** the release of a key by name, from a keyup */
    keyup(key: string) {
      if (mod && key === mod) end();
    },
    /** any later event that reports the modifiers, for a release that was never seen */
    mods(e: Mods) {
      if (mod && !modifierHeld(e, mod)) end();
    },
    end,
  };
}
