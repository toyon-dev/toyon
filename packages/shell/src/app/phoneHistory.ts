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
 * so a swipe on the preview tab walks the app back first, the way it would in its own tab.
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

  // walks this module asked for whose popstate has not come yet
  let walks = 0;

  const sync = () => {
    const screens = depthOf(store.getState());
    if (screens === null) return;
    if (!floored) {
      h.replaceState({ [KEY]: FLOOR }, "");
      floored = true;
    }
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
      // below another tab is the chat, and below the chat is the list
      const to = at === 0 ? "home" : s.editor && at === screens - 1 ? s.screen : "chat";
      store.dispatch({ a: "screen", to });
    } else if (ours && walks > 0) {
      // the first of two walks down (a box that closed as the screen under it dropped a level)
      // lands above where the screen is, which is what forward looks like; the second is coming
      return;
    } else if (!ours && now === 0 && s.activeId && !isOver(e.state)) {
      // forward from the list into the row it came back from; a tab or a diff above its chat is
      // not remembered, and neither is a box, so the sync below walks the entry for any back down
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
