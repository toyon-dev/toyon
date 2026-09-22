import { describe, expect, test } from "bun:test";
import { LineSplitter } from "./lines.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** the lines a feed completed, for the tests that care about nothing else */
function lines(s: LineSplitter, chunk: string): string[] {
  return s.feed(chunk).map((e) => e.line);
}

describe("LineSplitter", () => {
  test("splits on newlines and drops blank lines", () => {
    const s = new LineSplitter();
    expect(lines(s, "one\ntwo\n\n  \nthree\n")).toEqual(["one", "two", "three"]);
  });

  test("holds a partial line until its newline arrives", () => {
    const s = new LineSplitter();
    expect(lines(s, "hel")).toEqual([]);
    expect(lines(s, "lo wor")).toEqual([]);
    expect(lines(s, "ld\n")).toEqual(["hello world"]);
  });

  test("keeps CRLF endings clean", () => {
    const s = new LineSplitter();
    expect(lines(s, "ready in 312 ms\r\nlocal: http://x\r\n")).toEqual(["ready in 312 ms", "local: http://x"]);
  });

  test("collapses a progress bar to its last state", () => {
    const s = new LineSplitter();
    expect(lines(s, "10%\r45%\r100%\n")).toEqual(["100%"]);
  });

  test("strips colour, erase-line and hyperlink sequences", () => {
    const s = new LineSplitter();
    const colour = `${ESC}[32mVITE${ESC}[0m ready`;
    const bar = `${ESC}[2K\rbuilding`;
    const link = `${ESC}]8;;http://localhost:5173${BEL}Local${ESC}]8;;${BEL}`;
    expect(lines(s, `${colour}\n${bar}\n${link}\n`)).toEqual(["VITE ready", "building", "Local"]);
  });

  test("a line carries no retract unless it climbed", () => {
    const s = new LineSplitter();
    expect(s.feed("plain\n")).toEqual([{ line: "plain", retract: 0 }]);
  });

  test("a bar that climbs over its last frame retracts it", () => {
    // yarn: cursor up over the frame, erase below, print the next frame
    const s = new LineSplitter();
    expect(s.feed("fetching\n[=>   ] 20%\n")).toEqual([
      { line: "fetching", retract: 0 },
      { line: "[=>   ] 20%", retract: 0 },
    ]);
    expect(s.feed(`${ESC}[1A${ESC}[0J[==>  ] 40%\n`)).toEqual([{ line: "[==>  ] 40%", retract: 1 }]);
  });

  test("a frame of several lines retracts them all, once", () => {
    const s = new LineSplitter();
    s.feed("a 10%\nb 10%\n");
    expect(s.feed(`${ESC}[2A${ESC}[0Ja 50%\nb 50%\n`)).toEqual([
      { line: "a 50%", retract: 2 },
      { line: "b 50%", retract: 0 },
    ]);
  });

  test("a bar wiped as the process moves on is a retract with no line", () => {
    const s = new LineSplitter();
    s.feed("[====] 100%\n");
    expect(s.feed(`${ESC}[1A${ESC}[0J`)).toEqual([{ line: "", retract: 1 }]);
    // the climb is spent: what follows is a plain line
    expect(s.feed("done\n")).toEqual([{ line: "done", retract: 0 }]);
  });

  test("a climb split across chunks waits until it is whole", () => {
    const s = new LineSplitter();
    expect(s.feed(`${ESC}[1`)).toEqual([]);
    expect(s.feed(`A${ESC}[0Jredrawn\n`)).toEqual([{ line: "redrawn", retract: 1 }]);
  });

  test("cursor-previous-line and a bare count both climb", () => {
    const s = new LineSplitter();
    expect(s.feed(`${ESC}[F${ESC}[Ax\n`)).toEqual([{ line: "x", retract: 2 }]);
  });

  test("flushes a line that never ends, so the buffer cannot grow without bound", () => {
    const s = new LineSplitter();
    const out = lines(s, "x".repeat(70 * 1024));
    expect(out).toHaveLength(1);
    expect(out[0]?.length).toBe(70 * 1024);
    expect(lines(s, "rest\n")).toEqual(["rest"]);
  });

  test("survives a multi-byte character split across chunks", () => {
    const s = new LineSplitter();
    // the pty decoder hands us whole code points, so the halves arrive as text either way
    expect(lines(s, "caf")).toEqual([]);
    expect(lines(s, "é au lait\n")).toEqual(["café au lait"]);
  });
});
