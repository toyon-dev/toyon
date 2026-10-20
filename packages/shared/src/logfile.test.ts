import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_ROTATE_BYTES, openLog, previousLog } from "./logfile.ts";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toyon-log-"));
  path = join(dir, "daemon.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;

test("a missing log is made, owner-readable only, and appended to", () => {
  const fd = openLog(path);
  writeSync(fd, "one\n");
  closeSync(fd);
  expect(readFileSync(path, "utf8")).toBe("one\n");
  expect(mode(path)).toBe(0o600);
  const again = openLog(path);
  writeSync(again, "two\n");
  closeSync(again);
  expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
});

test("a log from before is tightened to the owner on the next open", () => {
  writeFileSync(path, "old\n");
  chmodSync(path, 0o644);
  closeSync(openLog(path));
  expect(mode(path)).toBe(0o600);
  expect(readFileSync(path, "utf8")).toBe("old\n");
});

test("a log over the cutoff is moved aside, replacing the generation before it", () => {
  writeFileSync(previousLog(path), "older\n");
  writeFileSync(path, "x".repeat(11));
  const fd = openLog(path, 10);
  writeSync(fd, "fresh\n");
  closeSync(fd);
  expect(readFileSync(path, "utf8")).toBe("fresh\n");
  expect(readFileSync(previousLog(path), "utf8")).toBe("x".repeat(11));
  // right at the cutoff it stays
  writeFileSync(path, "y".repeat(10));
  closeSync(openLog(path, 10));
  expect(readFileSync(path, "utf8")).toBe("y".repeat(10));
  expect(existsSync(previousLog(path))).toBe(true);
  expect(LOG_ROTATE_BYTES).toBe(10 * 1024 * 1024);
});
