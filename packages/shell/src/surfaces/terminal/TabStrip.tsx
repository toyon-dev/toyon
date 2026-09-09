import { type ProcState, SHELL_STREAM } from "@toyon/shared";
import { Button } from "../../ui/Button.tsx";
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
      <Button
        variant="outline"
        mono
        className="term-tab"
        on={active === SHELL_STREAM}
        onClick={() => onPick(SHELL_STREAM)}
        {...tip("A shell in this worktree")}
      >
        shell
      </Button>
      {procs.map((p) => (
        <Button
          key={p.name}
          variant="outline"
          mono
          className="term-tab"
          on={active === p.name}
          onClick={() => onPick(p.name)}
          {...tip(`${p.command}\n${p.status} on :${p.port}`)}
        >
          <span className={`dot ${p.status}`} />
          {p.name}
        </Button>
      ))}
    </span>
  );
}
