import { useSock } from "../../state/context.tsx";
import { useActive } from "../../state/selectors.ts";
import { health } from "./health.ts";

/** foot of the rail: one dot for the worst of daemon connection and the active worktree's procs.
 * The tooltip says which; a click restarts every crashed or stopped proc. */
export function HealthDot({ connected }: { connected: boolean }) {
  const sock = useSock();
  const active = useActive();
  const h = health(connected, active?.procs ?? []);
  const restart = () => {
    if (!active) return;
    for (const proc of h.restart) sock?.send({ t: "restart-proc", worktreeId: active.worktree.id, proc });
  };
  return (
    <button
      type="button"
      className="rail-foot"
      data-level={h.level}
      data-tip={h.tip}
      aria-label={h.tip}
      aria-disabled={h.restart.length === 0}
      onClick={h.restart.length ? restart : undefined}
    >
      <span className="nw-full conn-label">{h.label}</span>
      <span className="conn-dot" />
    </button>
  );
}
