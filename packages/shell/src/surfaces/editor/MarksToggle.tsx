import { STORAGE } from "../../state/keys.ts";
import { Button } from "../../ui/Button.tsx";
import { usePersisted } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";

/** whether a changed document read rendered shows what came and went: a choice about this
 * window's panes, as the wrap and the split are. On until turned off: the file was opened from a
 * change, and what changed is the first thing asked of it. */
export function useMarks(): readonly [boolean, (on: boolean) => void] {
  return usePersisted(STORAGE.editorMarks, true, (raw) => (raw === null ? undefined : raw === "1"));
}

/** the head's switch for the marks, named for the state it switches to, as the wrap toggle is */
export function MarksToggle({ marks, onMarks }: { marks: boolean; onMarks: (on: boolean) => void }) {
  return (
    <Button
      variant="outline"
      tone="quiet"
      mono
      className="deep-link"
      onClick={() => onMarks(!marks)}
      data-tip={
        marks
          ? "Plain: read the page as it is, with nothing marked"
          : "Changes: mark what came and what went on the page"
      }
    >
      <Icon name="eye" className="icon-inline" /> {marks ? "plain" : "changes"}
    </Button>
  );
}
