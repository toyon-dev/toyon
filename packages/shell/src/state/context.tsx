// A small external store around the reducer, exposed through React context with selector hooks.
// `useStore(selector)` re-renders a component only when its selected value changes, which is what
// lets a streamed log line touch the log view and nothing else. Selectors must return stable
// values for unchanged state: pick fields or use the EMPTY_* constants, never build a fresh object.

import type { DarkNow } from "@toyon/shared";
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { DaemonSocket } from "../ws.ts";
import type { FileSync } from "./fileSync.ts";
import { type Action, reducer, type State } from "./store.ts";

export interface Store {
  getState(): State;
  dispatch(action: Action): void;
  subscribe(listener: () => void): () => void;
}

export function createStore(initial: State): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reducer(state, action);
      if (next === state) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const StoreContext = createContext<Store | null>(null);
const SockContext = createContext<DaemonSocket | null>(null);
const FilesContext = createContext<FileSync | null>(null);

export function StoreProvider({
  store,
  sock,
  files,
  children,
}: {
  store: Store;
  sock: DaemonSocket | null;
  files: FileSync | null;
  children: ReactNode;
}) {
  return (
    <StoreContext.Provider value={store}>
      <SockContext.Provider value={sock}>
        <FilesContext.Provider value={files}>{children}</FilesContext.Provider>
      </SockContext.Provider>
    </StoreContext.Provider>
  );
}

export function useStoreInstance(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore outside <StoreProvider>");
  return store;
}

export function useStore<T>(selector: (s: State) => T): T {
  const store = useStoreInstance();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

/** what the following appearance modes follow. Two selections rather than one, because a selector
 * returning `{system, daylight}` would be a new object on every read and never settle. */
export function useDarkNow(): DarkNow {
  const system = useStore((s) => s.systemDark);
  const daylight = useStore((s) => s.daylight?.dark);
  return { system, daylight: daylight ?? system };
}

export function useDispatch(): Store["dispatch"] {
  return useStoreInstance().dispatch;
}

/** the daemon socket (null only in tests without a connection) */
export function useSock(): DaemonSocket | null {
  return useContext(SockContext);
}

/** what keeps the open file in step with the disk (null only in tests without a daemon) */
export function useFileSync(): FileSync | null {
  return useContext(FilesContext);
}
