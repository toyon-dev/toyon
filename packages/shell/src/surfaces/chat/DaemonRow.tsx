import { type HTMLAttributes, type ReactNode, useEffect, useState } from "react";
import { Icon, type IconName } from "../../ui/Icon.tsx";
import { spanWords } from "../util.ts";

/** the clock time behind a row's age, for its tip */
const AT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** How long ago a row's news happened, as its sentence says it: "22 minutes ago". The age is
 * coarse, so a reading a minute old is the oldest the row can show. */
export function useAgo(at: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return `${spanWords(now - at)} ago`;
}

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
  /** when the news happened, for a row that is news of the worktree and says its age with
   * `useAgo`: the tip gives the clock time the age rounds off. A row inside a turn (a refused
   * call) takes none, since nothing else in a turn is timed. The tip is the word's, not the
   * row's: the row spans the log, so a tip on it came up on every pass of the pointer from the
   * transcript to the composer and, trailing the pointer, lay over the next message. */
  at?: number;
  /** what goes under the sentence, in the dimmer tier, one line each: the reason a call was
   * refused, how a landing went and when, the branch a grafted chat was on. The row draws the
   * lines, so every caller's byline is the same byline. */
  below?: ReactNode | ReactNode[];
  children?: ReactNode;
};

/** A row the daemon writes into the transcript itself, as opposed to one the agent or the person
 * wrote. One box for all of them: it spans the log the way a tool row does, so its edge stands on
 * the open band's edge and its glyph on the tool rows' glyph column, and the word beside the glyph
 * is not the odd row out in a scrolled-back turn. The word is a column of its own: the sentence
 * and every line under it start where the sentence starts, so a byline reads as the sentence's
 * and not as a second thing said beside the word. */
export function DaemonRow({ icon, word, tone, at, below, children, ...rest }: Props) {
  const tip = at !== undefined ? { "data-tip": `${word} ${AT.format(at)}`, "data-tip-placement": "top" } : null;
  const lines = (Array.isArray(below) ? below : [below]).filter((l) => l !== undefined && l !== null && l !== false);
  return (
    <div {...rest} className="daemon-row row-edge" data-tone={tone}>
      <div className="daemon-head">
        <span {...tip} className="daemon-tag">
          <Icon name={icon} className="icon-inline" />
          {word}
        </span>
        <div className="daemon-body">
          <div className="daemon-line">{children}</div>
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, built whole from the record
            <div key={i} className="daemon-below row-dim">
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
