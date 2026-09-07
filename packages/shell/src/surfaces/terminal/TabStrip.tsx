import { type ProcState, SHELL_STREAM } from "@toyon/shared";
import { tip } from "../../ui/Tooltip.tsx";

/** the pane's header: one chip per stream the worktree owns. The shell first, then the procs in
 * config order. Chips are `btn-outline` like the agent and variant rows, not a bespoke tab widget,
 * and each proc carries the `.dot` the rail already uses for its status. */
export function TabStrip({
  procs,
  active,
  onPick,
}: {
  procs: ProcState[];
  active: string;
  onPick: (stream: string) => void;
}) {
  return (
    <span className="term-tabs">
      <button
        type="button"
        className={`btn btn-outline term-tab ${active === SHELL_STREAM ? "on" : ""}`}
        onClick={() => onPick(SHELL_STREAM)}
        {...tip("A shell in this worktree")}
      >
        shell
      </button>
      {procs.map((p) => (
        <button
          type="button"
          key={p.name}
          className={`btn btn-outline term-tab ${active === p.name ? "on" : ""}`}
          onClick={() => onPick(p.name)}
          {...tip(`${p.command}\n${p.status} on :${p.port}`)}
        >
          <span className={`dot ${p.status}`} />
          {p.name}
        </button>
      ))}
    </span>
  );
}
