import { describe, expect, test } from "bun:test";
import { pickProxyPort } from "./ports.ts";

const range = { from: 10001, to: 10008 };
const any = () => true;

describe("pickProxyPort", () => {
  test("with no fixed range, the port the worktree was made with", () => {
    expect(pickProxyPort(49948, null, new Set([49948]), () => false)).toBe(49948);
  });
  test("in a range, a worktree keeps its own port while it is free", () => {
    expect(pickProxyPort(10004, range, new Set([10001]), any)).toBe(10004);
  });
  test("a port from before the range was pinned moves into it", () => {
    expect(pickProxyPort(49948, range, new Set(), any)).toBe(10001);
    expect(pickProxyPort(49948, range, new Set([10001, 10002]), any)).toBe(10003);
  });
  test("a port a running copy holds, or something else has bound, is passed over", () => {
    expect(pickProxyPort(10001, range, new Set([10001]), any)).toBe(10002);
    expect(pickProxyPort(10001, range, new Set(), (p) => p !== 10001 && p !== 10002)).toBe(10003);
  });
  test("null when running copies hold every port", () => {
    const all = new Set([10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008]);
    expect(pickProxyPort(49948, range, all, any)).toBeNull();
  });
});
