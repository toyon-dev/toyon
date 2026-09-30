import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "../../ui/Icon.tsx";

/** the edge's colour, and the tag's: red for a call toyon refused, the accent for the divider where
 * a merged worktree's chat begins, the aqua that says "landed" everywhere else for a land, and the
 * quiet ink for the archive's comings and goings, which are news of the worktree and not of the
 * work */
export type DaemonTone = "red" | "accent" | "aqua" | "quiet";

type Props = Omit<HTMLAttributes<HTMLDivElement>, "className"> & {
  icon: IconName;
  /** the one word toyon writes beside the glyph: blocked, grafted, landed */
  word: string;
  tone: DaemonTone;
  /** a second line under the head, in the dimmer tier: the reason a call was refused */
  below?: ReactNode;
  children?: ReactNode;
};

/** A row the daemon writes into the transcript itself, as opposed to one the agent or the person
 * wrote. One box for all of them: it spans the log the way a tool row does, so its edge stands on
 * the open band's edge and its glyph on the tool rows' glyph column, and the word beside the glyph
 * is not the odd row out in a scrolled-back turn. */
export function DaemonRow({ icon, word, tone, below, children, ...rest }: Props) {
  return (
    <div {...rest} className="daemon-row row-edge" data-tone={tone}>
      <div className="daemon-head">
        <span className="daemon-tag">
          <Icon name={icon} className="icon-inline" />
          {word}
        </span>
        {children}
      </div>
      {below}
    </div>
  );
}
