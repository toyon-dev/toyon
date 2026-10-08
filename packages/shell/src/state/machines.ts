// The machines this page lists: the one that served it, and every other that machine's daemon
// holds (hello's `machines`, kept there so a pairing is done once per machine and every browser
// it serves lists the same). One is active and rendered; the others stay connected so their rows
// can say what they need, except an edge machine (Fly), which runs for as long as a connection is
// open and so is held only while looked at. With one machine listed nothing here shows: the page
// is exactly what it was before it could list more.

import type { PairedMachine, RepoInfo } from "@toyon/shared";
import type { Machine, MachineInit } from "./machine.ts";
import type { Action } from "./store.ts";

/** another machine as a list on this machine's screen names it: what it is called here and the
 * projects its daemon lists (the project picker's sections, the palette's switch rows) */
export interface OtherMachine {
  origin: string;
  name: string;
  repos: RepoInfo[];
}

export interface MachinesInit {
  serving: PairedMachine;
  build: (init: MachineInit) => Machine;
}

export interface Machines {
  /** every machine, the serving one first, then the others in the order they were added */
  list(): Machine[];
  active(): Machine;
  /** the machine that served this page: whose daemon keeps the list, and the way back */
  serving(): Machine;
  /** the one by origin, or null */
  get(origin: string): Machine | null;
  /** what a machine is called on screen: its name, with its address after it when another
   * machine answers to the same name (two daemons on one box both say the box's name) */
  displayName(origin: string): string;
  activate(origin: string): void;
  /** list a machine just let in; one already listed takes the new token */
  add(paired: PairedMachine): Machine;
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
  const all = () => listed;

  const api: Machines = {
    list: all,
    active: () => active,
    serving: () => serving,
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
    add(paired) {
      const known = others.find((m) => m.origin === paired.origin);
      if (paired.origin === serving.origin) return serving;
      if (known) {
        if (known.token === paired.token) return known;
        // a new token for a known machine (it was let in again): the old socket is replaced
        watches.get(known.origin)?.();
        known.dispose();
        others.splice(others.indexOf(known), 1);
        if (active === known) active = serving;
      }
      const m = init.build({ ...paired, serving: false });
      others.push(m);
      watch(m);
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
  // the other machines are the serving daemon's list: what its hello and `machines` frames name
  // is listed, and what they drop goes
  const sync = (list: PairedMachine[]) => {
    for (const m of list) api.add(m);
    for (const m of [...others]) if (!list.some((l) => l.origin === m.origin)) api.remove(m.origin);
  };
  let handed = serving.store.getState().handed;
  serving.store.subscribe(() => {
    const now = serving.store.getState().handed;
    if (now === handed) return;
    handed = now;
    sync(handed);
  });
  sync(handed);
  return api;
}
