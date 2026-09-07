import { useDispatch } from "../../state/context.tsx";
import { useActive } from "../../state/selectors.ts";
import { health } from "./health.ts";

/** foot of the rail: one dot for the worst of daemon connection and the active worktree's procs.
 * The tooltip says which; a click opens that proc's tab in the terminal pane, which is where you
 * can read why it died and restart it. */
export function HealthDot({ connected }: { connected: boolean }) {
  const dispatch = useDispatch();
  const active = useActive();
  const h = health(connected, active?.procs ?? []);
  const show = () => {
    const stream = h.restart[0];
    if (active && stream) dispatch({ a: "term-stream", id: active.worktree.id, stream });
  };
  return (
    <button
      type="button"
      className="rail-foot"
      data-level={h.level}
      data-tip={h.tip}
      aria-label={h.tip}
      aria-disabled={h.restart.length === 0}
      onClick={h.restart.length ? show : undefined}
    >
      <span className="nw-full conn-label">{h.label}</span>
      <span className="conn-dot" />
    </button>
  );
}
