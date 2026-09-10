import { type ProcState, SHELL_STREAM } from "@toyon/shared";
import { procItems, shellItems } from "../../state/actions/proc.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { useContextMenu } from "../../ui/menu.ts";
import { tip } from "../../ui/Tooltip.tsx";

/** the pane's header: one chip per stream the worktree owns. The shell first, then the procs in
 * config order. Chips are `btn-outline` like the agent and variant rows, not a bespoke tab widget,
 * and each proc carries the `.dot` the rail already uses for its status. A proc tab answers a
 * right-click with its restart; the shell tab has nothing of its own and leaves it to the app. */
export function TabStrip({
  worktreeId,
  procs,
  active,
  onPick,
}: {
  worktreeId: string;
  procs: ProcState[];
  active: string;
  onPick: (stream: string) => void;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const cm = useContextMenu("terminal");
  return (
    <span className="term-tabs">
      <Button
        variant="outline"
        mono
        className="term-tab"
        on={active === SHELL_STREAM}
        onClick={() => onPick(SHELL_STREAM)}
        {...tip("A shell in this worktree")}
        {...cm.contextMenu(() => shellItems(worktreeId, { sock, dispatch }))}
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
          {...cm.contextMenu(() => procItems(p, worktreeId, { sock, dispatch }))}
        >
          <span className={`dot ${p.status}`} />
          {p.name}
        </Button>
      ))}
    </span>
  );
}
