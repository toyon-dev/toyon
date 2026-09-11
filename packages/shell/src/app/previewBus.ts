import type { PickVerb, ShellToBridgeMsg } from "@toyon/shared";
import type { Action } from "../state/store.ts";

/** Posts typed commands into preview iframes. Center registers the implementations once it owns
 * the frames (each post goes to that frame's known proxy origin); before that, posts are dropped. */
export const previewBus = {
  post: (_id: string, _msg: ShellToBridgeMsg) => {},
  broadcast: (_msg: ShellToBridgeMsg) => {},
};

/** arm the element picker in a preview with a verb, or disarm it, and mirror it in the store. The
 * verb already armed disarms; the other one swaps in place, so ⌘E and ⌘I never stack. */
export function togglePick(
  worktreeId: string,
  picking: PickVerb | false,
  dispatch: (a: Action) => void,
  verb: PickVerb,
) {
  const off = picking === verb;
  previewBus.post(worktreeId, off ? { type: "pick-cancel" } : { type: "pick-start", verb });
  dispatch({ a: "set-picking", v: off ? false : verb });
}
