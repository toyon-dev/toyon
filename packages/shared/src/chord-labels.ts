// How the chords are shown: the wording on the shortcuts card, which section they file under, and
// which alias a given browser should advertise instead of the primary key.
//
// Separate from chords.ts because the bridge bundles that file into every preview page and never
// renders a label. The chord table stays the single source of truth for what exists;
// `Record<ChordId, ...>` here makes a chord without wording a compile error.

import type { ChordEnv, ChordId } from "./chords.ts";
import { chordOf } from "./chords.ts";

export type ChordSection = "Find" | "Panels" | "Preview" | "Worktrees";

export const CHORD_SECTIONS: readonly ChordSection[] = ["Find", "Panels", "Preview", "Worktrees"];

export interface ChordLabel {
  label: string;
  section: ChordSection;
  /** which alias the labels show instead of `key`, and in which environment: on Firefox because
   * the primary never reaches the page there, in an installed Chromium PWA because that is the one
   * place the browser gives the alias up */
  advertise?: { key: string; when: keyof ChordEnv };
}

export const CHORD_LABELS: Record<ChordId, ChordLabel> = {
  "quick-open": { label: "jump to file", section: "Find" },
  commands: { label: "command palette", section: "Find", advertise: { key: "e", when: "firefox" } },
  search: { label: "search in files", section: "Find" },
  left: { label: "changes panel", section: "Panels" },
  right: { label: "chat panel", section: "Panels" },
  rail: { label: "worktree panel", section: "Panels" },
  keys: { label: "settings & shortcuts", section: "Panels" },
  terminal: { label: "terminal", section: "Panels" },
  design: { label: "design system", section: "Panels" },
  "term-tab": { label: "next terminal tab", section: "Panels" },
  pick: { label: "element picker", section: "Preview" },
  zen: { label: "full-bleed preview", section: "Preview" },
  new: { label: "new worktree", section: "Worktrees", advertise: { key: "n", when: "pwa" } },
  worktree: { label: "switch worktree", section: "Worktrees" },
  "wt-prev": { label: "previous worktree", section: "Worktrees" },
  "wt-next": { label: "next worktree", section: "Worktrees" },
  project: { label: "open project", section: "Worktrees" },
  refs: { label: "open a branch or PR", section: "Worktrees" },
};

/** the arrow rows' keys as they are drawn: KeyboardEvent.key names them in words */
const ARROWS: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓" };

/** "⌘⇧P" style label, showing the chord's advertised alias when the environment calls for it
 * (⌘⇧E on Firefox, ⌘N in an installed PWA). Other aliases stay unadvertised. */
export function chordLabel(id: ChordId, env: ChordEnv = {}): string {
  const c = chordOf(id);
  const shown = CHORD_LABELS[id];
  const key = shown.advertise && env[shown.advertise.when] ? shown.advertise.key : c.key;
  const text = key === "1-9" ? "1-9" : (ARROWS[key] ?? key.toUpperCase());
  return `${c.alt ? "⌥" : c.ctrl ? "⌃" : "⌘"}${c.shift ? "⇧" : ""}${text}`;
}

/** the shortcuts card's rows, in section order */
export function chordsInSection(section: ChordSection): ChordId[] {
  return (Object.keys(CHORD_LABELS) as ChordId[]).filter((id) => CHORD_LABELS[id].section === section);
}
