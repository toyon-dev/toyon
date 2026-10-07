// A small external store around the reducer, exposed through React context with selector hooks.
// `useStore(selector)` re-renders a component only when its selected value changes, which is what
// lets a streamed log line touch the log view and nothing else. Selectors must return stable
// values for unchanged state: pick fields or use the EMPTY_* constants, never build a fresh object.

import type { DarkNow, RepoInfo } from "@toyon/shared";
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { TerminalBus } from "../app/terminalBus.ts";
import { type DaemonSocket, type DaemonUrls, daemonUrls } from "../ws.ts";
import type { FileSync } from "./fileSync.ts";
import type { Machine } from "./machine.ts";
import type { Machines, OtherMachine } from "./machines.ts";
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

const MachinesContext = createContext<Machines | null>(null);
const MachineContext = createContext<Machine | null>(null);

/** Every machine the page lists, and the active one rendered: its store, socket and file sync
 * are what every `useStore` and `useSock` below it reads, so nothing under here knows there is
 * more than one. The subtree is keyed by the active machine, so a switch starts every ref clean:
 * the preview frames, the panes and the walks are one daemon's. */
export function MachinesProvider({ machines, children }: { machines: Machines; children: ReactNode }) {
  const active = useSyncExternalStore(machines.subscribe, machines.active);
  return (
    <MachinesContext.Provider value={machines}>
      <MachineContext.Provider value={active}>
        <StoreProvider store={active.store} sock={active.sock} files={active.files}>
          <Fragment key={active.origin}>{children}</Fragment>
        </StoreProvider>
      </MachineContext.Provider>
    </MachinesContext.Provider>
  );
}

/** the registry of machines, for what lists or switches them */
export function useMachines(): Machines {
  const m = useContext(MachinesContext);
  if (!m) throw new Error("useMachines outside <MachinesProvider>");
  return m;
}

/** the machine on screen */
export function useMachine(): Machine {
  const m = useContext(MachineContext);
  if (!m) throw new Error("useMachine outside <MachinesProvider>");
  return m;
}

/** the list of machines, re-read when one is added, forgotten or activated */
export function useMachineList(): Machine[] {
  const machines = useMachines();
  return useSyncExternalStore(machines.subscribe, machines.list);
}

/** a field of another machine's store, for a row about it on this machine's screen */
export function useMachineStore<T>(machine: Machine, selector: (s: State) => T): T {
  return useSyncExternalStore(machine.store.subscribe, () => selector(machine.store.getState()));
}

const sameItems = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Each other machine as the lists on this screen name it: what it is called here and the projects
 * its daemon lists, re-read when a machine is added, forgotten or looked at, when its hello names
 * it, or when its projects change. One subscription over every other machine's store, so the list
 * has no fixed length; the same array comes back while nothing in it moved, which is what lets
 * React settle on it. */
export function useOtherMachines(): OtherMachine[] {
  const machines = useMachines();
  const here = useMachine();
  const list = useMachineList();
  const others = useMemo(() => list.filter((m) => m !== here), [list, here]);
  const last = useRef<{ others: Machine[]; names: string[]; repos: RepoInfo[][]; value: OtherMachine[] } | null>(null);
  const subscribe = useCallback(
    (fn: () => void) => {
      const offs = others.map((m) => m.store.subscribe(fn));
      return () => {
        for (const off of offs) off();
      };
    },
    [others],
  );
  const read = useCallback(() => {
    const names = others.map((m) => machines.displayName(m.origin));
    const repos = others.map((m) => m.store.getState().repos);
    const c = last.current;
    if (c && c.others === others && sameItems(c.names, names) && sameItems(c.repos, repos)) return c.value;
    const value = others.map((m, i) => ({ origin: m.origin, name: names[i] ?? m.origin, repos: repos[i] ?? [] }));
    last.current = { others, names, repos, value };
    return value;
  }, [others, machines]);
  return useSyncExternalStore(subscribe, read);
}

/** the terminal frames of the machine on screen */
export function useTerminalBus(): TerminalBus {
  return useMachine().terminals;
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

/** where this store's daemon answers, for every fetch and every <img> about it. With no socket
 * (a test) the page's own origin with no token, which names nothing a test fetches. */
export function useUrls(): DaemonUrls {
  const sock = useContext(SockContext);
  return sock?.urls ?? daemonUrls(location.origin, "");
}

/** what keeps the open file in step with the disk (null only in tests without a daemon) */
export function useFileSync(): FileSync | null {
  return useContext(FilesContext);
}
