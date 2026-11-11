import { STORAGE } from "../../state/keys.ts";
import { usePersisted } from "../../ui/hooks.ts";
import { HeadToggle } from "./HeadToggle.tsx";

/** whether long lines fold at the pane's edge: a choice about this window's panes, not one file,
 * so it is kept with the pane's height and not the file, and the one file and the review share it */
export function useWrap(): readonly [boolean, (on: boolean) => void] {
  return usePersisted(STORAGE.editorWrap, false, (raw) => (raw === null ? undefined : raw === "1"));
}

/** the head's wrap switch, lit while long lines fold */
export function WrapToggle({ wrap, onWrap }: { wrap: boolean; onWrap: (on: boolean) => void }) {
  return (
    <HeadToggle
      icon="wrap"
      label="wrap"
      on={wrap}
      onPress={onWrap}
      tip="Wrap lines: fold a long line at the pane's edge"
    />
  );
}
