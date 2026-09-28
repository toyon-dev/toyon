import { expect, test } from "bun:test";
import { waitingFor, withSlot } from "./limiter.ts";

// The semaphore admits `max` holders of one key at once and the rest in call order; a failure
// frees its slot like a return, and keys never wait on each other.

/** a caller that holds the key until told to end */
function holder(key: string, max: number, ends: Array<() => void>) {
  return withSlot(key, max, () => new Promise<void>((end) => ends.push(end)));
}

test("no more than max run at once, and waiters are admitted in call order", async () => {
  const running: string[] = [];
  const ends = new Map<string, () => void>();
  const enter = (name: string) =>
    withSlot("/r", 2, async () => {
      running.push(name);
      await new Promise<void>((end) => ends.set(name, end));
      running.splice(running.indexOf(name), 1);
    });
  const a = enter("a");
  const b = enter("b");
  const c = enter("c");
  const d = enter("d");
  await Bun.sleep(1);
  expect(running).toEqual(["a", "b"]);
  expect(waitingFor("/r")).toBe(2);
  ends.get("b")?.();
  await Bun.sleep(1);
  expect(running).toEqual(["a", "c"]);
  ends.get("a")?.();
  await Bun.sleep(1);
  expect(running).toEqual(["c", "d"]);
  expect(waitingFor("/r")).toBe(0);
  ends.get("c")?.();
  ends.get("d")?.();
  await Promise.all([a, b, c, d]);
  expect(running).toEqual([]);
});

test("a rejection reaches its caller and frees the slot", async () => {
  await expect(withSlot("/r2", 1, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(await withSlot("/r2", 1, () => 42)).toBe(42);
});

test("a caller arriving as a slot frees queues behind the waiter already standing", async () => {
  const ends: Array<() => void> = [];
  const order: string[] = [];
  const first = holder("/r3", 1, ends);
  const second = withSlot("/r3", 1, () => order.push("second"));
  await Bun.sleep(1);
  // the holder is released and a third caller arrives before the hand-off has run
  ends[0]?.();
  const third = withSlot("/r3", 1, () => order.push("third"));
  await Promise.all([first, second, third]);
  expect(order).toEqual(["second", "third"]);
});

test("keys are independent", async () => {
  const order: string[] = [];
  const ends: Array<() => void> = [];
  const x = holder("/x", 1, ends);
  const y = withSlot("/y", 1, () => order.push("y"));
  await y;
  expect(order).toEqual(["y"]);
  ends[0]?.();
  await x;
});
