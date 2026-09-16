import { randomBytes } from "node:crypto";

export function shortId(): string {
  return randomBytes(5).toString("hex");
}

/** first three words of the prompt as a branch-safe slug; random suffix unless the caller dedupes.
 * It stays the title when naming fails, so it is held to about what the rail shows. */
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

/** a user- or model-supplied title as a branch-safe slug ("" when nothing survives) */
export function cleanTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
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
