import "./icon.css";
/* every drawn glyph in the UI comes from here: same 16px box, drawn to fill a 12px square, same
   1.3 stroke, so a row of them reads as one family. Font glyphs each brought their own weight and
   optical size, and a glyph drawn to 11px sits visibly smaller next to one drawn to 12.
   Set inline with text (a badge, a button label) it needs `className="icon-inline"`. */
export type IconName =
  | "branch"
  | "chat"
  | "settings"
  | "zen"
  | "back"
  | "forward"
  | "reload"
  | "pick"
  | "terminal"
  | "close"
  | "edit"
  | "check"
  | "split"
  | "full"
  | "more"
  | "caret"
  | "stop"
  | "external"
  | "plus"
  | "download"
  | "layers"
  | "pull"
  | "text"
  | "folder"
  | "book"
  | "trash"
  | "move"
  | "search"
  | "run"
  | "spark"
  | "globe"
  | "swap"
  | "palette"
  | "worktrees"
  | "lock"
  | "pr"
  | "dot";

const ICON_PATHS: Record<IconName, string> = {
  branch:
    "M4.5 5.1v5.8 M11.5 6.6c0 2.6-7 1.6-7 4.3 M4.5 1.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M4.5 10.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M11.5 3.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z",
  chat: "M2.5 3.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3.2 2.6V11H4a1.5 1.5 0 0 1-1.5-1.5z",
  // eight-tooth gear on a 12px box, hub as a ring
  settings:
    "M12.38 6.99 14.05 7.26 14.05 8.74 12.38 9.01 11.82 10.38 12.81 11.76 11.76 12.81 10.38 11.82 9.01 12.38 8.74 14.05 7.26 14.05 6.99 12.38 5.62 11.82 4.24 12.81 3.19 11.76 4.18 10.38 3.62 9.01 1.95 8.74 1.95 7.26 3.62 6.99 4.18 5.62 3.19 4.24 4.24 3.19 5.62 4.18 6.99 3.62 7.26 1.95 8.74 1.95 9.01 3.62 10.38 4.18 11.76 3.19 12.81 4.24 11.82 5.62z M8 6.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z",
  zen: "M2 6V3a1 1 0 0 1 1-1h3 M10 2h3a1 1 0 0 1 1 1v3 M14 10v3a1 1 0 0 1-1 1h-3 M6 14H3a1 1 0 0 1-1-1v-3",
  back: "M9.5 3.5 5 8l4.5 4.5",
  forward: "M6.5 3.5 11 8l-4.5 4.5",
  reload: "M13.5 2.5v3.5H10 M12.4 9.2a4.8 4.8 0 1 1-1-4.9l2.1 1.7",
  // crosshair: ring with four ticks
  pick: "M8 4.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 1 0 0-7.6z M8 1.5v2.7 M8 11.8v2.7 M1.5 8h2.7 M11.8 8h2.7",
  // a prompt: chevron + cursor line
  terminal:
    "M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z M4.8 5.6 7.4 8l-2.6 2.4 M8.6 10.6h2.8",
  close: "M4.2 4.2 11.8 11.8 M11.8 4.2 4.2 11.8",
  // pencil on the same diagonal as the crosshair ticks, with the nib split off
  edit: "M10.6 2.6 13.4 5.4 5.8 13H3v-2.8z M9.2 4l2.8 2.8 M3 10.2l2.8 2.8",
  check: "M3.4 8.4 6.4 11.4 12.6 4.6",
  // a pane with a divider (split) and the same pane without one (full height)
  split: "M2.5 2.5h11v11h-11z M2.5 8h11",
  full: "M2.5 2.5h11v11h-11z",
  // zero-length segments: round caps draw them as dots
  more: "M4 8h0.01 M8 8h0.01 M12 8h0.01",
  caret: "M4.5 6.5 8 10l3.5-3.5",
  stop: "M4.5 4.5h7v7h-7z",
  // arrow leaving a pane, for a link that opens outside the app
  external: "M9 3h4v4 M13 3 8 8 M11.5 9.5V13H3V4.5h3.5",
  plus: "M8 3.5v9 M3.5 8h9",
  download: "M8 2.5v7.4 M4.9 6.8 8 9.9l3.1-3.1 M3 13h10",
  // plain down arrow: bring main's commits into this worktree (download has the tray, and means
  // saving a file)
  pull: "M8 3.2v7.4 M4.9 7.4 8 10.6l3.1-3.2",
  // two stacked panes: a worktree that is a local merge of several branches
  layers: "M6 2.5h7.5V10 M2.5 6h8v7.5h-8z",
  text: "M3.5 3.5h9 M3.5 6.5h9 M3.5 9.5h9 M3.5 12.5h5",
  // a folder with its tab: somewhere on disk, as opposed to a project the daemon already knows
  folder: "M2.2 3.9a1 1 0 0 1 1-1h2.9l1.5 1.7h5.2a1 1 0 0 1 1 1v5.9a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z",
  // an open book: a file the agent read but did not change (edit is the pencil). A sheet with a
  // turned corner is what every "new file" button draws, and a page with a lens on it says grep,
  // which is the magnifier's job
  book: "M8 4.6c-1.2-1-2.7-1.4-4.4-1.3v7.6c1.7-.1 3.2.3 4.4 1.3 1.2-1 2.7-1.4 4.4-1.3V3.3c-1.7-.1-3.2.3-4.4 1.3z M8 4.6v8.6",
  trash:
    "M3.6 4.6h8.8 M6.4 4.6V3.2a.7.7 0 0 1 .7-.7h1.8a.7.7 0 0 1 .7.7v1.4 M5 4.6l.55 8.1a.9.9 0 0 0 .9.84h3.1a.9.9 0 0 0 .9-.84L11 4.6",
  // one arrow across the box: a file leaving one path for another
  move: "M2.8 8h9.2 M8.9 4.9 12 8l-3.1 3.1",
  search: "M7.2 2.6a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 1 0 0-9.2z M10.5 10.5 13.5 13.5",
  // a bare prompt: the chevron and cursor of `terminal` without the pane, so a run row and the
  // terminal button do not read as the same control
  run: "M3.4 4.2 7.6 8l-4.2 3.8 M9 11.8h4",
  // four-point sparkle for a thought: no other icon here has curves this wide
  spark: "M8 2.6c0 2.6 1.4 4.6 4.6 5.4-3.2.8-4.6 2.8-4.6 5.4 0-2.6-1.4-4.6-4.6-5.4 3.2-.8 4.6-2.8 4.6-5.4z",
  // one equator and one meridian: a second latitude line filled the circle in at 13px
  globe: "M8 2.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 1 0 0-11.6z M2.2 8h11.6 M8 2.2c-3 3.4-3 8.2 0 11.6 3-3.4 3-8.2 0-11.6z",
  // the rail's own rows: a status dot and a name, three deep. The panel toggles name what is in
  // the panel (branch for changes, chat for chat), never the shape of the panel itself
  worktrees:
    "M3.8 2.95a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 1 0 0-2.1z M7.4 4h5.4 M3.8 6.95a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 1 0 0-2.1z M7.4 8h5.4 M3.8 10.95a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 1 0 0-2.1z M7.4 12h5.4",
  // two arrows passing: swapping one mode for another
  swap: "M3 6.2h9.2 M9.7 3.7 12.2 6.2 9.7 8.7 M13 10.2H3.8 M6.3 7.7 3.8 10.2l2.5 2.5",
  // A painter's palette: the blob with its thumb notch, and three wells. The wells are small and
  // spread on purpose; at r .75 they were wider than the gap between them and merged into one
  // smear at 16px, which is the only size this is ever drawn at.
  palette:
    "M2.3 8.4C2.3 4.7 5 2.2 8.5 2.2c3.4 0 5.2 2.2 5.2 4.6 0 1.9-1.4 2.6-2.7 2.8-.9.15-1.3.7-1.1 1.4.2.9-.5 2.2-2.1 2.2-3.2 0-5.5-2-5.5-4.8z M5 6.2a.5.5 0 1 0 0 1 .5.5 0 1 0 0-1z M7.8 4.9a.5.5 0 1 0 0 1 .5.5 0 1 0 0-1z M11 5.8a.5.5 0 1 0 0 1 .5.5 0 1 0 0-1z",
  // another tool holds this worktree. The shackle is drawn closed: a lock that reads as open says
  // the opposite of what the row means.
  lock: "M4.4 7.3h7.2v6.1H4.4z M6.2 7.3V5.5a1.8 1.8 0 0 1 3.6 0v1.8",
  // a pull request: the branch glyph's left rail, and a second rail arriving from the right with
  // an arrowhead, which is the one thing that separates it from `branch` at 16px
  pr: "M4.5 5.1v5.8 M4.5 1.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M4.5 10.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M11.5 10.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M11.5 10.9V6.6a2 2 0 0 0-2-2H8 M9.6 2.9 7.9 4.6l1.7 1.7",
  // a step that happened under a name we cannot read: a marker, deliberately without a meaning
  dot: "M8 4.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 1 0 0-6.8z",
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
