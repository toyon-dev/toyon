// The remarks on a worktree's PR, as their page lays them out and as the composer's chip hands
// one to the agent. The chip goes as a paste named for who wrote it, with the file and line in its
// text: a paste with a source would tell the agent the text is those lines of the file, and it is
// not.

import type { PrComment } from "@toyon/shared";

/** a line comment and the answers to it, oldest first; a review is a thread with none */
export interface PrThread {
  root: PrComment;
  replies: PrComment[];
}

/** the page: the reviews' own words first, then each file's threads by line */
export interface PrPage {
  reviews: PrThread[];
  files: { path: string; threads: PrThread[] }[];
}

export function prPage(comments: readonly PrComment[]): PrPage {
  const reviews: PrThread[] = [];
  const threads = new Map<string, PrThread>();
  const byPath = new Map<string, PrThread[]>();
  for (const c of [...comments].sort((a, b) => a.at - b.at)) {
    if (c.review) {
      reviews.push({ root: c, replies: [] });
      continue;
    }
    // GitHub names a thread's first comment on every answer, so one look finds it
    const parent = c.replyTo ? threads.get(c.replyTo) : undefined;
    if (parent) {
      parent.replies.push(c);
      continue;
    }
    const thread = { root: c, replies: [] };
    threads.set(c.id, thread);
    const path = c.path ?? "";
    byPath.set(path, [...(byPath.get(path) ?? []), thread]);
  }
  const files = [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, list]) => ({ path, threads: list.sort((a, b) => (a.root.line ?? 0) - (b.root.line ?? 0)) }));
  return { reviews, files };
}

/** the lines a remark is on, as a range when it spans several */
export const remarkLines = (c: Pick<PrComment, "line" | "startLine">): string | null =>
  c.line === undefined ? null : c.startLine !== undefined ? `${c.startLine}-${c.line}` : String(c.line);

/** what a review decided, in the words its head says it */
export function reviewVerb(review: PrComment["review"]): string {
  if (review === "changes_requested") return "requested changes";
  if (review === "approved") return "approved";
  return "reviewed";
}

const quoted = (body: string) =>
  body
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

/** the thread as the agent reads it: who, where, the link, and each remark quoted */
export function threadText({ root, replies }: PrThread): string {
  const lines = remarkLines(root);
  const where = root.path
    ? `${root.path}${lines ? ` ${root.startLine === undefined ? "line" : "lines"} ${lines}` : ""}`
    : null;
  const head = root.review
    ? `${root.author} ${root.review === "changes_requested" ? "requested changes on" : reviewVerb(root.review)} the pull request`
    : where
      ? `${root.author} commented on ${where} in the pull request`
      : `${root.author} commented on the pull request`;
  const parts = [`${head}, ${root.url}`];
  if (root.body) parts.push(quoted(root.body));
  for (const r of replies) parts.push(`${r.author} replied:\n${quoted(r.body)}`);
  return parts.join("\n\n");
}

/** the chip's name: the file and line it is on and who wrote it, or whose review it is */
export function threadName({ root }: PrThread): string {
  if (!root.path) return `review from ${root.author}`;
  const file = root.path.slice(root.path.lastIndexOf("/") + 1);
  const lines = remarkLines(root);
  return `${file}${lines ? ` (${lines})` : ""} from ${root.author}`;
}

/** the line over the box: how many, and whose */
export function commentsLine(count: number, authors: readonly string[]): { count: string; rest: string } {
  const who =
    authors.length === 0
      ? ""
      : authors.length <= 2
        ? ` from ${authors.join(" and ")}`
        : ` from ${authors[0]} and ${authors.length - 1} others`;
  return { count: `${count} ${count === 1 ? "comment" : "comments"}`, rest: who };
}
