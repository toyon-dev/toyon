import { STORAGE } from "../../state/keys.ts";
import { Button } from "../../ui/Button.tsx";
import { usePersisted } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";

/** whether long lines fold at the pane's edge: a choice about this window's panes, not one file,
 * so it is kept with the pane's height and not the file, and the one file and the review share it */
export function useWrap(): readonly [boolean, (on: boolean) => void] {
  return usePersisted(STORAGE.editorWrap, false, (raw) => (raw === null ? undefined : raw === "1"));
}

/** the head's wrap switch, named for the state it switches to, as the views and the full toggle are */
export function WrapToggle({ wrap, onWrap }: { wrap: boolean; onWrap: (on: boolean) => void }) {
  return (
    <Button
      variant="outline"
      tone="quiet"
      mono
      className="deep-link"
      onClick={() => onWrap(!wrap)}
      data-tip={
        wrap
          ? "Unwrap lines: one line per row, scroll sideways for the rest"
          : "Wrap lines: fold a long line at the pane's edge"
      }
    >
      <Icon name="wrap" className="icon-inline" /> {wrap ? "unwrap" : "wrap"}
    </Button>
  );
}
