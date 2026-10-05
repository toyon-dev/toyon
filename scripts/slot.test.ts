import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeSlot } from "./slot.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toyon-slot-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("admits up to the cap and makes the next wait for a release", async () => {
  const first = await takeSlot({ dir, max: 2 });
  const second = await takeSlot({ dir, max: 2 });
  let waited = 0;
  let admitted = false;
  const third = takeSlot({ dir, max: 2, pollMs: 5, onWait: () => waited++ }).then((release) => {
    admitted = true;
    return release;
  });
  await Bun.sleep(30);
  expect(admitted).toBe(false);
  expect(waited).toBe(1);

  first();
  (await third)();
  second();
  expect(readdirSync(dir)).toEqual([]);
});

test("takes a slot whose holder stopped touching it", async () => {
  await takeSlot({ dir, max: 1 });
  // the holder was killed: nothing touches the file again
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "slot-0"), old, old);
  const release = await takeSlot({ dir, max: 1, staleMs: 30_000, pollMs: 5 });
  release();
});

test("a held slot stays fresh past the stale age", async () => {
  const release = await takeSlot({ dir, max: 1, staleMs: 50 });
  let admitted = false;
  const next = takeSlot({ dir, max: 1, staleMs: 50, pollMs: 5 }).then((r) => {
    admitted = true;
    return r;
  });
  await Bun.sleep(150);
  expect(admitted).toBe(false);
  release();
  (await next)();
});
