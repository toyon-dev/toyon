import { tip } from "../../ui/Tooltip.tsx";

/** foot of the rail: a dot only while the socket is down. Nothing is drawn when all is well.
 * The everyday states already have homes: a crashed proc badges the composer's terminal button,
 * the rail's own worktree dots say which worktree it died in, and the terminal's tab strip names
 * each proc with its status and port. The row stays mounted at every state so the list above it
 * keeps its height and the dot never moves. */
export function ConnDot({ connected }: { connected: boolean }) {
  if (connected) return <div className="rail-foot" />;
  return (
    <div className="rail-foot offline" role="status" {...tip("Reconnecting to daemon")}>
      <span className="nw-full">reconnecting…</span>
      <span className="conn-dot" />
    </div>
  );
}
