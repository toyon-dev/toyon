import { describe, expect, test } from "bun:test";
import { Counts, type RowCounts } from "./counts.ts";

/** a reader whose answers are handed in by the test, so what lands mid-read can be seen */
function gated(going = () => false) {
  const gates: Array<(v: RowCounts | null) => void> = [];
  const reads: string[] = [];
  const counts = new Counts({
    read: (id) => {
      reads.push(id);
      return new Promise((resolve) => gates.push(resolve));
    },
    going,
  });
  return { counts, reads, answer: (v: RowCounts | null) => gates.shift()?.(v) };
}

describe("badge counts", () => {
  test("a read is kept and stands within the floor; a second ask joins the read in flight", async () => {
    const { counts, reads, answer } = gated();
    const first = counts.refresh(["a"]);
    expect(counts.refresh(["a"])).not.toBeNull();
    expect(reads).toEqual(["a"]);
    answer({ dirty: 1 });
    expect(await first).toBe(true);
    expect(counts.get("a")).toEqual({ dirty: 1 });
    expect(counts.refresh(["a"])).toBeNull();
  });

  test("a stale mark during a read supersedes it: the answer from before the mark is never kept", async () => {
    const { counts, reads, answer } = gated();
    const read = counts.refresh(["a"]);
    // the op moved HEAD while git was counting the old one, and asks for the row again
    counts.stale("a");
    const again = counts.refresh(["a"]);
    answer({ dirty: 1 });
    await Bun.sleep(0);
    expect(counts.get("a")).toBeUndefined();
    expect(reads).toEqual(["a", "a"]);
    answer({ dirty: 2 });
    expect(await read).toBe(true);
    await again;
    expect(counts.get("a")).toEqual({ dirty: 2 });
  });

  test("every row marked stale at once supersedes every read in flight", async () => {
    const { counts, reads, answer } = gated();
    const read = counts.refresh(["a", "b"]);
    counts.stale();
    answer({ dirty: 1 });
    answer({ dirty: 1 });
    await Bun.sleep(0);
    expect(reads).toEqual(["a", "b", "a", "b"]);
    answer({ dirty: 0 });
    answer({ dirty: 0 });
    await read;
    expect(counts.get("a")).toEqual({ dirty: 0 });
    expect(counts.get("b")).toEqual({ dirty: 0 });
  });

  test("a failed read keeps the last numbers and the floor, and a fresh read says it could not", async () => {
    const { counts, answer } = gated();
    const ok = counts.refresh(["a"]);
    answer({ dirty: 1 });
    await ok;
    counts.stale("a");
    const bad = counts.refresh(["a"]);
    answer(null);
    expect(await bad).toBe(false);
    expect(counts.get("a")).toEqual({ dirty: 1 });
    expect(counts.refresh(["a"])).toBeNull();
    const fresh = counts.read("a");
    answer(null);
    expect(await fresh).toBeNull();
    const back = counts.read("a");
    answer({ dirty: 3 });
    expect(await back).toEqual({ dirty: 3 });
  });

  test("a row on its way out is not read, and an answer that lands after it starts going is dropped", async () => {
    let going = false;
    const { counts, reads, answer } = gated(() => going);
    const read = counts.refresh(["a"]);
    going = true;
    answer({ dirty: 9 });
    expect(await read).toBe(false);
    expect(counts.get("a")).toBeUndefined();
    expect(counts.refresh(["a"])).toBeNull();
    expect(reads).toEqual(["a"]);
  });
});
