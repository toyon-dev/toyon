import type { Store } from "../state/context.tsx";
import { archivedPageOf, isChatCentred, rowById, type State, worktreeById } from "../state/store.ts";
import { type Entry, type FloatStack, floats } from "../ui/floats.ts";

/**
 * The phone's way back is the browser's too: the edge swipe on iOS, the back button or gesture on
 * Android. Nothing on the phone navigates the page, so without an entry per screen the gesture
 * leaves Toyon for whatever the tab held before it, and a tab opened from a home-screen icon held nothing:
 * a blank page.
 *
 * The screens stack four deep: the list, a worktree's chat over it, another of its tabs over the
 * chat, and a file's diff over whichever tab it opened from. Each level stands on an entry of its
 * own, marked with its depth, so going back is the browser moving one entry down and this module
 * closing whatever stands above the entry it landed on. A worktree opens on its chat, so the chat
 * is what back from another tab returns to; the other tabs share one level between them, because
 * moving from one to the other is a choice of what to look at, not somewhere the person went.
 *
 * The list stands on an entry of its own too, over a floor: the entry the page arrived on, which
 * is the tab's first in an installed app. Back from the list lands on the floor, and the list's
 * entry is laid again over it, so the screen stays: there is nothing under the list, and the
 * browser's own answer to a back with nothing under it is to leave the page for the blank it
 * started from. Chromium marks the entries a page pushes without a tap as ones its back skips,
 * and skips the floor with them on a back before the first tap; that one back leaves, and no
 * entry can hold it.
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
 * laid between the shell's: an app that pushes a route stands an entry over the screen's. A step
 * of the tab's history moves one of the two, the shell or the frame, never both. On the preview
 * tab a swipe walks the app back first, the way it would in its own tab. Hidden under another
 * tab, the frame's entries would eat the swipe, so the bridge in the frame reports each traversal
 * (PhonePreview hears it), and one that moved a hidden frame is read as the back it was. The
 * walks this module asks for go one step at a time, and each is answered before the next: by
 * the top's popstate when the step was the shell's, or by the frame's report when it was the
 * frame's and the shell stands where it stood. A frame without the bridge answers nothing, and
 * its step costs the next swipe, as it did before.
 */

const KEY = "toyonDepth";
/** marks the entry a box stands on, so forward into one is not read as forward into a screen */
const OVER = "toyonOver";
/** the depth of the floor: the entry under the list, which no screen stands on */
const FLOOR = -1;

/** How many screens deep the phone is, or null while that is not the phone's to say: on the desk,
 * whose back belongs to the browser, and before the daemon's first hello, when the remembered row
 * is not listed yet and the depth would read as the list for a moment. */
export function depthOf(s: State): number | null {
  if (s.frame !== "phone" || !s.heard) return null;
  // the same test PhoneFrame draws by: a row that went while its screen was open is the list, and
  // a row toyon does not own has a page of its own, as an archived one has
  const onWorktree = s.screen !== "home" && (rowById(s, s.activeId) !== null || archivedPageOf(s) !== null);
  if (!onWorktree) return 0;
  // the tab PhoneFrame draws: a preview the row has none of is its chat
  const previewed = worktreeById(s, s.activeId) !== null && !isChatCentred(s) && archivedPageOf(s) === null;
  const offChat = s.screen === "changes" || (s.screen === "preview" && previewed);
  return 1 + (offChat ? 1 : 0) + (s.editor ? 1 : 0);
}

export interface HistoryHost {
  readonly history: Pick<History, "state" | "pushState" | "replaceState" | "go">;
  addEventListener(type: "popstate", fn: (e: PopStateEvent) => void): void;
  removeEventListener(type: "popstate", fn: (e: PopStateEvent) => void): void;
}

/** a history traversal that moved the preview's frame, as its bridge reported it */
export interface FrameWalk {
  /** which way, where the frame's Navigation API could say; null for a page the traversal loaded */
  dir: "back" | "forward" | null;
}

export interface FrameWalks {
  watch(fn: (walk: FrameWalk) => void): () => void;
}

/** The preview frame's traversals, told by whoever owns the frame (PhonePreview) and heard by the
 * history installed beside the store. */
