import { describe, expect, test } from "bun:test";
import { CHORD_LABELS, CHORD_SECTIONS, chordLabel, chordsInSection } from "./chord-labels.ts";
import { CHORDS, chordOf, matchChord, worktreeChord, worktreeIndex, ZEN_CHORDS } from "./chords.ts";

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
    expect(matchChord(ev("l"))).toEqual({ id: "composer" });
    expect(matchChord(ev("L", { shift: true }))).toBeNull(); // Cursor's add-to-chat, not the rail
    expect(matchChord(ev("o"))).toEqual({ id: "project" }); // VS Code's open key
    expect(matchChord(ev("/"))).toBeNull(); // left to Monaco's toggle-comment
  });
  test("shift chords match whether the browser reports upper or lower case", () => {
    expect(matchChord(ev("F", { shift: true }))).toEqual({ id: "search" });
    expect(matchChord(ev("f", { shift: true }))).toEqual({ id: "search" });
    expect(matchChord(ev("P", { shift: true }))).toEqual({ id: "commands" });
    expect(matchChord(ev("p", { shift: true }))).toEqual({ id: "commands" });
  });
  test("shift must match the table: ⌘⇧B is not ⌘B, ⌘⇧E is not ⌘E", () => {
    expect(matchChord(ev("b", { shift: true }))).toBeNull();
    expect(matchChord(ev("e"))).toEqual({ id: "pick" });
    expect(matchChord(ev("i"))).toEqual({ id: "inspect" });
    // ⌘⇧E is the file tree in VS Code, Cursor and Zed
    expect(matchChord(ev("e", { shift: true }))).toEqual({ id: "files" });
    expect(matchChord(ev("E", { shift: true }))).toEqual({ id: "files" });
  });
  test("F1 is the palette as in VS Code, for the Firefox hand that has no ⌘⇧P; a guest keeps it", () => {
    expect(matchChord(ev("F1", { meta: false }))).toEqual({ id: "commands" });
    expect(matchChord(ev("F1", { meta: false, shift: true }))).toBeNull();
    expect(matchChord(ev("F1"))).toBeNull();
    expect(matchChord(ev("F1", { meta: false }), { guest: true })).toBeNull(); // help in vim and htop
    expect(matchChord(ev("p", { meta: false }))).toBeNull(); // a bare letter is typing
    expect(matchChord(ev("F2", { meta: false }))).toBeNull();
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
  test("⌘J and ⌃` both reach the terminal, as they do in VS Code, Cursor and Zed", () => {
    expect(matchChord(ev("j"))).toEqual({ id: "terminal" });
    expect(matchChord(ev("`", { meta: false, ctrl: true }))).toEqual({ id: "terminal" });
    // from inside the terminal too: ⌃` is not an alias a shell program has a use for
    expect(matchChord(ev("`", { meta: false, ctrl: true }), { guest: true })).toEqual({ id: "terminal" });
    expect(matchChord(ev("j"), { guest: true })).toEqual({ id: "terminal" });
    expect(matchChord(ev("`"))).toBeNull(); // ⌘` cycles windows before a page sees it
    expect(matchChord(ev("`", { ctrl: true }))).toBeNull();
    expect(matchChord(ev("j", { meta: false, ctrl: true }))).toBeNull(); // ⌃J is Monaco's join lines
  });
  test("a ⌃ row matches ⌃ alone or ⌘ alone, never both", () => {
    // ⇧ is its own row (cycle the terminal pane's tabs), not a miss on the toggle
    expect(matchChord(ev("`", { meta: false, ctrl: true, shift: true }))).toEqual({ id: "term-tab" });
    expect(matchChord(ev("`", { shift: true }))).toEqual({ id: "term-tab" });
    expect(matchChord(ev("`", { ctrl: true, shift: true }))).toBeNull();
    expect(matchChord(ev("1", { meta: false, ctrl: true }))).toBeNull();
  });
  test("the chat has one chord: ⌘L", () => {
    expect(matchChord(ev("l"))).toEqual({ id: "composer" });
    expect(Object.keys(CHORD_LABELS)).not.toContain("right");
  });
  test("⌘⇧[ and ⌘⇧] walk the worktrees as they walk tabs, whichever bracket the browser reports", () => {
    expect(matchChord(ev("[", { shift: true }))).toEqual({ id: "wt-prev" });
    expect(matchChord(ev("{", { shift: true }))).toEqual({ id: "wt-prev" });
    expect(matchChord(ev("]", { shift: true }))).toEqual({ id: "wt-next" });
    expect(matchChord(ev("}", { shift: true }))).toEqual({ id: "wt-next" });
    // not a hostOnly alias: the walk works from inside the terminal and the preview
    expect(matchChord(ev("}", { shift: true }), { guest: true })).toEqual({ id: "wt-next" });
    expect(matchChord(ev("["))).toBeNull(); // ⌘[ is Monaco's outdent
    expect(matchChord(ev("[", { meta: false, ctrl: true, shift: true }))).toBeNull();
    expect(matchChord(ev("[", { meta: false, shift: true }))).toBeNull();
  });
  test("⌥ alone matches the arrow rows and nothing else", () => {
    expect(matchChord(ev("ArrowUp", { meta: false, alt: true }))).toEqual({ id: "wt-prev" });
    expect(matchChord(ev("ArrowDown", { meta: false, alt: true }))).toEqual({ id: "wt-next" });
    // ⌥⌘↑ is Monaco's add-cursor: not ours
    expect(matchChord(ev("ArrowUp", { alt: true }))).toBeNull();
    // ⌥⇧ is the unseen pair, Slack's next-unread
    expect(matchChord(ev("ArrowUp", { meta: false, alt: true, shift: true }))).toEqual({ id: "wt-unseen-prev" });
    expect(matchChord(ev("ArrowDown", { meta: false, alt: true, shift: true }))).toEqual({ id: "wt-unseen-next" });
    expect(matchChord(ev("k", { meta: false, alt: true, shift: true }))).toBeNull();
    // ⌥←/→ is the panel's tabs, with no ⇧ form
    expect(matchChord(ev("ArrowLeft", { meta: false, alt: true }))).toEqual({ id: "panel-tab-prev" });
    expect(matchChord(ev("ArrowRight", { meta: false, alt: true }))).toEqual({ id: "panel-tab-next" });
    expect(matchChord(ev("ArrowRight", { meta: false, alt: true, shift: true }))).toBeNull();
    // the arrows without ⌥ are the focused list's own
    expect(matchChord(ev("ArrowUp", { meta: false }))).toBeNull();
    expect(matchChord(ev("ArrowUp"))).toBeNull();
  });
  test("⌃Tab and ⌃⇧Tab walk the worktrees as they walk a terminal's tabs; ⌘ or ⌥ with Tab do not", () => {
    expect(matchChord(ev("Tab", { meta: false, ctrl: true }))).toEqual({ id: "wt-next" });
    expect(matchChord(ev("Tab", { meta: false, ctrl: true, shift: true }))).toEqual({ id: "wt-prev" });
    expect(matchChord(ev("Tab"))).toBeNull(); // ⌘Tab is the app switcher
    expect(matchChord(ev("Tab", { meta: false, alt: true }))).toBeNull();
    expect(matchChord(ev("Tab", { meta: false }))).toBeNull(); // plain Tab moves focus
  });
  test("⌃R opens a project as open-recent does, except in a terminal or a page, which keep it", () => {
    expect(matchChord(ev("r", { meta: false, ctrl: true }))).toEqual({ id: "project" });
    expect(matchChord(ev("r", { meta: false, ctrl: true }), { guest: true })).toBeNull(); // history search
    expect(matchChord(ev("o"), { guest: true })).toEqual({ id: "project" });
    expect(matchChord(ev("O", { shift: true }))).toEqual({ id: "project" });
    expect(matchChord(ev("o", { shift: true }))).toEqual({ id: "project" });
    expect(matchChord(ev("O", { meta: false, ctrl: true, shift: true }))).toBeNull();
    expect(matchChord(ev("R", { meta: false, ctrl: true, shift: true }))).toBeNull();
    // an alias that is not hostOnly still reaches a guest: ⌃Tab walks from inside the terminal
    expect(matchChord(ev("Tab", { meta: false, ctrl: true }), { guest: true })).toEqual({ id: "wt-next" });
  });
  test("⌘B is the changes dock as it is the files panel in every editor; ⌘G searches the chats", () => {
    expect(matchChord(ev("b"))).toEqual({ id: "changes" });
    expect(matchChord(ev("b"), { guest: true })).toEqual({ id: "changes" });
    // ⌃⇧G is the git panel in VS Code and Zed: a hidden alias, never on the card
    expect(matchChord(ev("G", { meta: false, ctrl: true, shift: true }))).toEqual({ id: "changes" });
    expect(matchChord(ev("g", { meta: false, ctrl: true }))).toBeNull(); // Monaco's go to line
    expect(matchChord(ev("g"))).toEqual({ id: "chats" }); // ⌘F finds on screen, ⌘G in every chat
    expect(matchChord(ev("G", { shift: true }))).toEqual({ id: "refs" });
    expect(matchChord(ev("l"))).toEqual({ id: "composer" });
  });
  test("⌘U goes to a page, U for URL, from inside the preview too", () => {
    expect(matchChord(ev("u"))).toEqual({ id: "routes" });
    expect(matchChord(ev("u"), { guest: true })).toEqual({ id: "routes" });
  });
  test("⌘R reloads the preview alone; ⌘⇧R is left to the browser, which reloads everything", () => {
    expect(matchChord(ev("r"))).toEqual({ id: "reload" });
    expect(matchChord(ev("r"), { guest: true })).toEqual({ id: "reload" });
    expect(matchChord(ev("R", { shift: true }))).toBeNull();
  });
  test("⌘⇧U marks the worktree unread, as it does a message in Mail", () => {
    expect(matchChord(ev("U", { shift: true }))).toEqual({ id: "mark-unread" });
    expect(matchChord(ev("u", { shift: true }))).toEqual({ id: "mark-unread" });
  });
  test("keys the table doesn't own pass through", () => {
    expect(matchChord(ev("f"))).toBeNull(); // ⌘F stays the page's own find
    expect(matchChord(ev("q"))).toBeNull(); // ⌘Q never reaches a page; the app menu quits
  });
  test("⌘W closes a pane and keeps an installed app's window; from the preview too", () => {
    expect(matchChord(ev("w"))).toEqual({ id: "close" });
    expect(matchChord(ev("w"), { guest: true })).toEqual({ id: "close" });
    expect(matchChord(ev("W", { shift: true }))).toBeNull();
    expect(matchChord(ev("w", { meta: false, ctrl: true }))).toBeNull(); // ⌃W is delete-word in a shell
    expect(ZEN_CHORDS.has("close")).toBe(true);
  });
  test("an advertised key is always one of the chord's aliases", () => {
    for (const [id, shown] of Object.entries(CHORD_LABELS)) {
      if (!shown.advertise) continue;
      const c = chordOf(id as keyof typeof CHORD_LABELS);
      expect([...(c.aliases ?? []), c.ctrlAlias?.key, c.bareAlias]).toContain(shown.advertise.key);
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
      const a = c.ctrlAlias;
      if (a) expect(matchChord(ev(a.key, { shift: !!a.shift, ctrl: true, meta: false }))).toEqual({ id: c.id });
      for (const k of c.cmdShiftAlias ?? []) expect(matchChord(ev(k, { shift: true }))).toEqual({ id: c.id });
      if (c.bareAlias) expect(matchChord(ev(c.bareAlias, { meta: false }))).toEqual({ id: c.id });
    }
  });
});

