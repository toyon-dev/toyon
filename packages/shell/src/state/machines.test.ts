import { describe, expect, test } from "bun:test";
import type { Remote } from "@toyon/shared";
import { createStore } from "./context.tsx";
import type { Machine, MachineInit } from "./machine.ts";
import { createMachines, parseSavedMachines, type SavedMachine } from "./machines.ts";
import { initialState } from "./store.ts";

// The registry over fakes: which machine is active, which sockets are held, what is kept for
// the next load and what a forgotten machine leaves behind.

function fake(init: MachineInit, log: string[], remote: Remote | null = null): Machine {
  const store = createStore({ ...initialState({ clientId: "me" }), remote });
  const name = new URL(init.origin).hostname.split(".")[0] ?? init.origin;
  return {
    ...init,
    get name() {
      return store.getState().machine ?? name;
    },
    store,
    sock: {
      suspend: () => log.push(`suspend ${name}`),
      resume: () => log.push(`resume ${name}`),
      dispose: () => log.push(`dispose ${name}`),
    } as unknown as Machine["sock"],
    files: {} as Machine["files"],
    terminals: {} as Machine["terminals"],
    storage: { clear: () => log.push(`clear ${name}`) } as unknown as Machine["storage"],
    heard: { version: null, protocol: null },
    boot: () => {},
    dispose: () => log.push(`dispose ${name}`),
  };
}

const home: SavedMachine = { origin: "https://home.tail1234.ts.net", token: "h" };
const work: SavedMachine = { origin: "https://work.tail1234.ts.net", token: "w" };

function setup(saved: SavedMachine[] = [work]) {
  const log: string[] = [];
  const persisted: SavedMachine[][] = [];
  const machines = createMachines({
    serving: home,
    saved,
    build: (init) => fake(init, log),
    persist: (s) => persisted.push(s),
  });
  return { log, persisted, machines };
}

describe("machines", () => {
  test("the serving machine is first and active; the saved ones follow, the serving one never twice", () => {
    const { machines } = setup([work, home]);
    expect(machines.list().map((m) => m.origin)).toEqual([home.origin, work.origin]);
    expect(machines.active().origin).toBe(home.origin);
    expect(machines.list()[0]?.serving).toBe(true);
  });

  test("activate switches and tells subscribers; an unknown origin does nothing", () => {
    const { machines } = setup();
    let told = 0;
    machines.subscribe(() => told++);
    machines.activate(work.origin);
    expect(machines.active().origin).toBe(work.origin);
    expect(told).toBe(1);
    machines.activate("https://nowhere.example");
    expect(machines.active().origin).toBe(work.origin);
    expect(told).toBe(1);
  });

  test("add lists a machine and keeps the list; a known origin with a new token is replaced", () => {
    const { machines, persisted, log } = setup([]);
    machines.add(work);
    expect(machines.list().map((m) => m.origin)).toEqual([home.origin, work.origin]);
    expect(persisted.at(-1)).toEqual([work]);
    expect(machines.add(work)).toBe(machines.get(work.origin) as Machine);
    machines.add({ ...work, token: "w2" });
    expect(log).toContain("dispose work");
    expect(machines.get(work.origin)?.token).toBe("w2");
    expect(persisted.at(-1)).toEqual([{ ...work, token: "w2" }]);
  });

  test("remove disposes, clears what it remembered, falls back to the serving machine", () => {
    const { machines, log, persisted } = setup();
    machines.activate(work.origin);
    machines.remove(work.origin);
    expect(log).toContain("dispose work");
    expect(log).toContain("clear work");
    expect(machines.active().origin).toBe(home.origin);
    expect(machines.list().length).toBe(1);
    expect(persisted.at(-1)).toEqual([]);
    machines.remove(home.origin);
    expect(machines.list().length).toBe(1);
  });

  test("an edge machine holds its socket only while active; a tailnet one stays connected", () => {
    const log: string[] = [];
    const edge = { host: "work.fly.dev", previews: "https://work.fly.dev:{port}", front: "edge" as const };
    const machines = createMachines({
      serving: home,
      saved: [work, { origin: "https://box.tail1234.ts.net", token: "b" }],
      build: (init) => fake(init, log, init.origin === work.origin ? edge : null),
    });
    machines.activate(work.origin);
    machines.activate(home.origin);
    expect(log).toEqual(["resume work", "suspend work"]);
    machines.activate(work.origin);
    expect(log.at(-1)).toBe("resume work");
    expect(log.some((l) => l.includes("box"))).toBe(false);
  });

  test("broadcast reaches every store", () => {
    const { machines } = setup();
    machines.broadcast({ a: "system-dark", v: true });
    for (const m of machines.list()) expect(m.store.getState().systemDark).toBe(true);
  });

  test("displayName tells two machines of one name apart by their address", () => {
    const { machines } = setup([{ origin: "https://home.other.ts.net", token: "x" }]);
    expect(machines.displayName(home.origin)).toBe("home (home.tail1234.ts.net)");
    expect(machines.displayName("https://home.other.ts.net")).toBe("home (home.other.ts.net)");
    const { machines: lone } = setup();
    expect(lone.displayName(work.origin)).toBe("work");
  });
});

describe("parseSavedMachines", () => {
  test("keeps origin-token pairs and drops anything else", () => {
    expect(
      parseSavedMachines(JSON.stringify([work, { origin: "work", token: "x" }, { origin: home.origin }, 3])),
    ).toEqual([work]);
    expect(parseSavedMachines("nope")).toEqual([]);
    expect(parseSavedMachines(null)).toEqual([]);
  });
});
