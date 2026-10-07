// The machines this page lists: the one that served it, and every other it has paired with. One
// is active and rendered; the others stay connected so their rows can say what they need, except
// an edge machine (Fly), which runs for as long as a connection is open and so is held only while
// looked at. With one machine listed nothing here shows: the page is exactly what it was before
// it could list more.

import type { RepoInfo } from "@toyon/shared";
import type { Machine, MachineInit } from "./machine.ts";
import type { Action } from "./store.ts";

/** another machine as a list on this machine's screen names it: what it is called here and the
 * projects its daemon lists (the project picker's sections, the palette's switch rows) */
export interface OtherMachine {
  origin: string;
  name: string;
  repos: RepoInfo[];
}

/** what is kept of another machine between page loads: where it is and how to speak to it */
export interface SavedMachine {
  origin: string;
  token: string;
}

export interface MachinesInit {
  serving: SavedMachine;
  saved: SavedMachine[];
  build: (init: MachineInit) => Machine;
  /** the list to keep for the next load, the serving machine left out */
  persist?: (saved: SavedMachine[]) => void;
}

export interface Machines {
  /** every machine, the serving one first, then the others in the order they were added */
  list(): Machine[];
  active(): Machine;
  /** the one by origin, or null */
  get(origin: string): Machine | null;
  /** what a machine is called on screen: its name, with its address after it when another
   * machine answers to the same name (two daemons on one box both say the box's name) */
  displayName(origin: string): string;
  activate(origin: string): void;
  /** list a machine just paired with; one already listed takes the new token */
  add(saved: SavedMachine): Machine;
  /** forget a machine: its socket closes, what it remembered goes, and the serving machine is
   * looked at if it was the one on screen. The serving machine cannot be forgotten. */
  remove(origin: string): void;
  /** the same action to every store: the window's frame, the system's dark side */
  broadcast(action: Action): void;
  /** hear about the list or the active machine changing */
  subscribe(fn: () => void): () => void;
}

export function createMachines(init: MachinesInit): Machines {
  const listeners = new Set<() => void>();
  const serving = init.build({ ...init.serving, serving: true });
  const others: Machine[] = [];
  let active: Machine = serving;
  // the list as one array that changes only when the list does: React reads it as a snapshot
  // (useSyncExternalStore), and a fresh array on every read is a render that never settles
  let listed: Machine[] = [serving];
  const notify = () => {
    listed = [serving, ...others];
    for (const fn of listeners) fn();
  };
  /** each other machine's store watched for its front, which decides whether its socket is held */
  const watches = new Map<string, () => void>();

  /** an edge machine is connected only while it is the one on screen */
  const hold = (m: Machine) => {
    if (m.serving) return;
    const edge = m.store.getState().remote?.front === "edge";
    if (edge && m !== active) m.sock.suspend();
    else m.sock.resume();
  };
  const watch = (m: Machine) => {
    let front = m.store.getState().remote?.front;
    watches.set(
      m.origin,
      m.store.subscribe(() => {
        const now = m.store.getState().remote?.front;
        if (now === front) return;
        front = now;
        hold(m);
      }),
    );
  };
  const persist = () => init.persist?.(others.map((m) => ({ origin: m.origin, token: m.token })));

  for (const saved of init.saved) {
    if (saved.origin === serving.origin || others.some((m) => m.origin === saved.origin)) continue;
    const m = init.build({ ...saved, serving: false });
    others.push(m);
    watch(m);
  }
  listed = [serving, ...others];

  const all = () => listed;

  return {
    list: all,
    active: () => active,
    get: (origin) => all().find((m) => m.origin === origin) ?? null,
    displayName(origin) {
      const m = all().find((x) => x.origin === origin);
      if (!m) return origin;
      const twins = all().filter((x) => x.name === m.name);
      return twins.length > 1 ? `${m.name} (${new URL(m.origin).host})` : m.name;
    },
    activate(origin) {
      const next = all().find((m) => m.origin === origin);
      if (!next || next === active) return;
      const was = active;
      active = next;
      hold(was);
      hold(next);
      notify();
    },
    add(saved) {
      const known = others.find((m) => m.origin === saved.origin);
      if (saved.origin === serving.origin) return serving;
      if (known) {
        if (known.token === saved.token) return known;
        // a new token for a known machine (it was paired again): the old socket is replaced
        watches.get(known.origin)?.();
        known.dispose();
        others.splice(others.indexOf(known), 1);
        if (active === known) active = serving;
      }
      const m = init.build({ ...saved, serving: false });
      others.push(m);
      watch(m);
      persist();
      notify();
      return m;
    },
    remove(origin) {
      const m = others.find((x) => x.origin === origin);
      if (!m) return;
      watches.get(origin)?.();
      watches.delete(origin);
      m.dispose();
      m.storage.clear();
      others.splice(others.indexOf(m), 1);
      if (active === m) active = serving;
      persist();
      notify();
    },
    broadcast(action) {
      for (const m of all()) m.store.dispatch(action);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** the saved list as storage holds it; anything that is not a list of origin-token pairs is dropped */
export function parseSavedMachines(raw: string | null): SavedMachine[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is SavedMachine =>
        !!m &&
        typeof m === "object" &&
        typeof (m as SavedMachine).origin === "string" &&
        /^https?:\/\//.test((m as SavedMachine).origin) &&
        typeof (m as SavedMachine).token === "string" &&
        (m as SavedMachine).token !== "",
    );
  } catch {
    return [];
  }
}
