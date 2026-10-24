import { useStore } from "../../state/context.tsx";
import type { TipPlacement } from "../../ui/Tooltip.tsx";

/** Where a row's tip stands in the changes dock: beside the row on the centre's side, as a rail
 * row's does, so the box hangs off the dock's edge level with the row instead of landing over the
 * rows under it. The changes dock is the dock opposite the chat, so the centre is on the chat's
 * side of it. */
export function useTipSide(): TipPlacement {
  return useStore((s) => s.chatSide);
}