describe("labels", () => {
  test("chordLabel formats ⌘/⇧ and the Firefox alias", () => {
    expect(chordLabel("commands")).toBe("⌘⇧P");
    expect(chordLabel("commands", { firefox: true })).toBe("F1"); // a bare key draws no modifier
    expect(chordLabel("new", { firefox: true })).toBe("⌘K"); // ⌘N is an alias, not the Firefox key
    expect(chordLabel("new", { pwa: true })).toBe("⌘N"); // an installed PWA lets ⌘N through
    expect(chordLabel("commands", { pwa: true })).toBe("⌘⇧P");
    expect(chordLabel("keys")).toBe("⌘,");
    expect(chordLabel("search")).toBe("⌘⇧F");
    expect(chordLabel("zen")).toBe("⌘.");
    expect(chordLabel("terminal")).toBe("⌘J");
    expect(chordLabel("composer")).toBe("⌘L");
    expect(chordLabel("worktree")).toBe("⌘1-9");
    expect(chordLabel("wt-prev")).toBe("⌥↑");
    expect(chordLabel("wt-next")).toBe("⌥↓");
    expect(chordLabel("wt-unseen-prev")).toBe("⌥⇧↑");
    expect(chordLabel("wt-unseen-next")).toBe("⌥⇧↓");
    expect(chordLabel("mark-unread")).toBe("⌘⇧U");
    expect(chordLabel("routes")).toBe("⌘U");
    expect(chordLabel("changes")).toBe("⌘B"); // the ⌃⇧G alias is not advertised
    expect(chordLabel("refs")).toBe("⌘⇧G");
    expect(chordLabel("chats")).toBe("⌘G");
    expect(chordLabel("reload")).toBe("⌘R");
    // an installed app window has no tabs, so it lets ⌃Tab through; the ⇧ belongs to the alias
    expect(chordLabel("wt-next", { pwa: true })).toBe("⌃Tab");
    expect(chordLabel("wt-prev", { pwa: true })).toBe("⌃⇧Tab");
    expect(chordLabel("wt-prev", { firefox: true })).toBe("⌥↑");
    expect(chordLabel("wt-unseen-next", { pwa: true })).toBe("⌥⇧↓");
  });
  test("a hidden chord has wording but no row on the card", () => {
    expect(chordLabel("wt-unseen-prev")).toBeTruthy();
    for (const section of CHORD_SECTIONS) {
      expect(chordsInSection(section)).not.toContain("wt-unseen-prev");
      // a key only an installed app ever sees has no row to read
      expect(chordsInSection(section)).not.toContain("close");
    }
    expect(chordsInSection("Worktrees")).toContain("wt-unseen-next");
    expect(chordsInSection("Worktrees")).toContain("wt-next");
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
