import { describe, expect, test } from "bun:test";
import { type HelloFull, MANAGED_NONE, PROTOCOL_VERSION, type ServerMsg, type WorktreeStatus } from "@toyon/shared";
import { createStore } from "./context.tsx";
import { keepSnapshots } from "./recall.ts";
import { NO_STAMPS } from "./snapshot.ts";
import { memoryStore } from "./snapshotStore.ts";
import { initialState } from "./store.ts";

// The keeper over a Map and fake timers: what a hello and a chat's frames leave behind, how long
// after, and what a new page reads back.

const ORIGIN = "https://home.tail1234.ts.net";

const row = (id: string): WorktreeStatus => ({
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
  agent: "idle",
  login: false,
});

const hello = (...rows: WorktreeStatus[]): HelloFull => ({
  t: "hello",
  stamps: NO_STAMPS,
  version: "0",
  machine: "home",
  install: "npm",
  registry: null,
  protocol: PROTOCOL_VERSION,
  repos: [],
  rows,
  trunks: {},
  themes: [],
  themePrefs: { mode: "dark", dark: "x", light: "x" },
  agents: [],
  defaultAgent: "claude",
  agentChosen: true,
  home: "/h",
  folderDialog: false,
  keepAwake: null,
  remote: null,
  letIn: false,
  knocks: [],
  tailscale: null,
  machines: [],
  gitIdentity: true,
  pending: [],
  visits: {},
  self: null,
  update: null,
  globalInstall: null,
  drafts: {},
  attachments: {},
  managed: MANAGED_NONE,
});

