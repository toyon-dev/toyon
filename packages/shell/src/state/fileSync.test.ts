import { describe, expect, test } from "bun:test";
import { type ClientMsg, type FileServerMsg, PROTOCOL_VERSION, type ServerMsg } from "@toyon/shared";
import { openFile } from "./actions/file.ts";
import { createStore } from "./context.tsx";
import { decide, FileSync } from "./fileSync.ts";
import { initialState } from "./store.ts";

describe("what a fresh read means for the editor's text", () => {
  const base = { text: "a", version: "v1" };
  test("the version it came from asks nothing", () => {
    expect(decide(base, "typed", "typed", { after: "a", version: "v1" })).toBe("same");
  });
  test("a clean buffer takes the new text", () => {
    expect(decide(base, "a", null, { after: "b", version: "v2" })).toBe("apply");
  });
  test("text the editor already holds, or was saving, is adopted as the version", () => {
    expect(decide(base, "b", null, { after: "b", version: "v2" })).toBe("adopt");
    expect(decide(base, "bc", "b", { after: "b", version: "v2" })).toBe("adopt");
  });
  test("unsaved edits under a change are a conflict", () => {
    expect(decide(base, "mine", null, { after: "theirs", version: "v2" })).toBe("conflict");
    expect(decide(base, "a", "mine", { after: "theirs", version: "v2" })).toBe("conflict");
  });
  test("a file that went away closes a clean buffer and conflicts a dirty one", () => {
    expect(decide(base, "a", null, { after: "", version: null })).toBe("gone");
    expect(decide(base, "mine", null, { after: "", version: null })).toBe("conflict");
  });
});

function fakeTimers() {
  let id = 0;
  const due = new Map<number, () => void>();
  return {
    set: (fn: () => void) => {
      due.set(++id, fn);
      return id;
    },
    clear: (t: unknown) => {
      due.delete(t as number);
    },
    /** the pause is over: whatever was waiting on it runs */
    pass() {
      const fns = [...due.values()];
      due.clear();
      for (const fn of fns) fn();
    },
  };
}

function buffer(text: string) {
  const b = {
    value: text,
    text: () => b.value,
    replace: (t: string) => {
      b.value = t;
    },
    normalize: (t: string) => t,
  };
  return b;
}

type Written = { ok: true; version: string } | { ok: false; reason: "changed" | "refused"; version: string | null };

/** the window's events, as fileSync listens for them */
function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type: string, fn: unknown) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn as () => void);
    },
    removeEventListener: (type: string, fn: unknown) => {
      listeners.get(type)?.delete(fn as () => void);
    },
    fire: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

function harness() {
  const initial = initialState({ clientId: "t" });
  const store = createStore(initial);
  const sent: ClientMsg[] = [];
  const timers = fakeTimers();
  const win = fakeWindow();
  const sync = new FileSync({ store, send: (m) => sent.push(m), timers, win: win as never });
  sync.start();
  const server = (msg: Exclude<ServerMsg, FileServerMsg>) => store.dispatch({ a: "server", msg } as never);
  server({
    t: "hello",
    version: "0",
    protocol: PROTOCOL_VERSION,
    repos: [],
    rows: [],
    spares: [],
    themes: initial.themes,
    themePrefs: initial.themePrefs,
    agents: [],
    defaultAgent: "claude",
    agentChosen: true,
    home: "/h",
    folderDialog: false,
    remote: null,
    gitIdentity: true,
    pending: [],
    visits: {},
    self: null,
  });
  store.dispatch({ a: "connected", v: true });
  const last = <T extends ClientMsg["t"]>(t: T) => sent.findLast((m): m is Extract<ClientMsg, { t: T }> => m.t === t);
  return {
    store,
    sent,
    timers,
    win,
    sync,
    last,
    count: (t: ClientMsg["t"]) => sent.filter((m) => m.t === t).length,
    open: (path: string, more: { ref?: string } = {}) =>
      openFile({ sock: null, dispatch: store.dispatch }, { worktreeId: "a", path, ...more }),
    /** the daemon answers the read that is out */
    read: (over: Partial<Extract<FileServerMsg, { t: "file-read" }>> = {}) => {
      const q = last("read-file");
      if (!q) throw new Error("no read was sent");
      sync.receive({
        t: "file-read",
        worktreeId: q.worktreeId,
        path: q.path,
        ...(q.ref ? { ref: q.ref } : {}),
        seq: q.seq,
        before: "",
        after: "",
        version: "v1",
        writable: true,
        binary: false,
        tooLarge: false,
        ...over,
      });
    },
    /** the daemon answers the write that is out */
    written: (answer: Written) => {
      const q = last("write-file");
      if (!q) throw new Error("no write was sent");
      sync.receive({ t: "file-written", worktreeId: q.worktreeId, path: q.path, seq: q.seq, ...answer });
    },
    /** a git-status push: the worktree's files moved */
    tick: () => server({ t: "git-status", worktreeId: "a", files: [] }),
    attach: (path: string, text: string) => {
      const b = buffer(text);
      sync.bind({ worktreeId: "a", path }).attach(b);
      return b;
    },
    edit: (path: string, b: { value: string }, text: string) => {
      b.value = text;
      sync.bind({ worktreeId: "a", path }).edited();
    },
  };
}

