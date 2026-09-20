// The landing question: after a finished turn, does the work read as done, where does it stand in
// one sentence, and what would its commit message be. One quick-model call per landable turn,
// parsed into a verdict, a recap and a message. A turn that finishes with nothing to land gets the
// smaller answer question instead: the sentence alone, since there is no verdict to give and no
// message to write. Pure, like recap.ts: the prompt is built from transcript slices and git's own
// summary of the diff.

import type { TurnSlice } from "./recap.ts";
import { clip, parseRecap } from "./recap.ts";

export const LAND_SYSTEM =
  "You judge whether a coding task is finished, recap where it stands, and write its commit message. Reply in exactly the format asked, nothing else.";

const LAND_ASK = [
  "A coding agent just stopped in a git worktree. Decide whether the work is finished and ready to merge, or still in progress: a question the agent is waiting on, a step it said it would do next, or a part of the request it did not get to.",
  "The agent never commits: every change is left uncommitted for the user, and the agent saying so is normal, not a sign the work is unfinished.",
  "Reply with exactly this shape and nothing else:",
  "Line 1: READY, or NOT READY: <reason under 12 words>",
  "Line 2: blank",
  "Line 3: Recap: one sentence under 20 words for the user coming back to this task, saying what the task is and then what just happened or what to do next. Skip root-cause narrative, fix internals and secondary to-dos.",
  "Line 4: blank",
  "Line 5: a commit subject under 60 characters, lowercase, imperative, in the style of the recent subjects when given",
  "Line 6: blank",
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

export const ANSWER_SYSTEM = "You recap where a coding task stands in one sentence. Reply with the sentence only.";

const ANSWER_ASK = [
  "A coding agent just replied in a git worktree without changing any files: it answered a question, reviewed something, or explained what it found.",
  "Write one sentence under 20 words for the user coming back to this task, saying what was asked and what the agent answered or recommended. Skip narrative and secondary points. No markdown, no dashes as punctuation.",
].join("\n");

export type AnswerInput = Pick<LandInput, "title" | "firstAsk" | "turns">;

/** the answer question: the same turns the landing question reads, with no diff to describe */
export function answerPrompt(i: AnswerInput): string {
  const head = [ANSWER_ASK, "", `Task: ${clip(i.title, 200)}`];
  if (i.firstAsk) head.push(`First request: ${clip(i.firstAsk, 300)}`);
  let blocks = i.turns.slice(-LAND_TURNS).map(turnBlock);
  const size = () => [...head, "", ...blocks].join("\n\n").length;
  while (blocks.length > 1 && size() > LAND_CHARS) blocks = blocks.slice(1);
  return [head.join("\n"), blocks.join("\n\n")].join("\n\n");
}

export interface LandVerdict {
  ready: boolean;
  why?: string;
  /** where the work stands, as the one sentence the composer and the rail row read */
  recap?: string;
  subject?: string;
  body?: string;
}

/** the subject as the commit hook wants it: one line, short, no trailing stop */
const SUBJECT_MAX = 72;

/** A model's reply as a verdict, a recap and a message, or null when it did not follow the shape.
 * Copy rules apply to what lands in git and in the box: dashes as punctuation and arrows go. */
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
  // the rest, blank-separated: the recap, then the subject, then the body. A model that skips the
  // recap leaves its label out too, and one paragraph alone is read as the subject, since a
  // message is what the land presses on.
  const rest = lines.slice(lines.indexOf(lines.find((l) => l.trim() === first) ?? "") + 1);
  const paragraphs = rest
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const hasRecap = /^recap\s*:/i.test(paragraphs[0] ?? "") || paragraphs.length >= 3;
  const recap = hasRecap ? parseRecap(paragraphs[0] ?? null) : null;
  const message = hasRecap ? paragraphs.slice(1) : paragraphs;
  const subject = message[0]
    ?.replace(/\s+/g, " ")
    .replace(/^(subject|title)\s*:\s*/i, "")
    .replace(/[.]+$/, "")
    .slice(0, SUBJECT_MAX)
    .trim();
  const body = message
    .slice(1)
    .join("\n\n")
    .replace(/^(body)\s*:\s*/i, "")
    .trim();
  return {
    ready: verdict === "ready",
    ...(why ? { why: clip(why, 120) } : {}),
    ...(recap ? { recap } : {}),
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
