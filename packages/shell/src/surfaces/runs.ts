import { type RunKind, type RunState, type RunStatus, shortDuration, type WorktreeStatus } from "@toyon/shared";
import { elapsed } from "./util.ts";

/**
 * The wait on a run (setup, the check, a commit with its hooks), in words. A run is a process
 * that can take twenty minutes on a real suite, so the line under the word it stands behind says
 * three things: what it is on, how long it has been against its ceiling, and whether it is still
 * being watched. Pure, the way rowLine is: the fields are the whole logic, and the test holds them.
 */

/** the run of that kind on the row, if the daemon lists one */
export function runOf(w: Pick<WorktreeStatus, "worktree"> | null | undefined, kind: RunKind): RunState | undefined {
  return w?.worktree?.runs?.find((r) => r.kind === kind);
}

/** whether the run's clock is going: the count since `since` is only a wait while it is */
export function runTicking(run: RunState | undefined): boolean {
  return run?.status === "running" || run?.status === "detached";
}

/** What the line says after the word, as fields a middot joins: the stage when there is one,
 * then the time against the ceiling for a run that is going, or the word for a state that is not
 * a wait. `secs` is the caller's count since `run.since`, ticking. The detached word comes last,
 * after the count: the count is still true, and the word says why it will not be followed by an
 * end. A terminated run says only why, since the time it took is over. */
export function runFacts(run: RunState, secs: number): string[] {
  const stage = run.stage ? [run.stage] : [];
  switch (run.status) {
    case "queued":
      return [...stage, "queued"];
    case "running":
      return [...stage, `${elapsed(secs)} of ${shortDuration(run.timeoutMs)}`];
    case "detached":
      return [...stage, elapsed(secs), "detached"];
    case "terminated":
      return [run.why ?? "stopped"];
  }
}

/** the word and its facts as one line */
export function runLine(word: string, run: RunState, secs: number): string {
  return [word, ...runFacts(run, secs)].join(" · ");
}

/** what each state means, for the tip on the line: the word alone is short for a reason a
 * person meets once */
export const RUN_STATUS_TIP: Record<RunStatus, string> = {
  queued: "Asked for, not started yet.",
  running: "Running under the daemon's watch. It is killed at the ceiling.",
  detached: "The daemon restarted under it. It runs on, unwatched, until it ends or is stopped.",
  terminated: "Killed: at its ceiling, or by a stop.",
};

/** the tip for the stop on a run, naming what the press kills */
export function runStopTip(kind: RunKind): string {
  switch (kind) {
    case "setup":
      return "Stop this setup command; the next one runs";
    case "check":
      return "Stop the check; it reads as failed until it runs again";
    case "commit":
      return "Stop the commit and the hooks it is running; nothing is committed";
  }
}
