/** What stands in the log that is not the conversation: the pill's seat, the lead row's intro and
 * the box, the log's own last children (ChatLog). One fact for every reader of the rows, so none
 * has to remember the foot on its own: find and select-all stop short of it, the mention stamp
 * leaves it alone, and the observers that watch the rows ignore what changes inside it. */
export const FOOT = ".jump-seat, .draft-intro, .chat-input";

/** whether a change the log's observers heard happened inside the foot */
export function inFoot(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return !!el?.closest(FOOT);
}
