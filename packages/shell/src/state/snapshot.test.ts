import { describe, expect, test } from "bun:test";
import { type HelloFull, MANAGED_NONE, PROTOCOL_VERSION, type WorktreeStatus } from "@toyon/shared";
import {
  CHAT_EVENTS_KEPT,
  CHATS_KEPT,
  ChatTail,
  evictions,
  NO_STAMPS,
  newestTs,
  recallable,
  recalledHello,
  snapshotOf,
  tailOf,
} from "./snapshot.ts";
import { memoryStore } from "./snapshotStore.ts";
import { initialState, reducer } from "./store.ts";

/** the store as a hello leaves it, which is what a snapshot is taken from */
const facts = (h: HelloFull) => reducer(initialState({ clientId: "me" }), { a: "server", msg: h });
const helloSnapshot = (h: HelloFull, at: number) => snapshotOf(facts(h), at);

// What the browser keeps of a machine, and what comes back: the hello less the heavy and the
// daemon's own, rows made still, a chat's tail counted in rows a reader sees.

const row = (
  id: string,
  agent: WorktreeStatus["agent"] = "idle",
  more: Partial<WorktreeStatus> = {},
): WorktreeStatus => ({
  id,
  repoId: "r",
  path: `/w/${id}`,
  name: id,
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
  agent,
  login: false,
  ...more,
});

const hello = (rows: WorktreeStatus[]): HelloFull => ({
  trunks: { r: { id: "m", dirty: 0, empty: false, shipping: { op: "pull" } as never } },
  t: "hello",
  stamps: NO_STAMPS,
  version: "0.17.0",
  machine: "box",
  install: "npm",
  registry: null,
  protocol: PROTOCOL_VERSION,
  repos: [],
  rows,
  themes: [{ id: "x" } as never],
  themePrefs: { mode: "dark", dark: "x", light: "x" } as never,
  agents: [],
  defaultAgent: "claude",
  agentChosen: true,
  home: "/home/t",
  folderDialog: false,
  keepAwake: null,
  remote: null,
  letIn: true,
  knocks: [{ id: "k" } as never],
  tailscale: null,
  machines: [{ origin: "https://work.tail1234.ts.net", token: "w" }],
  gitIdentity: true,
  pending: [{ id: "p" } as never],
  visits: {},
  self: { building: true } as never,
  update: { restarting: 1 } as never,
  drafts: { b: "typed" },
  attachments: { b: [] },
  managed: MANAGED_NONE,
});

describe("snapshotOf", () => {
  test("keeps the cheap fields and the paired machines, leaves out the heavy and the daemon's own", () => {
    const s = helloSnapshot(hello([row("a")]), 5);
    expect(s).not.toBeNull();
    expect(s?.at).toBe(5);
    expect(s?.machines).toEqual([{ origin: "https://work.tail1234.ts.net", token: "w" }]);
    expect(s?.install).toBe("npm");
    expect(s?.gitIdentity).toBe(true);
    for (const k of ["t", "themes", "drafts", "attachments", "knocks", "letIn", "self", "update", "pending"]) {
      expect(k in (s as object)).toBe(false);
    }
  });

  test("an empty machine is not a snapshot", () => {
    expect(helloSnapshot(hello([]), 5)).toBeNull();
  });

  test("a snapshot is recallable by the protocol it was written under", () => {
    expect(recallable({ protocol: PROTOCOL_VERSION })).toBe(true);
    expect(recallable({ protocol: PROTOCOL_VERSION - 1 })).toBe(false);
    expect(recallable(null)).toBe(false);
  });
});

describe("recalledHello", () => {
  test("is a hello with empties for what was left out, and rows that never claim to be live", () => {
    const s = helloSnapshot(
      hello([
        row("a", "working", {
          stopping: true,
          procs: [{ name: "web" } as never],
          shipping: { op: "land" } as never,
          queued: 2,
          syncQueued: true,
          login: true,
        }),
        row("b", "waiting"),
        row("c", "error"),
      ]),
      5,
    );
    const h = recalledHello(s!);
    expect(h.t).toBe("hello");
    expect(h.themes).toEqual([]);
    expect(h.drafts).toEqual({});
    expect(h.knocks).toEqual([]);
    expect(h.letIn).toBe(false);
    expect(h.self).toBeNull();
    expect(h.update).toBeNull();
    expect(h.pending).toEqual([]);
    expect(h.rows.map((w) => w.agent)).toEqual(["idle", "waiting", "error"]);
    expect(h.rows[0]?.procs).toEqual([]);
    for (const k of ["stopping", "shipping", "queued", "syncQueued"]) expect(k in (h.rows[0] as object)).toBe(false);
    expect(h.rows[0]?.login).toBe(false);
    expect("shipping" in (h.trunks.r as object)).toBe(false);
    expect("at" in (h as object)).toBe(false);
  });
});

