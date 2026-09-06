import { expect, test } from "bun:test";
import { withRepoLock } from "./lock.ts";

// The lock is a per-repo promise chain: mutations of one repo's shared git state run one at a
// time, a failure does not poison the chain, and different repos never wait on each other.

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

test("same repo: strictly sequential, in call order", async () => {
  const order: string[] = [];
  const a = withRepoLock("/r", async () => {
    order.push("a-start");
    await tick();
    order.push("a-end");
  });
  const b = withRepoLock("/r", async () => {
    order.push("b-start");
    order.push("b-end");
  });
  await Promise.all([a, b]);
  expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
});

test("a rejection reaches its caller and the next holder still runs", async () => {
  await expect(withRepoLock("/r2", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(await withRepoLock("/r2", () => 42)).toBe(42);
});

test("different repos interleave", async () => {
  const order: string[] = [];
  const a = withRepoLock("/x", async () => {
    await tick();
    order.push("x");
  });
  const b = withRepoLock("/y", async () => {
    order.push("y");
  });
  await Promise.all([a, b]);
  expect(order).toEqual(["y", "x"]);
});
