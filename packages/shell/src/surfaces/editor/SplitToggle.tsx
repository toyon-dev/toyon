import { STORAGE } from "../../state/keys.ts";
import { Button } from "../../ui/Button.tsx";
import { usePersisted } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";

/** the width under which two columns of code are each too short to read: Monaco's own breakpoint
 * for falling back to one column, and the test for whether turning the split on takes the chat's
 * room first. One number, so the pane never shuts the chat for a split it would not draw, and
 * never draws one column in room it could have made. */
export const SPLIT_MIN = 900;

/** whether a diff draws the old text beside the new: a choice about this window's panes, as the
 * wrap is, so it is kept with the pane's height and not the file */
export function useSplit(): readonly [boolean, (on: boolean) => void] {
  return usePersisted(STORAGE.editorSplit, false, (raw) => (raw === null ? undefined : raw === "1"));
}

/** the head's split switch, named for the state it switches to, as the wrap toggle beside it is */
export function SplitToggle({ split, onSplit }: { split: boolean; onSplit: (on: boolean) => void }) {
  return (
    <Button
      variant="outline"
      tone="quiet"
      mono
      className="deep-link"
      onClick={() => onSplit(!split)}
      data-tip={
        split
          ? "Inline: old and new in one column, and the chat back if the split took its room"
          : "Split: old beside new, taking the chat's room when the pane is too narrow for both"
      }
    >
      <Icon name={split ? "split" : "columns"} className="icon-inline" /> {split ? "inline" : "split"}
    </Button>
  );
}
