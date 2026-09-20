import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function shortId(): string {
  return randomBytes(5).toString("hex");
}

/** A record id and, from its first four characters, the directory a worktree toyon makes lives in
 * and the branch it is born on: `wt-xxxx`, with no directory of that name under `parent` yet. An id
 * rather than words from the prompt because the directory outlives every name (a rename moves the
 * branch, never the checkout, or the procs and the agent's cwd would restart) and the words a
 * prompt opens with are filler; the title says what the task is, and the branch takes its slug once
 * it is named. The directory is the record id's head so a terminal prompt and a log line about the
 * same worktree are recognisable as each other. Only the directory is checked: toyon deletes its
 * own branches with their worktrees, so a `toyon/wt-xxxx` left over is a hand-made one, and the
 * branch step fails with git's words before anything changes. */
export function freeSlot(parent: string): { id: string; dir: string } {
  for (;;) {
    const id = shortId();
    const dir = `wt-${id.slice(0, 4)}`;
    if (!existsSync(join(parent, dir))) return { id, dir };
  }
}

/** The first words of the prompt, as the title the task keeps until the agent names it. Words with
 * their spaces left in: nothing is spelled from the title, so it never has to be spelled git's way.
 * Held to about what the rail shows. */
export function titleFrom(prompt: string): string {
  const words = prompt.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
  return sentenceCase(cleanTitle(words) || "task");
}

/** a user- or model-supplied title as a person reads it: one line, no control characters, nothing
 * hanging off either end ("" when nothing survives). Only control characters go: a zero-width
 * joiner is part of an emoji or a word in Persian, not noise. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .slice(0, 40)
    .replace(/^[\s:;,.!?]+|[\s:;,.!?]+$/g, "");
}

/** A title as the tail of a branch name. Git refuses spaces and most punctuation, so a branch never
 * carries the title itself; the two only have to stay recognisable as each other. "" when nothing
 * survives (a title written in a script git cannot spell), and then the branch stays where it is. */
export function branchSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** first letter up: a title is read as a title, and the prompt and the agent both answer lowercase */
export function sentenceCase(title: string): string {
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// The lens rides last in the user's own message, so it outweighs the system prompt's scope rule
// wherever the two disagree: each lens changes what an attempt leans toward, never how much it
// changes, and the task may be prose as easily as UI.
const VARIANT_LENSES = [
  "Take the most direct approach: the change most people would expect, in the smallest diff.",
  "Lean toward how it looks and reads: polish what the task touches using only the design tokens, components and voice the project already has. Add no new colours, fonts or effects, and restyle nothing outside the task.",
  "Lean toward behaviour: edge cases, empty and error states, and what can go wrong, over visual change.",
];

/** the note that follows a variant's first prompt: which attempt it is, the shared bounds, its lens */
export function variantLens(index: number): string {
  const lens = VARIANT_LENSES[(index - 1) % VARIANT_LENSES.length];
  return `(You are attempt ${index} of several parallel attempts at this task. Stay within the task and follow the project's existing styles, components, tokens and writing conventions; the attempts differ in emphasis, not in how much they change. ${lens})`;
}
