import { describe, expect, test } from "bun:test";
import { LineSplitter } from "./lines.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("LineSplitter", () => {
  test("splits on newlines and drops blank lines", () => {
    const s = new LineSplitter();
    expect(s.feed("one\ntwo\n\n  \nthree\n")).toEqual(["one", "two", "three"]);
  });

  test("holds a partial line until its newline arrives", () => {
    const s = new LineSplitter();
    // the piped reader split every chunk on its own and shipped both halves as lines
    expect(s.feed("hel")).toEqual([]);
    expect(s.feed("lo wor")).toEqual([]);
    expect(s.feed("ld\n")).toEqual(["hello world"]);
  });

  test("keeps CRLF endings clean", () => {
    const s = new LineSplitter();
    expect(s.feed("ready in 312 ms\r\nlocal: http://x\r\n")).toEqual(["ready in 312 ms", "local: http://x"]);
  });

  test("collapses a progress bar to its last state", () => {
    const s = new LineSplitter();
    expect(s.feed("10%\r45%\r100%\n")).toEqual(["100%"]);
  });

  test("strips colour, erase-line and hyperlink sequences", () => {
    const s = new LineSplitter();
    const colour = `${ESC}[32mVITE${ESC}[0m ready`;
    const bar = `${ESC}[2K\rbuilding`;
    const link = `${ESC}]8;;http://localhost:5173${BEL}Local${ESC}]8;;${BEL}`;
    expect(s.feed(`${colour}\n${bar}\n${link}\n`)).toEqual(["VITE ready", "building", "Local"]);
  });

  test("flushes a line that never ends, so the buffer cannot grow without bound", () => {
    const s = new LineSplitter();
    const out = s.feed("x".repeat(70 * 1024));
    expect(out).toHaveLength(1);
    expect(out[0]?.length).toBe(70 * 1024);
    expect(s.feed("rest\n")).toEqual(["rest"]);
  });

  test("survives a multi-byte character split across chunks", () => {
    const s = new LineSplitter();
    // the pty decoder hands us whole code points, so the halves arrive as text either way
    expect(s.feed("caf")).toEqual([]);
    expect(s.feed("é au lait\n")).toEqual(["café au lait"]);
  });
});