export const frameWalks = (() => {
  const watchers = new Set<(walk: FrameWalk) => void>();
  return {
    watch(fn: (walk: FrameWalk) => void): () => void {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    tell(walk: FrameWalk) {
      for (const fn of watchers) fn(walk);
    },
  };
})();

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
  frame: FrameWalks = frameWalks,
): () => void {
  const h = host.history;
  // the depth of the entry the browser is on. A page that opens on an entry of its own (a reload
  // keeps the entry and its mark, and the floor under it) knows where it stands; a fresh one is
  // standing on the floor, and lays the list over it the first time the phone has a depth to say,
  // with a remembered worktree on top of that, so the first swipe lands on the list. The desk
  // lays nothing: its back is the browser's.
  let at = depthIn(h.state) ?? FLOOR;
  let floored = depthIn(h.state) !== null;

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

  // a step down this module asked for, not yet answered. A go is not settled when it returns, and
  // which of the shell and the frame it moves is only known from the answer, so nothing else is
  // laid or walked until it comes
  let walking = false;

  const sync = () => {
    const screens = depthOf(store.getState());
    if (screens === null || walking) return;
    if (!floored) {
      h.replaceState({ [KEY]: FLOOR }, "");
      floored = true;
    }
    const want = screens + (topBox() ? 1 : 0);
    if (want === at) return;
    if (want > at) {
      for (let d = at + 1; d <= want; d++) h.pushState({ [KEY]: d, [OVER]: d > screens }, "");
      at = want;
    } else {
      // one step, and `at` holds until the answer says which of the shell and the frame it moved
      h.go(-1);
      walking = true;
    }
  };

  // A box opening or closing is heard mid-commit, and one commit can do both: a menu row that
  // opens a picker, or a development build mounting everything twice. The count is read once,
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

  /** a back the browser spent on the entry below the screen, or on a hidden frame: the box on top
   * goes, or the screen drops to the level the step landed on */
  const stepDown = (s: State, screens: number, landed: number) => {
    const box = topBox();
    if (box) {
      // back with a box up closes that box alone; the sync that follows its going puts the entry
      // back while another is still open
      shutting = box;
      boxes.shut(box);
      return;
    }
    // the diff shuts onto the tab under it (a move to the tab already open does that), below
    // another tab is the chat, and below the chat is the list
    const to = landed === 0 ? "home" : s.editor && landed === screens - 1 ? s.screen : "chat";
    store.dispatch({ a: "screen", to });
  };

  const onPop = (e: PopStateEvent) => {
    const ours = walking;
    walking = false;
    at = depthIn(e.state) ?? FLOOR;
    const s = store.getState();
    const screens = depthOf(s);
    if (screens === null) return;
    if (at < 0) {
      // back from the list lands on the floor: the list's entry is laid over it again, in place
      // of whatever stood ahead, and the screen stays
      h.pushState({ [KEY]: 0 }, "");
      at = 0;
      sync();
      return;
    }
    if (ours) {
      // the step was the shell's own and the store already says where it was going: whatever is
      // still above or below is walked or laid from here
      sync();
      return;
    }
    const now = screens + (topBox() ? 1 : 0);
    if (now === at) return;
    if (now > at) stepDown(s, screens, at);
    else if (now === 0 && s.activeId && !isOver(e.state)) {
      // forward from the list into the row it came back from; a tab or a diff above its chat is
      // not remembered, and neither is a box, so the sync below walks the entry for any back down
      store.dispatch({ a: "screen", to: "chat" });
    }
    sync();
  };

  const onFrame = (walk: FrameWalk) => {
    if (walking) {
      // the step asked for was spent on the frame: the shell stands where it stood, and the way
      // down is still to walk
      walking = false;
      sync();
      return;
    }
    const s = store.getState();
    const screens = depthOf(s);
    if (screens === null || screens === 0) return;
    // on its own tab the app's history is the person's to walk, the way it is in a tab of its own
    const shown = s.screen === "preview" && !s.editor && screens === 2;
    if (shown || walk.dir === "forward") return;
    // a swipe spent on a frame nobody is looking at: the screen it was meant for drops a level, and
    // the sync that follows walks the shell's entry down to match
    stepDown(s, screens, screens + (topBox() ? 1 : 0) - 1);
  };

  host.addEventListener("popstate", onPop);
  const unsubscribe = store.subscribe(sync);
  const unwatch = boxes.watch(syncSoon);
  const unwatchFrame = frame.watch(onFrame);
  sync();
  return () => {
    host.removeEventListener("popstate", onPop);
    unsubscribe();
    unwatch();
    unwatchFrame();
  };
}
