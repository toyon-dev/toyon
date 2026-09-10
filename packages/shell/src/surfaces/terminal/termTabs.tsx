import { type ProcState, SHELL_STREAM } from "@toyon/shared";
import { procItems, shellItems } from "../../state/actions/proc.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { IconButton } from "../../ui/Button.tsx";
import type { TabItem } from "../../ui/Tabs.tsx";
import { tip } from "../../ui/Tooltip.tsx";

/** the pane's header as tab items: the shell first, then the procs in config order. Each proc
 * carries the `.dot` the rail uses for its status. Restart is a thing you do to one stream, so it
 * rides on the tab itself, at its trailing edge, and stays out until the stream has exited; a
 * right-click on the tab offers the same. */
export function useTermTabs({
  worktreeId,
  procs,
  stream,
  exited,
  onRestart,
}: {
  worktreeId: string;
  procs: ProcState[];
  /** the open tab */
  stream: string;
  /** the open stream has exited, so its restart stays out */
  exited: boolean;
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
      tip: tip("A shell in this worktree"),
      menu: () => shellItems(worktreeId, deps),
      trail: trail(SHELL_STREAM, "Restart the shell"),
      alert: stream === SHELL_STREAM && exited,
    },
    ...procs.map((p) => ({
      id: p.name,
      label: p.name,
      lead: <span className={`dot ${p.status}`} />,
      tip: tip(`${p.command}\n${p.status} on :${p.port}`),
      menu: () => procItems(p, worktreeId, deps),
      trail: trail(p.name, `Restart ${p.name}`),
      alert: stream === p.name && exited,
    })),
  ];
}
