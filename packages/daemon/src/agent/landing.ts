// The landing question: after a finished turn, does the work read as done, and what would its
// commit message be. One quick-model call per landable turn, parsed into a verdict and a message.
// Pure, like recap.ts: the prompt is built from transcript slices and git's own summary of the diff.

import type { TurnSlice } from "./recap.ts";
import { clip } from "./recap.ts";

export const LAND_SYSTEM =
  "You judge whether a coding task is finished and write its commit message. Reply in exactly the format asked, nothing else.";

const LAND_ASK = [
  "A coding agent just stopped in a git worktree. Decide whether the work is finished and ready to merge, or still in progress: a question the agent is waiting on, a step it said it would do next, or a part of the request it did not get to.",
  "The agent never commits: every change is left uncommitted for the user, and the agent saying so is normal, not a sign the work is unfinished.",
  "Reply with exactly this shape and nothing else:",
  "Line 1: READY, or NOT READY: <reason under 12 words>",
  "Line 2: blank",
  "Line 3: a commit subject under 60 characters, lowercase, imperative, in the style of the recent subjects when given",
  "Line 4: blank",
  "Then: a short body, 1 to 4 plain sentences on what changed and why. No markdown, no bullets, no dashes as punctuation.",
].join("\n");

export interface LandInput {
  title: string;
  firstAsk?: string | undefined;
  turns: readonly TurnSlice[];
  /** `git diff --stat` of everything that would be committed, plus the untracked files */
  diffStat: string;
  /** the newest subjects on the branch, so the message reads like the repo's own */
  recentSubjects: string[];
}

const LAND_TURNS = 4;
const LAND_CHARS = 5_000;

export function landPrompt(i: LandInput): string {
  const head = [LAND_ASK, "", `Task: ${clip(i.title, 200)}`];
  if (i.firstAsk) head.push(`First request: ${clip(i.firstAsk, 300)}`);
  if (i.recentSubjects.length)
    head.push(`Recent commit subjects:\n${i.recentSubjects.map((s) => `  ${s}`).join("\n")}`);
  const diff = `Diff summary:\n${i.diffStat.trim() || "(none)"}`;
  let blocks = i.turns.slice(-LAND_TURNS).map(turnBlock);
  const size = () => [...head, "", ...blocks, "", diff].join("\n\n").length;
  while (blocks.length > 1 && size() > LAND_CHARS) blocks = blocks.slice(1);
  return [head.join("\n"), blocks.join("\n\n"), diff].join("\n\n");
}

function turnBlock(t: TurnSlice): string {
  const lines: string[] = [];
  if (t.asks.length) lines.push(`User asked: ${clip(t.asks.join(" / "), 400)}`);
  if (t.reply.trim()) lines.push(`Agent ended with: ${clip(t.reply, 1_000)}`);
  return lines.join("\n");
}

export interface LandVerdict {
  ready: boolean;
  why?: string;
  subject?: string;
  body?: string;
}

/** the subject as the commit hook wants it: one line, short, no trailing stop */
const SUBJECT_MAX = 72;

/** A model's reply as a verdict and a message, or null when it did not follow the shape. Copy
 * rules apply to what lands in git and in the box: dashes as punctuation and arrows go. */
export function parseLanding(text: string | null): LandVerdict | null {
  if (!text) return null;
  const lines = text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/[`*]/g, "")
    .split("\n")
    .map(plain);
  const first = lines.find((l) => l.trim())?.trim() ?? "";
  const verdict = /^not\s*ready\b/i.test(first) ? "not" : /^ready\b/i.test(first) ? "ready" : null;
  if (!verdict) return null;
  const why = verdict === "not" ? first.replace(/^not\s*ready\s*:?\s*/i, "").trim() : "";
  // the rest, blank-separated: the subject is the first paragraph, the body the ones after
  const rest = lines.slice(lines.indexOf(lines.find((l) => l.trim() === first) ?? "") + 1);
  const paragraphs = rest
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const subject = paragraphs[0]
    ?.replace(/\s+/g, " ")
    .replace(/^(subject|title)\s*:\s*/i, "")
    .replace(/[.]+$/, "")
    .slice(0, SUBJECT_MAX)
    .trim();
  const body = paragraphs
    .slice(1)
    .join("\n\n")
    .replace(/^(body)\s*:\s*/i, "")
    .trim();
  return {
    ready: verdict === "ready",
    ...(why ? { why: clip(why, 120) } : {}),
    ...(subject && subject.split(" ").length >= 2 ? { subject } : {}),
    ...(body ? { body: body.slice(0, 1_500) } : {}),
  };
}

/** dashes used as punctuation, arrows and ellipses read as machine copy: the same scrub the recap does */
function plain(line: string): string {
  return line
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2") // prose-ignore: the dashes being scrubbed
    .replace(/\s*[–—]\s*/g, ", ") // prose-ignore: the dashes being scrubbed
    .replace(/\s+--\s+/g, ", ")
    .replace(/\s*(→|->)\s*/g, " to ")
    .replace(/…/g, "...");
}
