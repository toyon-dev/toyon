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
  | "terminal"
  | "worktree"
  | "project";

export type ChordSection = "Find" | "Panels" | "Preview" | "Worktrees";

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
  /** other keys that fire the same chord. ⌘⇧E for the palette because Firefox owns ⌘⇧P; ⌘N for
   * new-worktree because it is the muscle-memory key, though only an installed PWA lets the page
   * see it (Chrome tabs, Safari and Firefox all take ⌘N as new window before the page). */
  aliases?: string[];
  /** which alias the labels show instead of `key`, and in which environment: on Firefox because
   * the primary never reaches the page there, in an installed Chromium PWA because that is the one
   * place the browser gives the alias up */
  advertise?: { key: string; when: keyof ChordEnv };
  label: string;
  section: ChordSection;
}

export const CHORDS: readonly Chord[] = [
  { id: "quick-open", key: "p", label: "jump to file", section: "Find" },
  {
    id: "commands",
    key: "p",
    shift: true,
    aliases: ["e"],
    advertise: { key: "e", when: "firefox" },
    label: "command palette",
    section: "Find",
  },
  { id: "search", key: "f", shift: true, label: "search in files", section: "Find" },
  { id: "left", key: "b", label: "changes", section: "Panels" },
  { id: "right", key: "j", label: "chat", section: "Panels" },
  // ⌘, is the macOS preferences key, and unlike ⌘N/⌘T/⌘W a page may preempt it in a tab as
  // well as in an installed app, so it is ours everywhere. ⌘/ is deliberately not bound: it is
  // toggle-comment in Monaco (and every editor), and the shell listens on window.
  { id: "keys", key: ",", label: "settings & shortcuts", section: "Panels" },
  { id: "terminal", key: "`", ctrl: true, label: "terminal", section: "Panels" },
  { id: "pick", key: "e", label: "element picker", section: "Preview" },
  { id: "zen", key: ".", label: "full-bleed preview", section: "Preview" },
  {
    id: "new",
    key: "k",
    aliases: ["n"],
    advertise: { key: "n", when: "pwa" },
    label: "new worktree",
    section: "Worktrees",
  },
  { id: "worktree", key: "1-9", label: "switch worktree", section: "Worktrees" },
  // ⌘⇧O: Zed's recent-projects key is ⌘⌥O, but ⌥ is how macOS types symbols and matchChord
  // refuses it; ⇧O is free in every browser we run in
  { id: "project", key: "o", shift: true, label: "switch project", section: "Worktrees" },
];

export const CHORD_SECTIONS: readonly ChordSection[] = ["Find", "Panels", "Preview", "Worktrees"];

export type ChordMatch = { id: Exclude<ChordId, "worktree"> } | { id: "worktree"; digit: number };

/** Normalised chord detection for a keydown: ⌘ (no ⌃/⌥) for most rows, ⌃ alone for the rows that
 * ask for it; letters case-insensitive so a browser that reports "F" for ⌘⇧F and one that reports
 * "f" agree; shift must match the table exactly (⌘⇧B is not ⌘B). */
export function matchChord(e: {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): ChordMatch | null {
  if (e.altKey || !!e.ctrlKey === e.metaKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.metaKey && !e.shiftKey && key >= "1" && key <= "9") return { id: "worktree", digit: Number(key) };
  for (const c of CHORDS) {
    if (c.id === "worktree") continue;
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

/** "⌘⇧P" style label, showing the chord's advertised alias when the environment calls for it
 * (⌘⇧E on Firefox, ⌘N in an installed PWA). Other aliases stay unadvertised. */
export function chordLabel(id: ChordId, env: ChordEnv = {}): string {
  const c = chordOf(id);
  const key = c.advertise && env[c.advertise.when] ? c.advertise.key : c.key;
  const shown = key === "1-9" ? "1-9" : key.toUpperCase();
  return `${c.ctrl ? "⌃" : "⌘"}${c.shift ? "⇧" : ""}${shown}`;
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
