import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import type { Machines } from "../machines.ts";

/** what a row about another machine offers: looking at it, and forgetting it. The machine that
 * served this page has no row of its own and cannot be forgotten from itself. */
export function machineItems(machines: Machines, origin: string): MenuEntry[] {
  const m = machines.get(origin);
  if (!m || m.serving) return [];
  const name = machines.displayName(origin);
  const go: MenuItem[] = [];
  if (machines.active().origin !== origin) {
    go.push({ id: `machine:${origin}`, label: `switch to ${name}`, onClick: () => machines.activate(origin) });
  }
  const manage: MenuItem[] = [
    {
      id: `forget-machine:${origin}`,
      label: `forget ${name}…`,
      danger: true,
      onClick: () => {
        if (
          window.confirm(
            `Forget ${name}?\n\nIt leaves your list, here and in every browser Toyon on this machine serves, and this browser forgets what it had selected there. Toyon on that machine is not touched; pair again to list it.`,
          )
        ) {
          // the daemon that served this page keeps the list; its next frame drops the row here
          machines.serving().sock.send({ t: "forget-machine", origin });
        }
      },
    },
  ];
  return grouped([go, manage]);
}
