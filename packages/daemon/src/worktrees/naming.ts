import { randomBytes } from "node:crypto";

export function shortId(): string {
  return randomBytes(5).toString("hex");
}

/** first four words of the prompt as a branch-safe slug; random suffix unless the caller dedupes */
export function slugify(prompt: string, withRandom = true): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const base = words.join("-").slice(0, 40) || "task";
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

/** perspective-diverse variants: same goal, different emphasis per attempt */
export const VARIANT_LENSES = [
  "(You are attempt 1 of several parallel attempts at this task. Take the straightforward, balanced approach: the version most people would expect.)",
  "(You are attempt 2 of several parallel attempts at this task. Take a bolder visual/design-led approach: prioritize form, polish, and delight.)",
  "(You are attempt 3 of several parallel attempts at this task. Take a function-led approach: prioritize capability, detail, and edge cases over visual flair.)",
];
