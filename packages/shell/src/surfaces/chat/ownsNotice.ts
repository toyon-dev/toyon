import { ownedBy, type ProcSource } from "@toyon/shared";

/** The line under the box when a worktree starts running a shared command itself: one sentence
 * per command that just flipped, by why it did. Nothing for a press, since the person did it, and
 * nothing when no flip is left to say. */
export function ownsNotice(added: string[], sources: Record<string, ProcSource> | undefined): string | null {
  const lines: string[] = [];
  for (const name of added) {
    const why = ownedBy(sources?.[name]?.at);
    if (!why || why.by === "hand") continue;
    if (why.by === "agent") {
      lines.push(`Running its own ${name} here now: the agent asked for it before changing the backend.`);
    } else {
      lines.push(`Running its own ${name} here now: this branch changed ${why.file ?? "it"}.`);
    }
  }
  return lines.length > 0 ? lines.join(" ") : null;
}
