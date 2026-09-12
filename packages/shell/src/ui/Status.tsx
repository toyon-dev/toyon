import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import "./status.css";

/**
 * A status: the dress a view in the centre wears when the machine is speaking rather than a
 * person. It is the state the centre is in whenever it cannot show their app, which covers both
 * ends of a range that used to be three different idioms: a log still scrolling while dev servers
 * come up, and a standing fact like a project having nothing to run at all.
 *
 * It starts at the region's top left, because output reads from there and because a block that
 * grows while it is centred moves the lines a person is already reading. A form is centred and a
 * status is not, and that difference is the fastest way to see which one is talking.
 *
 * Prose in the UI face, mono only for evidence (`status-tail`). No card: a ground drawn around a
 * clone's progress is a box around the machine's own voice, which `Import` wore for a year.
 */
export function Status({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("status", className)}>{children}</div>;
}
