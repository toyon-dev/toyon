import type { ShellToBridgeMsg } from "@toyon/shared";
import type { Action } from "../state/store.ts";

/** Posts typed commands into preview iframes. Center registers the implementations once it owns
 * the frames (each post goes to that frame's known proxy origin); before that, posts are dropped. */
export const previewBus = {
  post: (_id: string, _msg: ShellToBridgeMsg) => {},
  broadcast: (_msg: ShellToBridgeMsg) => {},
};

/** arm or disarm the element picker in a preview and mirror it in the store */
export function togglePick(worktreeId: string, picking: boolean, dispatch: (a: Action) => void) {
  previewBus.post(worktreeId, { type: picking ? "pick-cancel" : "pick-start" });
  dispatch({ a: "set-picking", v: !picking });
}
