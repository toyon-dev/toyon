import type { Store } from "../state/context.tsx";
import { archivedPageOf, type State, worktreeById } from "../state/store.ts";
import { type Entry, type FloatStack, floats } from "../ui/floats.ts";

/**
 * The phone's way back is the browser's too: the edge swipe on iOS, the back button or gesture on
 * Android. Nothing on the phone navigates the page, so without an entry per screen the gesture
 * leaves Toyon for whatever the tab held before it, and a tab opened from toyon.cloud held nothing:
 * a blank page.
 *
 * The screens stack three deep: the list, a worktree over it, and a file's diff over that. Each
 * level stands on an entry of its own, marked with its depth, so going back is the browser moving
 * one entry down and this module closing whatever stands above the entry it landed on. The tabs of
 * one worktree are one level: a tab is a choice of what to look at, not somewhere the person went.
 *
 * A box over the screen (a picture at full size, a menu, the settings, a picker) is one more level
 * on top of whichever screen it covers, because the phone has no Escape and the swipe is the key
 * it reaches for. One entry stands for all the boxes that are open: back closes the topmost the way
 * Escape would, and while another is still up the entry goes straight back for the next swipe.
 *
 * The store stays the truth. A way back the page draws (the bar's back arrow, a tab shutting the
 * diff) moves the state first, and the history is walked down after it to match, so the next swipe
 * goes where the screen says rather than to an entry for a screen already closed. That walk comes
 * back here as a popstate for the depth the state already has, and does nothing.
 *
 * The preview's own navigations are entries in the same history (a frame's history is the tab's),
 * so a swipe on the preview tab walks the app back first, the way it would in its own tab.
 */

const KEY = "toyonDepth";
/** marks the entry a box stands on, so forward into one is not read as forward into a screen */
const OVER = "toyonOver";

/** How many screens deep the phone is, or null while that is not the phone's to say: on the desk,
 * whose back belongs to the browser, and before the daemon's first hello, when the remembered row
 * is not listed yet and the depth would read as the list for a moment. */
export function depthOf(s: State): number | null {
  if (s.frame !== "phone" || !s.heard) return null;
  // the same test PhoneFrame draws by: a row that went while its screen was open is the list
  const onWorktree = s.screen !== "home" && (worktreeById(s, s.activeId) !== null || archivedPageOf(s) !== null);
  if (!onWorktree) return 0;
  return s.editor ? 2 : 1;
}

export interface HistoryHost {
  readonly history: Pick<History, "state" | "pushState" | "replaceState" | "go">;
  addEventListener(type: "popstate", fn: (e: PopStateEvent) => void): void;
  removeEventListener(type: "popstate", fn: (e: PopStateEvent) => void): void;
}

const depthIn = (entry: unknown): number | null => {
  const d = entry && typeof entry === "object" ? (entry as Record<string, unknown>)[KEY] : undefined;
  return typeof d === "number" ? d : null;
};

const isOver = (entry: unknown): boolean =>
  !!entry && typeof entry === "object" && (entry as Record<string, unknown>)[OVER] === true;

/** Keeps the tab's history one entry per level the phone is on. Installed once beside the store,
 * the way the frame watch is; returns the uninstall. */
export function installPhoneHistory(
  store: Store,
  host: HistoryHost = window,
  boxes: Pick<FloatStack, "open" | "watch" | "shut"> = floats,
): () => void {
  const h = host.history;
  // the depth of the entry the browser is on. A page that opens on an entry of its own (a reload
  // keeps the entry and its mark) knows where it stands; a fresh one marks its entry as the list,
  // and a remembered worktree then goes on top of it, so the first swipe lands on the list
  let at = depthIn(h.state) ?? 0;
  if (depthIn(h.state) === null) h.replaceState({ [KEY]: 0 }, "");

  // the box a swipe was spent on. Its close is a render away, so until it has gone it is not
  // counted: counted, the store change that closes it would stand it on a new entry first
  let shutting: Entry | null = null;
  /** the topmost box a swipe can close; one nothing dismisses (a first run to confirm) is not one */
  const topBox = (): Entry | null => {
    const open = boxes.open();
    if (shutting && !open.includes(shutting)) shutting = null;
    for (let i = open.length - 1; i >= 0; i--) {
      const e = open[i];
      if (e?.dismiss && e !== shutting) return e;
    }
    return null;
  };

  // walks this module asked for whose popstate has not come yet
  let walks = 0;

  const sync = () => {
    const screens = depthOf(store.getState());
    if (screens === null) return;
    const want = screens + (topBox() ? 1 : 0);
    if (want === at) return;
    if (want > at) for (let d = at + 1; d <= want; d++) h.pushState({ [KEY]: d, [OVER]: d > screens }, "");
    else {
      h.go(want - at);
      walks++;
    }
    at = want;
  };

  // A box opening or closing is heard mid-commit, and one commit can do both: a menu row that
  // opens a picker, or a development build mounting everything twice. A go is not settled when it
  // returns, so an entry pushed behind one is the entry it lands under; the count is read once,
  // after the commit.
  let queued = false;
  const syncSoon = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sync();
    });
  };

  const onPop = (e: PopStateEvent) => {
    const ours = walks > 0;
    if (ours) walks--;
    at = depthIn(e.state) ?? 0;
    const s = store.getState();
    const screens = depthOf(s);
    if (screens === null) return;
    const box = topBox();
    const now = screens + (box ? 1 : 0);
    if (now === at) return;
    if (now > at && box) {
      // back with a box up closes that box alone; the sync that follows its going puts the entry
      // back while another is still open
      shutting = box;
      boxes.shut(box);
      return;
    }
    if (now > at) {
      // back: the diff shuts onto the tab under it (a move to the tab already open does that),
      // and below a worktree is the list
      store.dispatch(at === 0 ? { a: "screen", to: "home" } : { a: "screen", to: s.screen });
    } else if (ours && walks > 0) {
      // the first of two walks down (a box that closed as the screen under it dropped a level)
      // lands above where the screen is, which is what forward looks like; the second is coming
      return;
    } else if (!ours && now === 0 && s.activeId && !isOver(e.state)) {
      // forward from the list into the row it came back from; a diff above that is not
      // remembered, and neither is a box, so the sync below walks the entry for either back down
      store.dispatch({ a: "screen", to: "chat" });
    }
    sync();
  };

  host.addEventListener("popstate", onPop);
  const unsubscribe = store.subscribe(sync);
  const unwatch = boxes.watch(syncSoon);
  sync();
  return () => {
    host.removeEventListener("popstate", onPop);
    unsubscribe();
    unwatch();
  };
}