describe("the chat tail", () => {
  const delta = (seq: number, text: string) => ({ seq, event: { type: "text-delta" as const, text } });

  test("tailOf keeps the last n", () => {
    expect(tailOf([1, 2, 3, 4], 2)).toEqual([3, 4]);
    expect(tailOf([1, 2], 5)).toEqual([1, 2]);
  });

  test("a streamed reply of many tokens counts as one row, and the seq cursor is the highest raw seq", () => {
    const tail = new ChatTail();
    tail.reset([{ seq: 0, event: { type: "turn-start", ts: 1 } }], 0, true);
    for (let i = 1; i <= 500; i++) tail.add(i, { type: "text-delta", text: "x" });
    const snap = tail.snapshot(undefined, 9);
    expect(snap.events).toHaveLength(2);
    expect(snap.events[1]?.event).toEqual({ type: "text-delta", text: "x".repeat(500) });
    expect(snap.events[1]?.seq).toBe(1);
    expect(snap.seq).toBe(500);
    expect(snap.protocol).toBe(PROTOCOL_VERSION);
    expect(snap.at).toBe(9);
    expect("draft" in snap).toBe(false);
  });

  test("the cap counts rows: more rows than kept drops the oldest", () => {
    const tail = new ChatTail();
    const rows = [];
    for (let i = 0; i < CHAT_EVENTS_KEPT + 10; i++)
      rows.push({ seq: i, event: { type: "turn-start" as const, ts: i } });
    tail.reset(rows, rows.length - 1, true);
    const snap = tail.snapshot("a draft", 1);
    expect(snap.events).toHaveLength(CHAT_EVENTS_KEPT);
    expect(snap.events[0]?.seq).toBe(10);
    expect(snap.draft).toBe("a draft");
  });

  test("a whole backfill replaces the tail; live frames and a tail past a since add to it", () => {
    const tail = new ChatTail();
    // the coalesced entries name a run by its first seq: the cursor is the frame's `last`
    tail.reset([delta(0, "a"), delta(1, "b")], 5, true);
    expect(tail.seq).toBe(5);
    expect(tail.since()).toBe(5);
    tail.add(7, { type: "text-delta", text: "c" });
    expect(tail.snapshot(undefined, 1).events).toEqual([{ seq: 0, event: { type: "text-delta", text: "abc" } }]);
    expect(tail.seq).toBe(7);
    tail.extend([delta(8, "d")], 9);
    expect(tail.snapshot(undefined, 1).events).toEqual([{ seq: 0, event: { type: "text-delta", text: "abcd" } }]);
    expect(tail.seq).toBe(9);
    tail.reset([delta(20, "z")], 20, true);
    expect(tail.snapshot(undefined, 1).events).toEqual([delta(20, "z")]);
    expect(tail.seq).toBe(20);
    // a recalled tail is the kept rows alone: the cursor is kept but not offered
    tail.reset([delta(20, "z")], 20, false);
    expect(tail.seq).toBe(20);
    expect(tail.since()).toBeUndefined();
  });
});

describe("evictions", () => {
  test("every chat with no row goes, then the oldest past the cap", () => {
    const chats: Record<string, { at: number }> = {};
    for (let i = 0; i < CHATS_KEPT + 3; i++) chats[`w${i}`] = { at: i };
    chats.gone = { at: 999 };
    const rows = Object.keys(chats)
      .filter((id) => id !== "gone")
      .map((id) => ({ id }));
    expect(evictions(chats, rows)).toEqual(["gone", "w2", "w1", "w0"]);
  });
});

describe("memoryStore", () => {
  test("keeps a hello and chats per origin, lists chats by id, and clears one origin alone", async () => {
    const s = memoryStore();
    const a = "https://a";
    const b = "https://a:4141";
    const snap = helloSnapshot(hello([row("w")]), 1)!;
    await s.putHello(a, snap);
    await s.putChat(a, "w", { protocol: 1, at: 1, events: [], seq: 0 });
    await s.putChat(b, "w", { protocol: 1, at: 2, events: [], seq: 0 });
    expect((await s.hello(a))?.at).toBe(1);
    expect(await s.hello(b)).toBeNull();
    expect(Object.keys(await s.chats(a))).toEqual(["w"]);
    expect((await s.chats(b)).w?.at).toBe(2);
    await s.dropChats(a, ["w"]);
    expect(await s.chats(a)).toEqual({});
    await s.clear(b);
    expect(await s.chats(b)).toEqual({});
    expect((await s.hello(a))?.at).toBe(1);
  });
});

describe("newestTs", () => {
  test("the newest stamp any event carries, or null", () => {
    expect(newestTs([])).toBeNull();
    expect(newestTs([{ seq: 0, event: { type: "text-delta", text: "x" } }])).toBeNull();
    expect(
      newestTs([
        { seq: 0, event: { type: "user-message", text: "a", ts: 5 } },
        { seq: 1, event: { type: "turn-start", ts: 9 } },
        { seq: 2, event: { type: "text-delta", text: "x" } },
      ]),
    ).toBe(9);
  });
});
