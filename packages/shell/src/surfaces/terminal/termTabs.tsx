import { LOGIN_STREAM, type ProcState, SHELL_STREAM } from "@toyon/shared";
import { procItems, shellItems } from "../../state/actions/proc.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { IconButton } from "../../ui/Button.tsx";
import type { TabItem } from "../../ui/Tabs.tsx";
import { tip } from "../../ui/Tooltip.tsx";

/** the pane's header as tab items: the shell first, the agent's login while it has one, then the
 * procs in config order. Each proc carries the `.dot` the rail uses for its status. Restart is a
 * thing you do to the stream you are looking at, so it rides on the open tab at its trailing edge;
 * a right-click on any tab offers the same for that one. While the login is the open tab it is the
 * only one: the pane is a step in signing in then, not the worktree's terminal. */
export function useTermTabs({
  worktreeId,
  procs,
  login,
  current,
  onRestart,
}: {
  worktreeId: string;
  procs: ProcState[];
  login: boolean;
  current: string;
  onRestart: (stream: string) => void;
}): TabItem<string>[] {
  const sock = useSock();
  const dispatch = useDispatch();
  const deps = { sock, dispatch };
  const trail = (id: string, label: string) => <IconButton icon="reload" label={label} onClick={() => onRestart(id)} />;
  const loginTab = {
    id: LOGIN_STREAM,
    label: "login",
    // above: the strip heads the body, so a box below it lands on the first lines of output
    tip: tip("The agent's login; it closes once you are in", undefined, { placement: "top" }),
    trail: trail(LOGIN_STREAM, "Run the login again"),
  };
  if (login && current === LOGIN_STREAM) return [loginTab];
  return [
    {
      id: SHELL_STREAM,
      label: "shell",
      tip: tip("A shell in this worktree", undefined, { placement: "top" }),
      menu: () => shellItems(worktreeId, deps),
      trail: trail(SHELL_STREAM, "Restart the shell"),
    },
    ...(login ? [loginTab] : []),
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
