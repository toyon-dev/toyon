import { beforeEach, describe, expect, test } from "bun:test";
import { type Timers, VISIT_DWELL_MS, VisitTracker } from "./visits.ts";

/** timers the test runs by hand: `elapse` fires everything still pending */
function fakeTimers() {
  let next = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers: Timers = {
    set: (fn, ms) => {
      pending.set(++next, { fn, ms });
      return next;
    },
    clear: (h) => pending.delete(h as number),
  };
  const elapse = () => {
    for (const [h, t] of [...pending]) {
      pending.delete(h);
      t.fn();
    }
  };
  return { timers, pending, elapse };
}

describe("VisitTracker", () => {
  let sent: string[][];
  let renamed: string[][];
  let clock: ReturnType<typeof fakeTimers>;
  let tracker: VisitTracker;
  beforeEach(() => {
    sent = [];
    renamed = [];
    clock = fakeTimers();
    tracker = new VisitTracker(
      (id, path, title) => sent.push(title === undefined ? [id, path] : [id, path, title]),
      (id, path, title) => renamed.push([id, path, title]),
      clock.timers,
    );
  });

  test("a page counts once it has stayed, keyed without its query", () => {
    tracker.note("w1", "http://x/pricing?tab=2");
    expect(sent).toEqual([]);
    expect([...clock.pending.values()][0]?.ms).toBe(VISIT_DWELL_MS);
    clock.elapse();
    expect(sent).toEqual([["w1", "/pricing"]]);
  });

  test("a page left before the dwell never counts", () => {
    tracker.note("w1", "http://x/login");
    tracker.note("w1", "http://x/auth/callback?code=1");
    tracker.note("w1", "http://x/dashboard");
    clock.elapse();
    expect(sent).toEqual([["w1", "/dashboard"]]);
  });

  test("a reload or a query rewrite on the same page sends nothing more", () => {
    tracker.note("w1", "http://x/feed");
    clock.elapse();
    tracker.note("w1", "http://x/feed");
    tracker.note("w1", "http://x/feed?scroll=400");
    clock.elapse();
    expect(sent).toEqual([["w1", "/feed"]]);
  });

  test("coming back to a page after another one held counts again", () => {
    tracker.note("w1", "http://x/a");
    clock.elapse();
    tracker.note("w1", "http://x/b");
    clock.elapse();
    tracker.note("w1", "http://x/a");
    clock.elapse();
    expect(sent.map(([, p]) => p)).toEqual(["/a", "/b", "/a"]);
  });

  test("each frame keeps its own last page", () => {
    tracker.note("w1", "http://x/a");
    tracker.note("w2", "http://y/a");
    clock.elapse();
    expect(sent).toEqual([
      ["w1", "/a"],
      ["w2", "/a"],
    ]);
  });

  test("dispose drops what was still waiting", () => {
    tracker.note("w1", "http://x/a");
    tracker.dispose();
    expect(clock.pending.size).toBe(0);
  });

  test("the visit carries the title the document settled on during the dwell", () => {
    tracker.note("w1", "http://x/pricing", "Home | Acme");
    tracker.title("w1", "  Pricing |   Acme ");
    clock.elapse();
    expect(sent).toEqual([["w1", "/pricing", "Pricing | Acme"]]);
    expect(renamed).toEqual([]);
  });

  test("a title that settles after the visit was counted renames the page once", () => {
    tracker.note("w1", "http://x/pricing", "Acme");
    clock.elapse();
    tracker.title("w1", "Pricing | Acme");
    tracker.title("w1", "Pricing | Acme");
    expect(renamed).toEqual([["w1", "/pricing", "Pricing | Acme"]]);
  });

  test("a page waiting out its dwell keeps its title off the page counted before it", () => {
    tracker.note("w1", "http://x/a", "A");
    clock.elapse();
    // the navigation lands while the document still carries the old title
    tracker.note("w1", "http://x/b", "A");
    tracker.title("w1", "B");
    expect(renamed).toEqual([]);
    clock.elapse();
    expect(sent.at(-1)).toEqual(["w1", "/b", "B"]);
  });

  test("a reload that brings a new title renames the page without counting it again", () => {
    tracker.note("w1", "http://x/a", "Draft");
    clock.elapse();
    tracker.note("w1", "http://x/a", "About");
    expect(sent).toEqual([["w1", "/a", "Draft"]]);
    expect(renamed).toEqual([["w1", "/a", "About"]]);
  });
});
