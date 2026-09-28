import { describe, expect, test } from "bun:test";
import { looseSync, NO_SYNC, type WritableHandle } from "./looseSync.ts";

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
    pending: () => due.size,
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

/** a handle as Chromium hands one over: read granted, write behind one prompt */
function fakeHandle(answer: PermissionState = "granted") {
  const h = {
    kind: "file" as const,
    name: "notes.md",
    queried: 0,
    asked: 0,
    written: [] as string[],
    failWrite: false,
    queryPermission: async () => {
      h.queried++;
      return "prompt" as PermissionState;
    },
    requestPermission: async () => {
      h.asked++;
      return answer;
    },
    createWritable: async () => {
      if (h.failWrite) throw new Error("the browser would not");
      let held = "";
      return {
        write: async (t: string) => {
          held += t;
        },
        close: async () => {
          h.written.push(held);
        },
      };
    },
  };
  return h;
}

/** the awaits inside a save, all the way through */
async function settle() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
}

function harness(answer: PermissionState = "granted") {
  const handle = fakeHandle(answer);
  const timers = fakeTimers();
  const refused: string[] = [];
  const sync = looseSync(
    { kind: "handle", handle: handle as unknown as WritableHandle },
    "notes.md",
    (why) => refused.push(why),
    { timers, win: null },
  );
  const b = buffer("a");
  sync.attach(b);
  return { handle, timers, refused, sync, b };
}

describe("a loose file's save", () => {
  test("bytes alone save nowhere", () => {
    expect(looseSync({ kind: "bytes" }, "notes.md", () => {})).toBe(NO_SYNC);
  });

  test("the one prompt comes with the first keystroke; the text follows once typing rests", async () => {
    const { handle, timers, refused, sync, b } = harness();
    sync.edited();
    b.value = "ab";
    sync.edited();
    await settle();
    expect([handle.queried, handle.asked, handle.written]).toEqual([1, 1, []]);
    timers.pass();
    await settle();
    expect(handle.written).toEqual(["ab"]);
    // the answer is kept: a later save asks nothing
    b.value = "abc";
    sync.saveNow();
    await settle();
    expect([handle.asked, handle.written]).toEqual([1, ["ab", "abc"]]);
    expect(refused).toEqual([]);
  });

  test("a refused prompt locks the file, and nothing is written", async () => {
    const { handle, timers, refused, sync } = harness("denied");
    sync.edited();
    await settle();
    expect(refused).toEqual(["read-only: the browser would not save notes.md"]);
    // the rest timer was cancelled with the refusal; a save asked for by hand goes nowhere either
    expect(timers.pending()).toBe(0);
    sync.saveNow();
    await settle();
    expect(handle.written).toEqual([]);
  });

  test("a write that fails locks the file once", async () => {
    const { handle, timers, refused, sync } = harness();
    handle.failWrite = true;
    sync.edited();
    timers.pass();
    await settle();
    expect(refused).toHaveLength(1);
    sync.saveNow();
    await settle();
    expect(refused).toHaveLength(1);
  });

  test("letting go of the buffer inside the pause saves what it held", async () => {
    const { handle, sync, b } = harness();
    sync.edited();
    b.value = "typed";
    sync.attach(null);
    await settle();
    expect(handle.written).toEqual(["typed"]);
  });
});
