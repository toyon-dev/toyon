/** the widest the cluster gets, and the least it keeps clear of what stands beside it in the bar */
export const NAV_MAX_PX = 520;
export const NAV_GAP_PX = 8;

export type NavClusterInput = {
  winW: number;
  /** the centre column's edges as drawn, in window px */
  centre: { left: number; right: number };
  /** where the bar's own lead (the toggle, the pill) ends and its tools begin, in window px */
  leadRight: number;
  toolsLeft: number;
};

/** Where the nav cluster sits: centred over the centre, as wide as 520px, 40% of the window or the
 * centre less a gap allow, whichever is least. Then held off the bar's lead and tools: the lead can
 * reach past a narrow left dock (a long project name, the install button), and with the dock closed
 * the centre begins under it. The cluster slides just far enough to clear them, and no further, so
 * it keeps its place over the preview wherever there is room. */
export function navCluster({ winW, centre, leadRight, toolsLeft }: NavClusterInput): { left: number; width: number } {
  const room = centre.right - centre.left;
  const width = Math.max(0, Math.min(NAV_MAX_PX, Math.floor(winW * 0.4), room - 2 * NAV_GAP_PX));
  const centred = centre.left + (room - width) / 2;
  const min = leadRight + NAV_GAP_PX;
  const max = toolsLeft - NAV_GAP_PX - width;
  // the lead wins when both cannot be had: the tools are icons that read under an overlap, a name is not
  const left = Math.max(Math.min(centred, max), min);
  return { left: Math.round(left), width };
}
