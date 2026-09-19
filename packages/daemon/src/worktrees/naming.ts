import { randomBytes } from "node:crypto";

export function shortId(): string {
  return randomBytes(5).toString("hex");
}

/** first three words of the prompt as a branch-safe slug; random suffix unless the caller dedupes. */
export function slugify(prompt: string, withRandom = true): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  const base = words.join("-").slice(0, 20).replace(/-+$/g, "") || "task";
  return withRandom ? `${base}-${randomBytes(2).toString("hex")}` : base;
}

/** The first words of the prompt, as the title the task keeps until the agent names it. Words with
 * their spaces left in: only the branch has to be spelled the way git spells things, and it carries
 * the slug for that. Held to about what the rail shows. */
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
