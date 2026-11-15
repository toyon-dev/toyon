import { STORAGE } from "../../state/keys.ts";
import { usePersisted } from "../../ui/hooks.ts";
import { type TabItem, Tabs } from "../../ui/Tabs.tsx";
import { tip } from "../../ui/Tooltip.tsx";

/** the width under which two columns are each too short to read: Monaco's own breakpoint for
 * falling back to one column, the rendered page's, and the test for whether turning the split on
 * takes the chat's room first. One number, so the pane never shuts the chat for a split it would
 * not draw, and never draws one column in room it could have made. */
export const SPLIT_MIN = 900;

/** whether a diff draws the old text beside the new, as code or as the page it renders: a choice
 * about this window's panes, as the wrap is, so it is kept with the pane's height and not the file */
export function useSplit(): readonly [boolean, (on: boolean) => void] {
  return usePersisted(STORAGE.editorSplit, false, (raw) => (raw === null ? undefined : raw === "1"));
}

/** how the head shows a changed file: its diff in one column or in two, or the file alone */
export type DiffSeat = "inline" | "split" | "file";

const FILE: TabItem<DiffSeat> = { id: "file", label: "file", tip: tip("File: as it is now, with no diff") };
const INLINE: TabItem<DiffSeat> = { id: "inline", label: "inline", tip: tip("Inline: old and new in one column") };
const SPLIT: TabItem<DiffSeat> = {
  id: "split",
  label: "split",
  tip: tip("Split: old beside new, taking the chat's room when the pane is too narrow for both"),
};
/** the split seat where a split was asked for and the pane is too narrow to draw it: the seat is
 * not lit, so its tip says why and what a press does */
const SPLIT_NARROW: TabItem<DiffSeat> = {
  ...SPLIT,
  tip: tip(`Split: old beside new, once the pane is ${SPLIT_MIN}px wide. A press takes the chat's room if it is open`),
};

/** The head's one answer about a changed file: three seats and not a switch beside a layout,
 * since a layout is only ever a diff's, and the file with no diff over it is the third way to
 * read the change, named for what is seen and not as the diff turned off. The seats run in the
 * order the change is added to what is seen: the file, its diff in the same column, its old side
 * in a column of its own. `at` is the layout drawn, so the lit seat and the body always agree.
 * `columns` is off where there is no second column to offer, a phone's screen; `narrow` says a
 * split is asked for and waiting on the pane's width. */
export function DiffSeats({
  at,
  onPick,
  columns = true,
  narrow = false,
}: {
  at: DiffSeat;
  onPick: (seat: DiffSeat) => void;
  columns?: boolean;
  narrow?: boolean;
}) {
  return (
    <span className="editor-pair">
      <Tabs
        items={columns ? [FILE, INLINE, narrow ? SPLIT_NARROW : SPLIT] : [FILE, INLINE]}
        current={at}
        onPick={(id) => {
          if (id !== at) onPick(id);
        }}
        segmented
        dense
        font="mono"
        label="the diff"
        owner="pane"
      />
    </span>
  );
}
