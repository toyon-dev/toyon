import type { ShellToBridgeMsg } from "@orchardist/shared";

/** Posts typed commands into preview iframes. Center registers the implementations once it owns
 * the frames (each post goes to that frame's known proxy origin); before that, posts are dropped. */
export const previewBus = {
  post: (_id: string, _msg: ShellToBridgeMsg) => {},
  broadcast: (_msg: ShellToBridgeMsg) => {},
};
