// How the chords are shown: the wording on the shortcuts card, which section they file under, and
// which alias a given browser should advertise instead of the primary key.
//
// Separate from chords.ts because the bridge bundles that file into every preview page and never
// renders a label. The chord table stays the single source of truth for what exists;
// `Record<ChordId, ...>` here makes a chord without wording a compile error.

import type { ChordEnv, ChordId } from "./chords.ts";
import { chordOf } from "./chords.ts";

export type ChordSection = "Find" | "Panels" | "Preview" | "Worktrees";

/** the card's two-column grid fills in this order: the two short sections share the top row and
 * the two long ones the bottom, so neither column carries a hole beside a tall neighbour */
export const CHORD_SECTIONS: readonly ChordSection[] = ["Find", "Preview", "Panels", "Worktrees"];

export interface ChordLabel {
  label: string;
  section: ChordSection;
  /** which alias the labels show instead of `key`, and in which environment: on Firefox because
   * the primary never reaches the page there, in an installed Chromium PWA because that is the one
   * place the browser gives the alias up */
  advertise?: { key: string; when: keyof ChordEnv };
  /** worded but not listed: a chord for the hand that already knows the one beside it, kept off
   * the card so the card stays the short list */
  hidden?: true;
}

export const CHORD_LABELS: Record<ChordId, ChordLabel> = {
  "quick-open": { label: "jump to file", section: "Find" },
  commands: { label: "command palette", section: "Find", advertise: { key: "e", when: "firefox" } },
  search: { label: "search in files", section: "Find" },
  left: { label: "changes panel", section: "Panels" },
  composer: { label: "chat panel, with the editor's selection", section: "Panels" },
  rail: { label: "worktree panel", section: "Panels" },
  keys: { label: "settings & shortcuts", section: "Panels" },
  terminal: { label: "terminal", section: "Panels" },
  design: { label: "design system", section: "Panels" },
  "term-tab": { label: "next terminal tab", section: "Panels" },
  routes: { label: "go to page", section: "Preview" },
  pick: { label: "element to chat", section: "Preview" },
  inspect: { label: "element to code", section: "Preview" },
  zen: { label: "full-bleed preview", section: "Preview" },
  new: { label: "new worktree", section: "Worktrees", advertise: { key: "n", when: "pwa" } },
  worktree: { label: "switch worktree", section: "Worktrees" },
  "wt-prev": { label: "previous worktree", section: "Worktrees", advertise: { key: "Tab", when: "pwa" } },
  "wt-next": { label: "next worktree", section: "Worktrees", advertise: { key: "Tab", when: "pwa" } },
  "wt-unseen-prev": { label: "previous worktree worth a look", section: "Worktrees", hidden: true },
  "wt-unseen-next": { label: "next worktree worth a look", section: "Worktrees" },
  "mark-unread": { label: "mark worktree unread", section: "Worktrees" },
  project: { label: "open project", section: "Worktrees" },
  refs: { label: "open a branch or PR", section: "Worktrees" },
};

/** named keys as they are drawn: KeyboardEvent.key spells the arrows out, and Tab stays a word */
const KEY_NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", Tab: "Tab" };

/** "⌘⇧P" style label, showing the chord's advertised alias when the environment calls for it
 * (⌘⇧E on Firefox, ⌘N and ⌃Tab in an installed PWA). Other aliases stay unadvertised. */
export function chordLabel(id: ChordId, env: ChordEnv = {}): string {
  const c = chordOf(id);
  const shown = CHORD_LABELS[id];
  const key = shown.advertise && env[shown.advertise.when] ? shown.advertise.key : c.key;
  const text = key === "1-9" ? "1-9" : (KEY_NAMES[key] ?? key.toUpperCase());
  // the ⌃ alias brings its own modifiers: ⌃⇧Tab is the previous worktree though ⌥↑ has no ⇧
  const alias = key !== c.key && key === c.ctrlAlias?.key ? c.ctrlAlias : undefined;
  if (alias) return `⌃${alias.shift ? "⇧" : ""}${text}`;
  return `${c.alt ? "⌥" : c.ctrl ? "⌃" : "⌘"}${c.shift ? "⇧" : ""}${text}`;
}

/** the shortcuts card's rows, in section order; a hidden chord keeps its wording and stays off */
export function chordsInSection(section: ChordSection): ChordId[] {
  return (Object.keys(CHORD_LABELS) as ChordId[]).filter(
    (id) => CHORD_LABELS[id].section === section && !CHORD_LABELS[id].hidden,
  );
}
