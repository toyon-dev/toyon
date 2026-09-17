import { describe, expect, test } from "bun:test";
import type { WorktreeStatus } from "@toyon/shared";
import type { Store } from "../state/context.tsx";
import { type Action, initialState, reducer, type State } from "../state/store.ts";
import { type HistoryHost, installPhoneHistory } from "./phoneHistory.ts";

const row = (id: string): WorktreeStatus =>
  ({
    id,
    repoId: "r",
    path: `/w/${id}`,
    name: id,
    branch: `toyon/${id}`,
    worktree: {
      id,
      repoId: "r",
      path: `/w/${id}`,
      branch: `toyon/${id}`,
      kind: "worktree",
      proxyPort: 1,
      title: id,
      createdAt: 0,
    },
    procs: [],
    agent: "idle",
    login: false,
  }) as unknown as WorktreeStatus;

const phone = (patch: Partial<State> = {}): State => ({
  ...initialState({ clientId: "t", frame: "phone" }),
  heard: true,
  rows: [row("a")],
  activeRepoId: "r",
  activeId: "a",
  ...patch,
});

function storeOf(initial: State) {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: State) => {
    if (next === state) return;
    state = next;
    for (const l of listeners) l();
  };
  const store: Store = {
    getState: () => state,
    dispatch: (a: Action) => set(reducer(state, a)),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { store, set };
}

/** a tab's history with the browser's shape: a list and an index, pushes cut what is ahead, and a
 * go lands later (here, when `settle` runs) with a popstate carrying the entry's state */
function tab(entries: unknown[] = [null]) {
  let index = entries.length - 1;
  const queued: number[] = [];
  let pop: ((e: PopStateEvent) => void) | null = null;
  const host: HistoryHost = {
    history: {
      get state() {
        return entries[index];
      },
      pushState(data: unknown) {
        entries.splice(index + 1, entries.length, data);
        index++;
      },
      replaceState(data: unknown) {
        entries[index] = data;
      },
      go(delta = 0) {
        queued.push(delta);
      },
    } as HistoryHost["history"],
    addEventListener: (_t, fn) => {
      pop = fn;
    },
    removeEventListener: () => {
      pop = null;
    },
  };
  const move = (delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= entries.length) return;
    index = to;
    pop?.({ state: entries[index] } as PopStateEvent);
  };
  const settle = () => {
    while (queued.length) move(queued.shift() ?? 0);
  };
  const depths = () => entries.map((e) => (e as { toyonDepth?: number } | null)?.toyonDepth ?? null);
  return { host, back: () => move(-1), forward: () => move(1), settle, depths, index: () => index };
}

describe("phone history", () => {
  test("opening a worktree stands it on an entry over the list, and back returns to the list", () => {
    const { store } = storeOf(phone());
    const t = tab();
    installPhoneHistory(store, t.host);
    expect(t.depths()).toEqual([0]);
    store.dispatch({ a: "screen", to: "chat" });
    expect(t.depths()).toEqual([0, 1]);
    t.back();
    expect(store.getState().screen).toBe("home");
    expect(t.index()).toBe(0);
  });

  test("a page that opens on a remembered worktree puts the list under it", () => {
    const { store } = storeOf(phone({ screen: "chat" }));
    const t = tab();
    installPhoneHistory(store, t.host);
    expect(t.depths()).toEqual([0, 1]);
    t.back();
    expect(store.getState().screen).toBe("home");
  });

  test("the tabs of one worktree add no entries", () => {
    const { store } = storeOf(phone());
    const t = tab();
    installPhoneHistory(store, t.host);
    store.dispatch({ a: "screen", to: "chat" });
    store.dispatch({ a: "screen", to: "changes" });
    store.dispatch({ a: "screen", to: "chat" });
    expect(t.depths()).toEqual([0, 1]);
  });

  test("back from a diff shuts it onto the tab it came from", () => {
    const { store, set } = storeOf(phone({ screen: "changes" }));
    const t = tab();
    installPhoneHistory(store, t.host);
    set({ ...store.getState(), editor: {} as State["editor"] });
    expect(t.depths()).toEqual([0, 1, 2]);
    t.back();
    expect(store.getState().editor).toBeNull();
    expect(store.getState().screen).toBe("changes");
    t.back();
    expect(store.getState().screen).toBe("home");
  });

  test("the bar's own back walks the history down, so the next swipe is not a dead one", () => {
    const { store } = storeOf(phone());
    const t = tab([null, null]);
    installPhoneHistory(store, t.host);
    store.dispatch({ a: "screen", to: "chat" });
    store.dispatch({ a: "screen", to: "home" });
    t.settle();
    expect(t.index()).toBe(1);
    expect(store.getState().screen).toBe("home");
    store.dispatch({ a: "screen", to: "chat" });
    expect(t.depths()).toEqual([null, 0, 1]);
  });

  test("forward from the list opens the worktree it came back from", () => {
    const { store } = storeOf(phone());
    const t = tab();
    installPhoneHistory(store, t.host);
    store.dispatch({ a: "screen", to: "chat" });
    t.back();
    t.forward();
    expect(store.getState().screen).toBe("chat");
  });

  test("the desk writes no entries", () => {
    const { store } = storeOf(phone({ frame: "desk" }));
    const t = tab();
    installPhoneHistory(store, t.host);
    store.dispatch({ a: "screen", to: "chat" });
    expect(t.depths()).toEqual([0]);
  });
});