describe("the open file and the disk", () => {
  test("an open reads once, and an answer for a file walked past fills nothing", () => {
    const h = harness();
    h.open("x.ts");
    const forX = h.last("read-file");
    h.open("y.ts");
    h.read({ after: "y" });
    // x's answer, landing last
    h.sync.receive({
      t: "file-read",
      worktreeId: "a",
      path: "x.ts",
      seq: forX?.seq ?? -1,
      before: "",
      after: "x",
      version: "v1",
      writable: true,
      binary: false,
      tooLarge: false,
    });
    expect(h.count("read-file")).toBe(2);
    expect(h.store.getState().editor).toMatchObject({ path: "y.ts", disk: { after: "y" } });
  });

  test("edits save once typing rests, one at a time, each over the version the last answer gave", () => {
    const h = harness();
    h.open("x.ts");
    h.read({ after: "a" });
    const b = h.attach("x.ts", "a");
    h.edit("x.ts", b, "ab");
    expect(h.count("write-file")).toBe(0);
    h.timers.pass();
    expect(h.last("write-file")).toMatchObject({ content: "ab", base: "v1" });
    h.edit("x.ts", b, "abc");
    h.timers.pass();
    expect(h.count("write-file")).toBe(1);
    h.written({ ok: true, version: "v2" });
    expect(h.last("write-file")).toMatchObject({ content: "abc", base: "v2" });
  });

  test("the page going saves an edit still inside the pause", () => {
    const h = harness();
    h.open("x.ts");
    h.read({ after: "a" });
    const b = h.attach("x.ts", "a");
    h.edit("x.ts", b, "ab");
    expect(h.count("write-file")).toBe(0);
    h.win.fire("pagehide");
    expect(h.last("write-file")).toMatchObject({ content: "ab", base: "v1" });
    // the timer went with the save: the pause ending sends nothing more
    h.timers.pass();
    expect(h.count("write-file")).toBe(1);
  });

  test("a read asked for while a save is out waits for the save's answer", () => {
    const h = harness();
    h.open("x.ts");
    h.read({ after: "a" });
    const b = h.attach("x.ts", "a");
    h.edit("x.ts", b, "ab");
    h.timers.pass();
    h.tick();
    expect(h.count("read-file")).toBe(1);
    h.written({ ok: true, version: "v2" });
    expect(h.count("read-file")).toBe(2);
    // the read finds the save: nothing to take, nothing to save
    h.read({ after: "ab", version: "v2" });
    expect(b.value).toBe("ab");
    expect(h.count("write-file")).toBe(1);
  });

  test("a clean buffer follows a change on disk", () => {
    const h = harness();
    h.open("x.ts");
    h.read({ after: "a" });
    const b = h.attach("x.ts", "a");
    h.tick();
    h.read({ after: "agent", version: "v2" });
    expect(b.value).toBe("agent");
    expect(h.store.getState().editor).toMatchObject({ disk: { after: "agent" }, conflict: null });
    // and the next edit saves over the version it now holds
    h.edit("x.ts", b, "agent!");
    h.timers.pass();
    expect(h.last("write-file")).toMatchObject({ base: "v2" });
  });

  test("a change on disk under unsaved edits is a conflict, and nothing saves until it is settled", () => {
    const h = harness();
    h.open("x.ts");
    h.read({ after: "a" });
    const b = h.attach("x.ts", "a");
    h.edit("x.ts", b, "mine");
    h.tick();
    h.read({ after: "theirs", version: "v2" });
    expect(h.store.getState().editor?.conflict).toEqual({ after: "theirs", version: "v2" });
    expect(b.value).toBe("mine");
    h.timers.pass();
    expect(h.count("write-file")).toBe(0);

    h.sync.reload({ worktreeId: "a", path: "x.ts" });
    expect(b.value).toBe("theirs");
    expect(h.store.getState().editor?.conflict).toBeNull();
    expect(h.count("write-file")).toBe(0);
  });

  test("keep mine saves the editor's text over what is on disk now", () => {
    const h = harness();
    h.open("x.ts");
    h.read({ after: "a" });
    const b = h.attach("x.ts", "a");
    h.edit("x.ts", b, "mine");
    h.tick();
    h.read({ after: "theirs", version: "v2" });
    h.sync.keepMine({ worktreeId: "a", path: "x.ts" });
    expect(h.last("write-file")).toMatchObject({ content: "mine", base: "v2" });
    expect(h.store.getState().editor?.conflict).toBeNull();
  });

  test("a save refused because the file moved reads it again and keeps the text", () => {
    const h = harness();
    h.open("x.ts");
    h.read({ after: "a" });
    const b = h.attach("x.ts", "a");
    h.edit("x.ts", b, "mine");
    h.timers.pass();
    h.written({ ok: false, reason: "changed", version: "v9" });
    expect(h.count("read-file")).toBe(2);
    h.read({ after: "agent", version: "v9" });
    expect(h.store.getState().editor?.conflict).toEqual({ after: "agent", version: "v9" });
    h.sync.keepMine({ worktreeId: "a", path: "x.ts" });
    expect(h.last("write-file")).toMatchObject({ content: "mine", base: "v9" });
  });

  test("a save lost to a dropped socket is sent again, unless it had landed", () => {
    const landed = harness();
    landed.open("x.ts");
    landed.read({ after: "a" });
    const b = landed.attach("x.ts", "a");
    landed.edit("x.ts", b, "mine");
    landed.timers.pass();
    landed.store.dispatch({ a: "connected", v: false });
    landed.store.dispatch({ a: "connected", v: true });
    expect(landed.count("read-file")).toBe(2);
    landed.read({ after: "mine", version: "v2" });
    expect(landed.count("write-file")).toBe(1);
    expect(landed.store.getState().editor?.conflict).toBeNull();

    const lost = harness();
    lost.open("x.ts");
    lost.read({ after: "a" });
    const c = lost.attach("x.ts", "a");
    lost.edit("x.ts", c, "mine");
    lost.timers.pass();
    lost.store.dispatch({ a: "connected", v: false });
    // nothing goes out while the socket is down, however long the pause
    lost.edit("x.ts", c, "mine!");
    lost.timers.pass();
    expect(lost.count("write-file")).toBe(1);
    lost.store.dispatch({ a: "connected", v: true });
    lost.read({ after: "a", version: "v1" });
    expect(lost.last("write-file")).toMatchObject({ content: "mine!", base: "v1" });
    expect(lost.count("write-file")).toBe(2);
  });

  test("a commit's copy never looks again, and a file that is not writable never saves", () => {
    const h = harness();
    h.open("x.ts", { ref: "abc1234" });
    h.read({ after: "old", version: null, writable: false });
    h.tick();
    expect(h.count("read-file")).toBe(1);

    h.open("big.txt");
    h.read({ after: "", tooLarge: true, writable: false });
    const b = h.attach("big.txt", "");
    h.edit("big.txt", b, "typed");
    h.timers.pass();
    h.sync.bind({ worktreeId: "a", path: "big.txt" }).saveNow();
    expect(h.count("write-file")).toBe(0);
  });

  test("a refused save says why and stops saving", () => {
    const h = harness();
    h.open("x.ts");
    h.read({ after: "a" });
    const b = h.attach("x.ts", "a");
    h.edit("x.ts", b, "ab");
    h.timers.pass();
    h.sync.receive({
      t: "file-written",
      worktreeId: "a",
      path: "x.ts",
      seq: h.last("write-file")?.seq ?? -1,
      ok: false,
      reason: "refused",
      version: null,
      message: "take it over to edit files here",
    });
    expect(h.store.getState().editor?.refused).toBe("take it over to edit files here");
    h.edit("x.ts", b, "abc");
    h.timers.pass();
    expect(h.count("write-file")).toBe(1);
  });

  test("a clean buffer on a file that went away closes the pane", () => {
    const h = harness();
    h.open("x.ts");
    h.read({ after: "a" });
    h.attach("x.ts", "a");
    h.tick();
    h.read({ after: "", version: null });
    expect(h.store.getState().editor).toBeNull();
  });

  test("an edit the pane closed on is saved, and comes back if the file had changed under it", () => {
    const h = harness();
    h.open("x.ts");
    h.read({ after: "a" });
    const b = h.attach("x.ts", "a");
    h.edit("x.ts", b, "mine");
    h.store.dispatch({ a: "close-editor" });
    // the editor unmounts and lets go: the edit still inside the pause goes out now
    h.sync.bind({ worktreeId: "a", path: "x.ts" }).attach(null);
    expect(h.last("write-file")).toMatchObject({ content: "mine", base: "v1" });
    h.written({ ok: false, reason: "changed", version: "v9" });
    h.read({ after: "agent", version: "v9" });
    // nothing is said while no pane is open on it: the conflict waits on the file

    h.open("x.ts");
    h.read({ after: "agent", version: "v9" });
    expect(h.store.getState().editor?.conflict).toEqual({ after: "agent", version: "v9" });
    const again = h.attach("x.ts", "agent");
    expect(again.value).toBe("mine");
  });
});
