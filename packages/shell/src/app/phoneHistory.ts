import type { Store } from "../state/context.tsx";
import { archivedPageOf, type State, worktreeById } from "../state/store.ts";

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
 * The store stays the truth. A way back the page draws (the bar's back arrow, a tab shutting the
 * diff) moves the state first, and the history is walked down after it to match, so the next swipe
 * goes where the screen says rather than to an entry for a screen already closed. That walk comes
 * back here as a popstate for the depth the state already has, and does nothing.
 *
 * The preview's own navigations are entries in the same history (a frame's history is the tab's),
 * so a swipe on the preview tab walks the app back first, the way it would in its own tab.
 */

const KEY = "toyonDepth";

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

/** Keeps the tab's history one entry per level the phone is on. Installed once beside the store,
 * the way the frame watch is; returns the uninstall. */
export function installPhoneHistory(store: Store, host: HistoryHost = window): () => void {
  const h = host.history;
  // the depth of the entry the browser is on. A page that opens on an entry of its own (a reload
  // keeps the entry and its mark) knows where it stands; a fresh one marks its entry as the list,
  // and a remembered worktree then goes on top of it, so the first swipe lands on the list
  let at = depthIn(h.state) ?? 0;
  if (depthIn(h.state) === null) h.replaceState({ [KEY]: 0 }, "");

  const sync = () => {
    const want = depthOf(store.getState());
    if (want === null || want === at) return;
    if (want > at) for (let d = at + 1; d <= want; d++) h.pushState({ [KEY]: d }, "");
    else h.go(want - at);
    at = want;
  };

  const onPop = (e: PopStateEvent) => {
    at = depthIn(e.state) ?? 0;
    const s = store.getState();
    const now = depthOf(s);
    if (now === null || now === at) return;
    if (now > at) {
      // back: the diff shuts onto the tab under it (a move to the tab already open does that),
      // and below a worktree is the list
      store.dispatch(at === 0 ? { a: "screen", to: "home" } : { a: "screen", to: s.screen });
    } else if (now === 0 && s.activeId) {
      // forward from the list into the row it came back from; a diff above that is not
      // remembered, so the sync below walks the entry for it back down
      store.dispatch({ a: "screen", to: "chat" });
    }
    sync();
  };

  host.addEventListener("popstate", onPop);
  const unsubscribe = store.subscribe(sync);
  sync();
  return () => {
    host.removeEventListener("popstate", onPop);
    unsubscribe();
  };
}
