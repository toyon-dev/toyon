// The keyboard chords, once. The shell's key handler, the bridge's forwarder (chords pressed
// while the preview has focus), the shortcuts card and the palette hints all derive from this
// table, so a chord can't be handled in one place and forgotten in another.
//
// Dependency-free on purpose: the bridge bundle imports this file.

export type ChordId =
  | "quick-open"
  | "commands"
  | "search"
  | "left"
  | "right"
  | "composer"
  | "rail"
  | "keys"
  | "pick"
  | "inspect"
  | "zen"
  | "new"
  | "terminal"
  | "design"
  | "term-tab"
  | "worktree"
  | "wt-prev"
  | "wt-next"
  | "wt-unseen-prev"
  | "wt-unseen-next"
  | "project"
  | "refs";

/** what the shell knows about the browser it runs in; each flag can swap an advertised key */
export interface ChordEnv {
  firefox?: boolean;
  pwa?: boolean;
}

export interface Chord {
  id: ChordId;
  /** the key as KeyboardEvent.key, lower-case for letters; "1-9" for the worktree switcher */
  key: string;
  shift?: boolean;
  /** bound and advertised as ⌃ rather than ⌘: for keys macOS takes before a browser sees them (⌘`
   * cycles windows), where every editor settled on the ⌃ form. ⌘ still counts when it does arrive
   * (an installed app window with nothing to cycle to). */
  ctrl?: true;
  /** bound and advertised as ⌥ with no ⌘: only for the arrow rows. ⌥ with a letter is how macOS
   * types a symbol and ⌥ with ⌘ is Monaco's cursor family, but an arrow types nothing, so ⌥↑/↓ can
   * be the next-and-previous pair the way it is in Slack. */
  alt?: true;
  /** the same chord again on ⌃, with a key and ⇧ of its own: ⌃Tab and ⌃⇧Tab walk the worktrees
   * the way they walk a terminal's tabs. Every browser tab takes ⌃Tab before the page; an
   * installed app window has no tabs and hands it over, so that is where it is advertised. */
  ctrlAlias?: { key: string; shift?: true };
  /** other keys that fire the same chord. ⌘⇧E for the palette because Firefox owns ⌘⇧P; ⌘N for
   * new-worktree because it is the muscle-memory key, though only an installed PWA lets the page
   * see it (Chrome tabs, Safari and Firefox all take ⌘N as new window before the page). */
  aliases?: string[];
}

