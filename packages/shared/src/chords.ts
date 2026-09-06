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
  | "keys"
  | "pick"
  | "zen"
  | "new"
  | "worktree";

export type ChordSection = "Find" | "Panels" | "Preview" | "Worktrees";

export interface Chord {
  id: ChordId;
  /** the key as KeyboardEvent.key, lower-case for letters; "1-9" for the worktree switcher */
  key: string;
  shift?: boolean;
  /** other keys that fire the same chord (⌘⇧E for the palette: Firefox owns ⌘⇧P) */
  aliases?: string[];
  label: string;
  section: ChordSection;
}

export const CHORDS: readonly Chord[] = [
  { id: "quick-open", key: "p", label: "jump to file", section: "Find" },
  { id: "commands", key: "p", shift: true, aliases: ["e"], label: "command palette", section: "Find" },
  { id: "search", key: "f", shift: true, label: "search in files", section: "Find" },
  { id: "left", key: "b", label: "changes", section: "Panels" },
  { id: "right", key: "j", label: "chat", section: "Panels" },
  { id: "keys", key: "/", label: "shortcuts & settings", section: "Panels" },
  { id: "pick", key: "e", label: "element picker", section: "Preview" },
  { id: "zen", key: ".", label: "full-bleed preview", section: "Preview" },
  { id: "new", key: "k", label: "new worktree", section: "Worktrees" },
  { id: "worktree", key: "1-9", label: "switch worktree", section: "Worktrees" },
];

export const CHORD_SECTIONS: readonly ChordSection[] = ["Find", "Panels", "Preview", "Worktrees"];

export type ChordMatch = { id: Exclude<ChordId, "worktree"> } | { id: "worktree"; digit: number };

/** Normalised chord detection for a keydown: ⌘ (no ⌃/⌥), letters case-insensitive so a browser
 * that reports "F" for ⌘⇧F and one that reports "f" agree; shift must match the table exactly
 * (⌘⇧B is not ⌘B). */
export function matchChord(e: {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): ChordMatch | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!e.shiftKey && key >= "1" && key <= "9") return { id: "worktree", digit: Number(key) };
  for (const c of CHORDS) {
    if (c.id === "worktree") continue;
    if (!!c.shift !== e.shiftKey) continue;
    if (c.key === key || c.aliases?.includes(key)) return { id: c.id };
  }
  return null;
}

export function chordOf(id: ChordId): Chord {
  const c = CHORDS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown chord ${id}`);
  return c;
}

/** "⌘⇧P" style label. Firefox owns ⌘⇧P (new private window) before the page sees it, so there
 * the palette advertises its alias. */
export function chordLabel(id: ChordId, opts: { firefox?: boolean } = {}): string {
  const c = chordOf(id);
  const key = opts.firefox && c.aliases?.[0] ? c.aliases[0] : c.key;
  const shown = key === "1-9" ? "1–9" : key.toUpperCase();
  return `⌘${c.shift ? "⇧" : ""}${shown}`;
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
