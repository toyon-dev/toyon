import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import "./status.css";

/**
 * A status: the dress a view in the centre wears when the machine is speaking rather than a
 * person. It is the state the centre is in whenever it cannot show their app, which covers both
 * ends of a range that used to be three different idioms: a log still scrolling while dev servers
 * come up, and a standing fact like a project having nothing to run at all.
 *
 * It is anchored to the top of the region, because it grows while it is being read and anything
 * that centres it vertically pushes the lines already under someone's eye. Its column sits where
 * every other view's does; that costs nothing, since the width is fixed and the horizontal position
 * never moves as content arrives, and pinned to the corner instead a one-line status read as a
 * stray log line rather than as the app saying where things stand.
 *
 * Prose in the UI face, mono only for evidence (`status-tail`). No card: a ground drawn around a
 * clone's progress is a box around the machine's own voice, which `Import` wore for a year.
 */
export function Status({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("status", className)}>{children}</div>;
}