export const CHORDS: readonly Chord[] = [
  { id: "quick-open", key: "p" },
  {
    id: "commands",
    key: "p",
    shift: true,
    aliases: ["e"],
  },
  { id: "search", key: "f", shift: true },
  { id: "left", key: "b" },
  { id: "right", key: "j" },
  // ⌘L is Cursor's key for the chat box, so it is the one a hand already reaches for. It only ever
  // puts the caret in the box, opening the chat panel if it must; ⌘J is the toggle. A tab may lose
  // it to the address bar, an installed app always sees it.
  { id: "composer", key: "l" },
  // ⌘⇧K next to ⌘K: one makes a worktree, the other shows the panel of them. Firefox takes ⌘⇧K
  // for the web console before the page sees it, so ⌘⇧L is the alias it advertises there
  {
    id: "rail",
    key: "k",
    shift: true,
    aliases: ["l"],
  },
  // ⌘, is the macOS preferences key, and unlike ⌘N/⌘T/⌘W a page may preempt it in a tab as
  // well as in an installed app, so it is ours everywhere. ⌘/ is deliberately not bound: it is
  // toggle-comment in Monaco (and every editor), and the shell listens on window.
  { id: "keys", key: "," },
  { id: "terminal", key: "`", ctrl: true },
  { id: "design", key: "d" },
  // a focused xterm swallows nearly everything, so tab cycling needs a chord matchChord catches
  { id: "term-tab", key: "`", ctrl: true, shift: true },
  { id: "pick", key: "e" },
  // ⌘I is the same picker with the source as the click and ⌥ back to the chat: ⌘E adds an element
  // to the message, ⌘I jumps to its code, a key short of the browser's ⌘⌥I
  { id: "inspect", key: "i" },
  { id: "zen", key: "." },
  {
    id: "new",
    key: "k",
    aliases: ["n"],
  },
  { id: "worktree", key: "1-9" },
  // ⌥↑/↓ walk the rail the way ⌥↑/↓ walk Slack's channels, ⌃Tab the way it walks a terminal's
  // tabs; ⌘1-9 jumps by position. A focused Monaco keeps the ⌥ form, where ⌥↑/↓ is move-line
  // (app/keys.ts), so ⌃Tab is the walk that still works from inside the editor.
  { id: "wt-prev", key: "ArrowUp", alt: true, ctrlAlias: { key: "Tab", shift: true } },
  { id: "wt-next", key: "ArrowDown", alt: true, ctrlAlias: { key: "Tab" } },
  // ⌥⇧↑/↓ is Slack's next-unread: the nearest worktree with a turn nobody has looked at, and
  // the walk's end (main, the draft) when there is none. Off the shortcuts card on purpose.
  { id: "wt-unseen-prev", key: "ArrowUp", alt: true, shift: true },
  { id: "wt-unseen-next", key: "ArrowDown", alt: true, shift: true },
  // ⌘⇧O: Zed's recent-projects key is ⌘⌥O, but ⌥ is how macOS types symbols and matchChord
  // refuses it; ⇧O is free in every browser we run in
  { id: "project", key: "o", shift: true },
  // ⌘⇧G: a browser only uses it as find-previous while its find bar is open, which a page may
  // preempt; every other ⌘⇧ letter that reads as "go" or "git" is taken before the page sees it
  { id: "refs", key: "g", shift: true },
];

export type ChordMatch = { id: Exclude<ChordId, "worktree"> } | { id: "worktree"; digit: number };

/** Normalised chord detection for a keydown: ⌘ (no ⌃/⌥) for most rows, ⌃ alone for the rows that
 * ask for it and for a row's ⌃ alias, ⌥ alone for the arrow rows; letters case-insensitive so a
 * browser that reports "F" for ⌘⇧F and one that reports "f" agree; shift must match the table
 * exactly (⌘⇧B is not ⌘B). */
export function matchChord(e: {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): ChordMatch | null {
  if (e.altKey) {
    if (e.metaKey || e.ctrlKey) return null;
    const c = CHORDS.find((c) => c.alt && c.key === e.key && !!c.shift === e.shiftKey);
    return c && c.id !== "worktree" ? { id: c.id } : null;
  }
  if (!!e.ctrlKey === e.metaKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.metaKey && !e.shiftKey && key >= "1" && key <= "9") return { id: "worktree", digit: Number(key) };
  for (const c of CHORDS) {
    if (c.id === "worktree") continue;
    const a = c.ctrlAlias;
    if (a && e.ctrlKey && a.key === key && !!a.shift === e.shiftKey) return { id: c.id };
    if (c.alt) continue;
    // a ⌘ row never fires on ⌃; a ⌃ row fires on either
    if ((e.ctrlKey && !c.ctrl) || !!c.shift !== e.shiftKey) continue;
    if (c.key === key || c.aliases?.includes(key)) return { id: c.id };
  }
  return null;
}

export function chordOf(id: ChordId): Chord {
  const c = CHORDS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown chord ${id}`);
  return c;
}

/** the ⌘N chord that reaches worktree i of count, if any: ⌘1–8 by position, ⌘9 always the last one */
export function worktreeChord(i: number, count: number): string | undefined {
  if (i === count - 1) return "⌘9";
  return i < 8 ? `⌘${i + 1}` : undefined;
}

/** ⌘9 is the last worktree (macOS tab convention); ⌘1–8 by position */
export function worktreeIndex(digit: number, count: number): number | null {
  if (count === 0) return null;
  if (digit === 9) return count - 1;
  return digit - 1 < count ? digit - 1 : null;
}
