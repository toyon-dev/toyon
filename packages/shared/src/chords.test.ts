import { describe, expect, test } from "bun:test";
import { CHORD_LABELS, chordLabel } from "./chord-labels.ts";
import { CHORDS, chordOf, matchChord, worktreeChord, worktreeIndex } from "./chords.ts";

const ev = (key: string, o: Partial<{ meta: boolean; shift: boolean; ctrl: boolean; alt: boolean }> = {}) => ({
  key,
  metaKey: o.meta ?? true,
  shiftKey: o.shift ?? false,
  ctrlKey: o.ctrl ?? false,
  altKey: o.alt ?? false,
});

describe("matchChord", () => {
  test("plain ⌘ chords", () => {
    expect(matchChord(ev("k"))).toEqual({ id: "new" });
    expect(matchChord(ev("n"))).toEqual({ id: "new" }); // reaches the page only in a PWA
    expect(matchChord(ev("p"))).toEqual({ id: "quick-open" });
    expect(matchChord(ev("."))).toEqual({ id: "zen" });
    expect(matchChord(ev(","))).toEqual({ id: "keys" }); // macOS preferences key
    expect(matchChord(ev("/"))).toBeNull(); // left to Monaco's toggle-comment
  });
  test("shift chords match whether the browser reports upper or lower case", () => {
    expect(matchChord(ev("F", { shift: true }))).toEqual({ id: "search" });
    expect(matchChord(ev("f", { shift: true }))).toEqual({ id: "search" });
    expect(matchChord(ev("P", { shift: true }))).toEqual({ id: "commands" });
    expect(matchChord(ev("E", { shift: true }))).toEqual({ id: "commands" });
  });
  test("shift must match the table: ⌘⇧B is not ⌘B, ⌘E is not ⌘⇧E", () => {
    expect(matchChord(ev("b", { shift: true }))).toBeNull();
    expect(matchChord(ev("e"))).toEqual({ id: "pick" });
    expect(matchChord(ev("e", { shift: true }))).toEqual({ id: "commands" });
  });
  test("digits switch worktrees; shifted digits do not", () => {
    expect(matchChord(ev("3"))).toEqual({ id: "worktree", digit: 3 });
    expect(matchChord(ev("3", { shift: true }))).toBeNull();
  });
  test("⌃ or ⌥ or no ⌘ never matches a ⌘ row", () => {
    expect(matchChord(ev("k", { meta: false }))).toBeNull();
    expect(matchChord(ev("k", { ctrl: true }))).toBeNull();
    expect(matchChord(ev("k", { meta: false, ctrl: true }))).toBeNull();
    expect(matchChord(ev("k", { alt: true }))).toBeNull();
  });
  test("a ⌃ row matches ⌃ alone or ⌘ alone (⌘` reaches the page only in an app window), never both", () => {
    expect(matchChord(ev("`", { meta: false, ctrl: true }))).toEqual({ id: "terminal" });
    expect(matchChord(ev("`"))).toEqual({ id: "terminal" });
    expect(matchChord(ev("`", { ctrl: true }))).toBeNull();
    // ⇧ is its own row (cycle the terminal pane's tabs), not a miss on the toggle
    expect(matchChord(ev("`", { meta: false, ctrl: true, shift: true }))).toEqual({ id: "term-tab" });
    expect(matchChord(ev("1", { meta: false, ctrl: true }))).toBeNull();
  });
  test("⌥ alone matches the arrow rows and nothing else", () => {
    expect(matchChord(ev("ArrowUp", { meta: false, alt: true }))).toEqual({ id: "wt-prev" });
    expect(matchChord(ev("ArrowDown", { meta: false, alt: true }))).toEqual({ id: "wt-next" });
    // ⌥⌘↑ is Monaco's add-cursor and ⌥⇧↑ is a text selection: neither is ours
    expect(matchChord(ev("ArrowUp", { alt: true }))).toBeNull();
    expect(matchChord(ev("ArrowUp", { meta: false, alt: true, shift: true }))).toBeNull();
    // the arrows without ⌥ are the focused list's own
    expect(matchChord(ev("ArrowUp", { meta: false }))).toBeNull();
    expect(matchChord(ev("ArrowUp"))).toBeNull();
  });
  test("keys the table doesn't own pass through", () => {
    expect(matchChord(ev("f"))).toBeNull(); // ⌘F stays the page's own find
    expect(matchChord(ev("w"))).toBeNull();
  });
  test("an advertised key is always one of the chord's aliases", () => {
    for (const [id, shown] of Object.entries(CHORD_LABELS)) {
      if (shown.advertise) expect(chordOf(id as keyof typeof CHORD_LABELS).aliases).toContain(shown.advertise.key);
    }
  });
  // the table says what exists and the label map says how it reads; neither may drift from the other
  test("every chord has wording", () => {
    expect(Object.keys(CHORD_LABELS).sort()).toEqual(CHORDS.map((c) => c.id).sort());
  });
  test("every table entry round-trips through the matcher", () => {
    for (const c of CHORDS) {
      if (c.id === "worktree") continue;
      expect(
        matchChord(ev(c.key, { shift: !!c.shift, ctrl: !!c.ctrl, alt: !!c.alt, meta: !c.ctrl && !c.alt })),
      ).toEqual({ id: c.id });
    }
  });
});

describe("labels", () => {
  test("chordLabel formats ⌘/⇧ and the Firefox alias", () => {
    expect(chordLabel("commands")).toBe("⌘⇧P");
    expect(chordLabel("commands", { firefox: true })).toBe("⌘⇧E");
    expect(chordLabel("new", { firefox: true })).toBe("⌘K"); // ⌘N is an alias, not the Firefox key
    expect(chordLabel("new", { pwa: true })).toBe("⌘N"); // an installed PWA lets ⌘N through
    expect(chordLabel("commands", { pwa: true })).toBe("⌘⇧P");
    expect(chordLabel("keys")).toBe("⌘,");
    expect(chordLabel("search")).toBe("⌘⇧F");
    expect(chordLabel("zen")).toBe("⌘.");
    expect(chordLabel("terminal")).toBe("⌃`");
    expect(chordLabel("worktree")).toBe("⌘1-9");
    expect(chordLabel("wt-prev")).toBe("⌥↑");
    expect(chordLabel("wt-next")).toBe("⌥↓");
  });
  test("worktreeChord / worktreeIndex agree: ⌘9 is always the last", () => {
    expect(worktreeChord(0, 3)).toBe("⌘1");
    expect(worktreeChord(2, 3)).toBe("⌘9");
    expect(worktreeChord(8, 12)).toBeUndefined();
    expect(worktreeIndex(9, 3)).toBe(2);
    expect(worktreeIndex(2, 3)).toBe(1);
    expect(worktreeIndex(5, 3)).toBeNull();
    expect(worktreeIndex(1, 0)).toBeNull();
  });
});
