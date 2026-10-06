// What a command the daemon watched leaves on the transcript: a `!` command's pipes, a landing
// step's, or the output file of a command the agent sent to the background. One shape for all of
// them, so the rows read alike whoever ran the command.

import { describeDuration } from "@toyon/shared";

/** what one command may leave on the transcript. Every subscriber replays the whole file, so a
 * `cat` of something large would cost every later open of the worktree, not just this one. */
export const OUTPUT_CAP = 200_000;

/** the output as the transcript renders it: the text fenced, so it draws as a block rather than
 * as prose, and a line under it for anything the text alone would not say. A command killed at
 * its ceiling gave up, and the line says after how long when the ceiling is known. */
export function formatOutput(text: string, exit: number | string | null, truncated: boolean, ceiling?: number): string {
  const body = text.replace(/\n+$/, "");
  const notes: string[] = [];
  if (truncated) notes.push(`output cut at ${Math.round(OUTPUT_CAP / 1000)} KB`);
  if (exit === "timeout") notes.push(ceiling ? `gave up after ${describeDuration(ceiling)}` : "gave up at the ceiling");
  else if (typeof exit === "string") notes.push(`killed (${exit})`);
  else if (exit !== 0) notes.push(`exit ${exit}`);
  const parts: string[] = [];
  if (body.trim()) parts.push(`\`\`\`\n${body}\n\`\`\``);
  parts.push(...notes);
  return parts.join("\n");
}

/** what the command printed, back out of a row's stored output: the text inside the fence, with
 * the notes under it gone. The text may hold fences of its own, so the last one closes it. */
export function unformatOutput(output: string): string {
  if (!output.startsWith("```\n")) return "";
  const close = output.lastIndexOf("\n```");
  return close < 4 ? "" : output.slice(4, close);
}