/** timers that fire when told, in order */
function fakeTimers() {
  const due: { id: number; fn: () => void }[] = [];
  let n = 0;
  return {
    timers: {
      set: (fn: () => void, _ms: number) => {
        const id = ++n;
        due.push({ id, fn });
        return id;
      },
      clear: (id: unknown) => {
        const at = due.findIndex((d) => d.id === id);
        if (at >= 0) due.splice(at, 1);
      },
    },
    fire() {
      for (const d of due.splice(0)) d.fn();
    },
    pending: () => due.length,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(store = memoryStore()) {
  const s = createStore(initialState({ clientId: "me" }));
  const t = fakeTimers();
  const listeners: Record<string, () => void> = {};
  const doc = { visibilityState: "visible" };
  const win = {
    addEventListener: (k: string, fn: () => void) => {
      listeners[k] = fn;
    },
    removeEventListener: (k: string) => {
      delete listeners[k];
    },
    document: doc,
  } as never;
  const keeper = keepSnapshots(s, store, ORIGIN, { timers: t.timers, win, now: () => 1000 });
  return { s, store, keeper, ...t, listeners, doc };
}

describe("keeping the last-known machine", () => {
  test("a hello is written once the frames go quiet, and chats with no row go with it", async () => {
    const store = memoryStore();
    await store.putChat(ORIGIN, "gone", { protocol: PROTOCOL_VERSION, at: 1, events: [], seq: 0 });
    const { s, keeper, fire, pending } = setup(store);
    await keeper.recalled;
    s.dispatch({ a: "server", msg: hello(row("a")) });
    expect(pending()).toBe(1);
    expect(await store.hello(ORIGIN)).toBeNull();
    fire();
    await settle();
    const kept = await store.hello(ORIGIN);
    expect(kept?.rows.map((w) => w.id)).toEqual(["a"]);
    expect(kept?.at).toBe(1000);
    expect(await store.chats(ORIGIN)).toEqual({});
  });

  test("an empty machine leaves nothing", async () => {
    const { s, store, keeper, fire } = setup();
    await keeper.recalled;
    s.dispatch({ a: "server", msg: hello() });
    fire();
    await settle();
    expect(await store.hello(ORIGIN)).toBeNull();
  });

  test("a chat's backfill and its live frames become one tail, written with its draft", async () => {
    const { s, store, keeper, fire } = setup();
    await keeper.recalled;
    s.dispatch({ a: "server", msg: hello(row("a")) });
    keeper.hear({
      t: "backfill",
      worktreeId: "a",
      events: [{ seq: 0, event: { type: "turn-start", ts: 1 } }],
      last: 0,
    });
    keeper.hear({ t: "agent", worktreeId: "a", seq: 1, event: { type: "text-delta", text: "he" } });
    keeper.hear({ t: "agent", worktreeId: "a", seq: 2, event: { type: "text-delta", text: "llo" } });
    s.dispatch({ a: "set-draft", id: "a", text: "typed" });
    fire();
    await settle();
    const chats = await store.chats(ORIGIN);
    expect(chats.a?.events).toEqual([
      { seq: 0, event: { type: "turn-start", ts: 1 } },
      { seq: 1, event: { type: "text-delta", text: "hello" } },
    ]);
    expect(chats.a?.seq).toBe(2);
    expect(chats.a?.at).toBe(1000);
  });

  test("what the page holds of a chat is the subscribe's since, and a tail past it is added", async () => {
    const { s, store, keeper, fire } = setup();
    await keeper.recalled;
    s.dispatch({ a: "server", msg: hello(row("a")) });
    expect(keeper.since("a")).toBeUndefined();
    // the frames reach the store through the keeper, as the machine wires them
    const hear = (msg: ServerMsg) => s.dispatch({ a: "server", msg: keeper.hear(msg) as never });
    hear({
      t: "backfill",
      worktreeId: "a",
      events: [{ seq: 0, event: { type: "user-message", text: "q", ts: 1 } }],
      last: 4,
    });
    // the frame's last, not the coalesced entries' first seq
    expect(keeper.since("a")).toBe(4);
    const tail = {
      t: "backfill" as const,
      worktreeId: "a",
      events: [{ seq: 5, event: { type: "text-delta" as const, text: "hi" } }],
      after: 4,
      last: 6,
    };
    expect(keeper.hear(tail)).toBe(tail);
    expect(keeper.since("a")).toBe(6);
    // a tail past a since this page did not send (its cursor moved on) is taken as the daemon's
    // word on the chat, handed to the store without its after, and not offered as a cursor again
    const stray: ServerMsg = {
      t: "backfill" as const,
      worktreeId: "a",
      events: [{ seq: 9, event: { type: "turn-start" as const, ts: 2 } }],
      after: 8,
      last: 9,
    };
    expect(keeper.hear(stray)).toEqual({
      t: "backfill",
      worktreeId: "a",
      events: [{ seq: 9, event: { type: "turn-start", ts: 2 } }],
      last: 9,
    });
    expect(keeper.since("a")).toBeUndefined();
    // the same for a tail the store has no chat to add to: the row was dropped and listed again
    // between the subscribe and the frame, and its chat went with it
    hear({
      t: "backfill",
      worktreeId: "a",
      events: [{ seq: 0, event: { type: "user-message", text: "q", ts: 1 } }],
      last: 9,
    });
    expect(keeper.since("a")).toBe(9);
    s.dispatch({ a: "server", msg: { t: "worktrees", ids: [], rows: [], trunks: {}, stamp: "w" } });
    s.dispatch({ a: "server", msg: { t: "worktrees", ids: ["a"], rows: [row("a")], trunks: {}, stamp: "w" } });
    const orphan: ServerMsg = { t: "backfill", worktreeId: "a", events: [], after: 9, last: 9 };
    expect(keeper.hear(orphan)).toEqual({ t: "backfill", worktreeId: "a", events: [], last: 9 });
    expect(keeper.since("a")).toBeUndefined();
    fire();
    await settle();
    expect((await store.chats(ORIGIN)).a?.events).toEqual([]);
  });

  test("the page going dark writes at once", async () => {
    const { s, store, keeper, listeners, doc, pending } = setup();
    await keeper.recalled;
    s.dispatch({ a: "server", msg: hello(row("a")) });
    expect(pending()).toBe(1);
    doc.visibilityState = "hidden";
    listeners.visibilitychange?.();
    await settle();
    expect(pending()).toBe(0);
    expect((await store.hello(ORIGIN))?.rows).toHaveLength(1);
  });

  test("a new page reads the machine back before any hello; a hello that came first wins", async () => {
    const store = memoryStore();
    const first = setup(store);
    await first.keeper.recalled;
    first.s.dispatch({ a: "server", msg: hello(row("a")) });
    first.keeper.hear({
      t: "backfill",
      worktreeId: "a",
      events: [{ seq: 0, event: { type: "turn-start", ts: 1 } }],
      last: 0,
    });
    first.fire();
    await settle();

    const next = setup(store);
    await next.keeper.recalled;
    expect(next.s.getState().recalledAt).toBe(1000);
    expect(next.s.getState().heard).toBe(false);
    expect(next.s.getState().rows.map((w) => w.id)).toEqual(["a"]);
    expect(next.s.getState().local.a?.chat).toHaveLength(0);

    const heardFirst = createStore(initialState({ clientId: "me" }));
    heardFirst.dispatch({ a: "server", msg: hello(row("z")) });
    const k = keepSnapshots(heardFirst, store, ORIGIN, { timers: fakeTimers().timers, win: null as never });
    await k.recalled;
    expect(heardFirst.getState().rows[0]?.id).toBe("z");
    expect(heardFirst.getState().recalledAt).toBeNull();
  });

  test("another protocol's snapshot is left where it is", async () => {
    const store = memoryStore();
    await store.putHello(ORIGIN, { ...hello(row("a")), protocol: PROTOCOL_VERSION - 1, at: 1 } as never);
    const { s, keeper } = setup(store);
    await keeper.recalled;
    expect(s.getState().recalledAt).toBeNull();
    expect(s.getState().rows).toEqual([]);
  });

  test("forgetting a machine takes everything kept of it", async () => {
    const { s, store, keeper, fire } = setup();
    await keeper.recalled;
    s.dispatch({ a: "server", msg: hello(row("a")) });
    keeper.hear({ t: "backfill", worktreeId: "a", events: [], last: -1 });
    fire();
    await settle();
    expect(await store.hello(ORIGIN)).not.toBeNull();
    keeper.forget();
    await settle();
    expect(await store.hello(ORIGIN)).toBeNull();
    expect(await store.chats(ORIGIN)).toEqual({});
  });

  test("a draft typed on a recalled page is written against the recalled chat", async () => {
    const store = memoryStore();
    const first = setup(store);
    await first.keeper.recalled;
    first.s.dispatch({ a: "server", msg: hello(row("a")) });
    first.keeper.hear({
      t: "backfill",
      worktreeId: "a",
      events: [{ seq: 0, event: { type: "turn-start", ts: 1 } }],
      last: 3,
    });
    first.fire();
    await settle();

    const next = setup(store);
    await next.keeper.recalled;
    expect(next.s.getState().heard).toBe(false);
    // the recalled chat is the kept tail alone: the first subscribe asks for the whole chat, and
    // only once that is heard does the cursor go out
    expect(next.keeper.since("a")).toBeUndefined();
    next.keeper.hear({
      t: "backfill",
      worktreeId: "a",
      events: [{ seq: 0, event: { type: "turn-start", ts: 1 } }],
      last: 3,
    });
    expect(next.keeper.since("a")).toBe(3);
    next.s.dispatch({ a: "set-draft", id: "a", text: "from the pocket" });
    expect(next.pending()).toBe(1);
    next.fire();
    await settle();
    expect((await store.chats(ORIGIN)).a?.draft).toBe("from the pocket");
    expect((await store.chats(ORIGIN)).a?.events).toEqual([{ seq: 0, event: { type: "turn-start", ts: 1 } }]);
  });

  test("a record this build cannot lay in is dropped, and the page still paints", async () => {
    const store = memoryStore();
    await store.putHello(ORIGIN, { ...hello(row("a")), protocol: PROTOCOL_VERSION, at: 1, rows: undefined } as never);
    const { s, keeper } = setup(store);
    await keeper.recalled;
    expect(s.getState().recalledAt).toBeNull();
    await settle();
    expect(await store.hello(ORIGIN)).toBeNull();
  });

  test("a database that never answers does not hold the paint", async () => {
    const never = { ...memoryStore(), hello: () => new Promise<null>(() => {}) };
    const s = createStore(initialState({ clientId: "me" }));
    const t = fakeTimers();
    const k = keepSnapshots(s, never, ORIGIN, { timers: t.timers, win: null as never });
    let done = false;
    k.recalled.then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    t.fire();
    await settle();
    expect(done).toBe(true);
  });

  test("eviction reads what this page knows of the chats, not the transcripts back", async () => {
    const store = memoryStore();
    let reads = 0;
    const counted = {
      ...store,
      chats: (o: string) => {
        reads++;
        return store.chats(o);
      },
    };
    const { s, keeper, fire } = setup(counted);
    await keeper.recalled;
    expect(reads).toBe(1);
    s.dispatch({ a: "server", msg: hello(row("a")) });
    fire();
    await settle();
    expect(reads).toBe(1);
  });
});
