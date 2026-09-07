import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../../state/store.ts";
import { fmtBytes, nextImageNumber } from "./images.ts";

const ref = (n: number) => ({
  n,
  name: "a.png",
  mimeType: "image/png",
  bytes: 1,
  width: 1,
  height: 1,
  file: `${n}.png`,
});

describe("nextImageNumber", () => {
  test("continues the worktree session's count, so a chip shows the number the daemon will give", () => {
    expect(nextImageNumber([])).toBe(1);
    const chat: ChatItem[] = [
      { kind: "user", text: "a", images: [ref(1), ref(2)] },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "b" },
      { kind: "user", text: "c", images: [ref(3)] },
    ];
    expect(nextImageNumber(chat)).toBe(4);
  });
});

describe("fmtBytes", () => {
  test("KB below a megabyte, one-decimal MB above", () => {
    expect(fmtBytes(500)).toBe("1 KB");
    expect(fmtBytes(40 * 1024)).toBe("40 KB");
    expect(fmtBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });
});
