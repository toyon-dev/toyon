import { type ProcState, SHELL_STREAM } from "@toyon/shared";
import { procItems, shellItems } from "../../state/actions/proc.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { IconButton } from "../../ui/Button.tsx";
import type { TabItem } from "../../ui/Tabs.tsx";
import { tip } from "../../ui/Tooltip.tsx";

/** the pane's header as tab items: the shell first, then the procs in config order. Each proc
 * carries the `.dot` the rail uses for its status. Restart is a thing you do to the stream you are
 * looking at, so it rides on the open tab at its trailing edge; a right-click on any tab offers
 * the same for that one. */
export function useTermTabs({
  worktreeId,
  procs,
  onRestart,
}: {
  worktreeId: string;
  procs: ProcState[];
  onRestart: (stream: string) => void;
}): TabItem<string>[] {
  const sock = useSock();
  const dispatch = useDispatch();
  const deps = { sock, dispatch };
  const trail = (id: string, label: string) => <IconButton icon="reload" label={label} onClick={() => onRestart(id)} />;
  return [
    {
      id: SHELL_STREAM,
      label: "shell",
      // above: the strip heads the body, so a box below it lands on the first lines of output
      tip: tip("A shell in this worktree", undefined, { placement: "top" }),
      menu: () => shellItems(worktreeId, deps),
      trail: trail(SHELL_STREAM, "Restart the shell"),
    },
    ...procs.map((p) => ({
      id: p.name,
      label: p.name,
      lead: <span className={`dot ${p.status}`} />,
      tip: tip(`${p.command}\n${p.status} on :${p.port}`, undefined, { placement: "top" }),
      menu: () => procItems(p, worktreeId, deps),
      trail: trail(p.name, `Restart ${p.name}`),
    })),
  ];
}
