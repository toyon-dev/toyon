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
  | "pull";

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
