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
  | "inspect"
  | "terminal"
  | "close"
  | "edit"
  | "check"
  | "tickbox"
  | "tickbox-on"
  | "split"
  | "columns"
  | "full"
  | "more"
  | "caret"
  | "caret-up"
  | "stop"
  | "external"
  | "plus"
  | "download"
  | "copy"
  | "pull"
  | "text"
  | "wrap"
  | "file"
  | "diff"
  | "folder"
  | "book"
  | "eye"
  | "trash"
  | "move"
  | "search"
  | "run"
  | "slash"
  | "bulb"
  | "spawn"
  | "handoff"
  | "globe"
  | "swap"
  | "worktrees"
  | "lock"
  | "pr"
  | "clock"
  | "archive"
  | "attach"
  | "send"
  | "phone"
  | "laptop"
  | "devices"
  | "cube"
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
  reload: "M13.2 3.1v3.5H9.7 M12.1 9.8a4.8 4.8 0 1 1-1-4.9l2.1 1.7",
  // crosshair: ring with four ticks
  pick: "M8 4.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 1 0 0-7.6z M8 1.5v2.7 M8 11.8v2.7 M1.5 8h2.7 M11.8 8h2.7",
  // a pointer over a box left open at its corner: the devtools element select, which is what ⌘I is.
  // The crosshair stays the chat's pick, so the two buttons never read as one control in two places
  inspect: "M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3 M8.2 8.2l5.3 2-2.3.9-.9 2.3z",
  // a prompt: chevron + cursor line
  terminal:
    "M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z M4.8 5.6 7.4 8l-2.6 2.4 M8.6 10.6h2.8",
  close: "M4.2 4.2 11.8 11.8 M11.8 4.2 4.2 11.8",
  // pencil on the same diagonal as the crosshair ticks, with the nib split off
  edit: "M10.6 2.6 13.4 5.4 5.8 13H3v-2.8z M9.2 4l2.8 2.8 M3 10.2l2.8 2.8",
  check: "M3.4 8.4 6.4 11.4 12.6 4.6",
  // a tick box, empty and ticked: a row that is one of several to pick wears it, so the box is
  // there before anything is ticked. The tick is `check` drawn to stand inside the box, clear of
  // its stroke on every side at 13px, where the full-size one would cross it
  tickbox: "M4.5 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z",
  "tickbox-on": "M4.5 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M5.3 8.2 7.2 10.1 10.7 6",
  // a pane with a divider
  split: "M2.5 2.5h11v11h-11z M2.5 8h11",
  // the same pane divided the other way: two columns, for a diff drawn side by side
  columns: "M2.5 2.5h11v11h-11z M8 2.5v11",
  // the caret twice, parting up and down: a pane taking the column's whole height. The one axis
  // it grows on, so it is not the corner arrows of a window going full screen, nor zen's
  // brackets; and not a bare square, which is an empty tick box beside the set's own
  full: "M4.5 6.2 8 2.7l3.5 3.5 M4.5 9.8 8 13.3l3.5-3.5",
  // three tiny rings, each closed by the stroke into a 2.2px dot. As zero-length segments the round
  // caps drew them at the stroke's own 1.3px, the thinnest mark in any row, and they went faint on
  // every tier; at 2.5px they outweighed the plus beside them
  more: "M3.55 8a.45 .45 0 1 0 .9 0a.45 .45 0 1 0-.9 0z M7.55 8a.45 .45 0 1 0 .9 0a.45 .45 0 1 0-.9 0z M11.55 8a.45 .45 0 1 0 .9 0a.45 .45 0 1 0-.9 0z",
  caret: "M4.5 6.5 8 10l3.5-3.5",
  // the same chevron pointing up: the way back to the start of a log, opposite the way to its end
  "caret-up": "M4.5 9.5 8 6l3.5 3.5",
  stop: "M4.5 4.5h7v7h-7z",
  // an arrow up the box: the message leaves the field for the log above it
  send: "M8 13V3.2 M4 7.2 8 3.2l4 4",
  // arrow leaving a pane, for a link that opens outside the app
  external: "M9 3h4v4 M13 3 8 8 M11.5 9.5V13H3V4.5h3.5",
  plus: "M8 3.5v9 M3.5 8h9",
  download: "M8 2.5v7.4 M4.9 6.8 8 9.9l3.1-3.1 M3 13h10",
  // two sheets, the front one whole and the back one showing its top-left edge behind it
  copy: "M5.5 5.5h8v8h-8z M10.5 5.5v-3h-8v8h3",
  // plain down arrow: bring work from elsewhere into this worktree, main's commits or another
  // worktree's chat (download has the tray, and means saving a file)
  pull: "M8 4.3v7.4 M4.9 8.5 8 11.7l3.1-3.2",
  text: "M3.5 3.5h9 M3.5 6.5h9 M3.5 9.5h9 M3.5 12.5h5",
  // `text` with its second line turning back under itself: a long line folded at the edge
  wrap: "M3.5 3.5h9 M3.5 7.5h7a2 2 0 0 1 0 4H8 M9.5 10 8 11.5l1.5 1.5 M3.5 11.5h2.5",
  // a sheet with a turned corner: a file as a thing handed over, where `text` is what one holds
  file: "M4.5 2.5h4.5l2.5 2.5v8.5h-7z M9 2.5V5h2.5",
  // a plus over a minus: what changed in a file, where `text` is the file itself
  diff: "M8 3.8v5 M5.5 6.3h5 M5.5 12.2h5",
  // a folder with its tab: somewhere on disk, as opposed to a project the daemon already knows
  folder: "M2.2 3.9a1 1 0 0 1 1-1h2.9l1.5 1.7h5.2a1 1 0 0 1 1 1v5.9a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z",
  // an open book: a file the agent read but did not change (edit is the pencil). A sheet with a
  // turned corner is what every "new file" button draws, and a page with a lens on it says grep,
  // which is the magnifier's job
  book: "M8 4.6c-1.2-1-2.7-1.4-4.4-1.3v7.6c1.7-.1 3.2.3 4.4 1.3 1.2-1 2.7-1.4 4.4-1.3V3.3c-1.7-.1-3.2.3-4.4 1.3z M8 4.6v8.6",
  // an eye: see this file. An almond of two arcs with a ring for the pupil, drawn wide and short
  // so it is not a lens (search) or a ring (pick); the pupil keeps clear of the lids at 16px
  eye: "M2 8c1.6-2.9 3.6-4.3 6-4.3s4.4 1.4 6 4.3c-1.6 2.9-3.6 4.3-6 4.3S3.6 10.9 2 8z M8 6.1a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 1 0 0-3.8z",
  trash:
    "M3.6 4.6h8.8 M6.4 4.6V3.2a.7.7 0 0 1 .7-.7h1.8a.7.7 0 0 1 .7.7v1.4 M5 4.6l.55 8.1a.9.9 0 0 0 .9.84h3.1a.9.9 0 0 0 .9-.84L11 4.6",
  // one arrow across the box: a file leaving one path for another
  move: "M3.4 8h9.2 M9.5 4.9 12.6 8l-3.1 3.1",
  search: "M7.2 2.6a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 1 0 0-9.2z M10.5 10.5 13.5 13.5",
  // a bare prompt: the chevron and cursor of `terminal` without the pane, so a run row and the
  // terminal button do not read as the same control
  run: "M3.4 4.2 7.6 8l-4.2 3.8 M9 11.8h4",
  // a slash command at the prompt: `run`'s cursor line with a slash in the chevron's place, for a
  // skill, which is typed as /name. Not two stacked panes: at 13px those are `copy` mirrored
  slash: "M7.8 3.2 4 12.2 M9 11.8h3.4",
  // a bulb for a thought: the glass as one arc over two shoulders, the base as one line under
  // it. At 13px a filament or a second base line is a smudge, so there is neither.
  bulb: "M4.8 8.8a4 4 0 1 1 6.4 0L9.5 10.6v1.4H6.5v-1.4z M6.7 13.8h2.6",
  // a call that starts another agent: a ring, and a smaller ring below and to its right, nothing
  // between them. A subagent is the same kind of thing as the agent, one size down, hired for a
  // brief, and it never leaves this chat: its calls fold under this row and its report goes to
  // the agent. So no line out (that is `handoff`'s arrow), no rail under the rings (that would
  // make them commits), and no diagonal joining them, which at 16px is `search`'s handle. It
  // carries no bulb because ACP files the call under "think" and the row is not a thought.
  spawn: "M2.3 5.8a3 3 0 1 0 6 0a3 3 0 1 0-6 0z M9.4 11.4a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0-3.8 0z",
  // work leaving this chat for a sibling worktree: `branch` on its side. The rail lies flat with
  // its ring at each end (the line this chat is on, which goes on), and the same diverging curve
  // ends in an arrowhead where branch's third ring sits, run 3px past the end ring: the piece
  // leaves rather than stopping in a node of its own. One mark differs from branch, the way one
  // differs for `pr`; pr's arrow comes in, this one goes out
  handoff:
    "M1.7 4.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0z M4.9 4.5h4.6 M9.4 4.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0z M4.9 4.5c2.6 0 1.6 7 4.3 7h4 M12.1 9.7l1.8 1.8-1.8 1.8",
  // one equator and one meridian: a second latitude line filled the circle in at 13px
  globe: "M8 2.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 1 0 0-11.6z M2.2 8h11.6 M8 2.2c-3 3.4-3 8.2 0 11.6 3-3.4 3-8.2 0-11.6z",
  // the rail's own rows: a status dot and a name, three deep. The dots are solid like the rail's,
  // closed by the stroke the way `more` draws its own: a ring there was never the rail's mark,
  // and `branch`'s node size cannot sit three deep on a 4px pitch without the rings fusing. The
  // panel toggles name what is in the panel (branch for changes, chat for chat), never the shape
  // of the panel itself
  worktrees:
    "M3.15 4a.65 .65 0 1 0 1.3 0a.65 .65 0 1 0-1.3 0z M7.4 4h5.4 M3.15 8a.65 .65 0 1 0 1.3 0a.65 .65 0 1 0-1.3 0z M7.4 8h5.4 M3.15 12a.65 .65 0 1 0 1.3 0a.65 .65 0 1 0-1.3 0z M7.4 12h5.4",
  // two arrows passing: swapping one mode for another
  swap: "M3 6.2h9.2 M9.7 3.7 12.2 6.2 9.7 8.7 M13 10.2H3.8 M6.3 7.7 3.8 10.2l2.5 2.5",
  // another tool holds this worktree. The shackle is drawn closed: a lock that reads as open says
  // the opposite of what the row means.
  lock: "M4.4 6.8h7.2v6.1H4.4z M6.2 6.8V5a1.8 1.8 0 0 1 3.6 0v1.8",
  // a phone: a tall rounded body and a short bar at its foot, which is what keeps it from reading
  // as a document at 16px
  phone:
    "M5.4 2.2h5.2a1.2 1.2 0 0 1 1.2 1.2v9.2a1.2 1.2 0 0 1-1.2 1.2H5.4a1.2 1.2 0 0 1-1.2-1.2V3.4a1.2 1.2 0 0 1 1.2-1.2z M7.1 11.6h1.8",
  // a laptop, the other kind of device on a tailnet: a screen with rounded top corners over a
  // wider base line, which is what keeps it from reading as a window or a card at 16px
  laptop: "M3.4 3.4h9.2a1 1 0 0 1 1 1v6.2H2.4V4.4a1 1 0 0 1 1-1z M1.5 12.6h13",
  // the devices card, from every door to it: a screen with a phone standing in front of its right
  // edge. The screen's outline stops where the phone covers it, since two closed boxes crossing
  // read as a window over a window at 16px; the phone keeps its foot bar so it stays a phone
  devices:
    "M8.5 10.8H2.9a1 1 0 0 1-1-1V3.8a1 1 0 0 1 1-1h8.8a1 1 0 0 1 1 1v1.3 M4.3 13.2h4.2 M10.3 6.5h3a.9.9 0 0 1 .9.9v5a.9.9 0 0 1-.9.9h-3a.9.9 0 0 1-.9-.9v-5a.9.9 0 0 1 .9-.9z M11.3 11.7h1",
  // a pull request: the branch glyph's left rail, and a second rail arriving from the right with
  // an arrowhead, which is the one thing that separates it from `branch` at 16px
  pr: "M4.5 5.1v5.8 M4.5 1.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M4.5 10.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M11.5 10.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M11.5 10.9V6.6a2 2 0 0 0-2-2H8 M9.6 2.9 7.9 4.6l1.7 1.7",
  // a clock face with two hands: something toyon did on its own after a while, the rail's mark on a
  // worktree that archived itself
  clock: "M8 2.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 1 0 0-11.6z M8 4.8V8l2.2 1.4",
  // a storage box: a wide lid over a narrower body, with the short handle slot that keeps it from
  // reading as a plain card. Put away and kept, where `trash` is gone and `close` is a press
  archive: "M2.4 3.2h11.2v2.8H2.4z M3.4 6v6.1a.9.9 0 0 0 .9.9h7.4a.9.9 0 0 0 .9-.9V6 M6.6 8.6h2.8",
  // a paperclip: the one wire, turned twice
  attach:
    "M13.7 7.4 8.2 12.9a3.6 3.6 0 0 1-5.1-5.1l5.5-5.5a2.4 2.4 0 0 1 3.4 3.4l-5.5 5.5a1.2 1.2 0 0 1-1.7-1.7l5.1-5.1",
  // a box seen from a corner: a service of its own that the agent called, an MCP server's tool.
  // It says nothing about where the service runs, since one is as often a local process as a
  // host, which is why it is not a cloud; and not a plug, which reads as a plugin of the app
  cube: "M8 2.4 13.2 5.2v5.6L8 13.6 2.8 10.8V5.2z M2.8 5.2 8 8l5.2-2.8 M8 8v5.6",
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
