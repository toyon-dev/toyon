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

/** The shape of a name toyon gives a worktree, whoever found it: the namer's answer, a title an
 * agent hands in with a piece or a handoff, the words a prompt opens with. About what the rail
 * shows whole, so every row reads the same way whichever path named it. */
export const NAME_WORDS_MAX = 3;
export const NAME_CHARS_MAX = 20;
/** the shape as a tool or a prompt asks for it */
export const NAME_SHAPE = `1 to ${NAME_WORDS_MAX} plain words, ${NAME_CHARS_MAX} characters at most, like "sticky header"`;

/** Why a title is sent back ("runs to 4 words; a title is ..."), for the tool that took it to say
 * whose title; null within the shape. A title over the shape is refused rather than cut, since a
 * cut one is a name nobody chose. */
export function overNameShape(title: string): string | null {
  const words = title.split(/\s+/).filter(Boolean).length;
  const over =
    words > NAME_WORDS_MAX ? `${words} words` : title.length > NAME_CHARS_MAX ? `${title.length} characters` : null;
  return over && `runs to ${over}; a title is ${NAME_SHAPE}.`;
}

/** The first words of the prompt, as the title the task keeps until the agent names it. Words with
 * their spaces left in: nothing is spelled from the title, so it never has to be spelled git's way.
 * Within the name shape, dropping whole words first: a provisional title is cut where a chosen one
 * would be refused, since nobody chose it. */
export function titleFrom(prompt: string): string {
  const words = prompt.split(/\s+/).filter(Boolean).slice(0, NAME_WORDS_MAX);
  while (words.length > 1 && words.join(" ").length > NAME_CHARS_MAX) words.pop();
  return sentenceCase(cleanTitle(words.join(" ").slice(0, NAME_CHARS_MAX)) || "task");
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
