import { STORAGE } from "../../state/keys.ts";
import { usePersisted } from "../../ui/hooks.ts";

/** whether long lines fold at the pane's edge: a choice about this window's panes, not one file,
 * so it is kept with the pane's height and not the file, and the one file and the review share it */
export function useWrap(): readonly [boolean, (on: boolean) => void] {
  return usePersisted(STORAGE.editorWrap, false, (raw) => (raw === null ? undefined : raw === "1"));
}
