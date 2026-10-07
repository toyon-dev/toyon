import { isOwned } from "@toyon/shared";
import { machineLine } from "../../app/machineLine.ts";
import { machineItems } from "../../state/actions/machine.ts";
import { useMachine, useMachineList, useMachineStore, useMachines } from "../../state/context.tsx";
import type { Machine } from "../../state/machine.ts";
import { cx } from "../../ui/cx.ts";
import { useContextMenu } from "../../ui/menu.ts";

/** one other machine: its name, and what it needs of you, read off its own store */
function MachineRow({ machine }: { machine: Machine }) {
  const machines = useMachines();
  const cm = useContextMenu("machines");
  const rows = useMachineStore(machine, (s) => s.rows);
  const connected = useMachineStore(machine, (s) => s.connected);
  const connectFailure = useMachineStore(machine, (s) => s.connectFailure);
  const incompatible = useMachineStore(machine, (s) => s.incompatible);
  const front = useMachineStore(machine, (s) => s.remote?.front);
  const name = machines.displayName(machine.origin);
  const line = machineLine(name, {
    rows: rows.filter(isOwned),
    connected,
    connectFailure,
    incompatible,
    suspended: front === "edge" && !connected,
  });
  const owed = /^\d+ /.test(line);
  return (
    <button
      type="button"
      className="row machine-row"
      onClick={() => machines.activate(machine.origin)}
      {...cm.contextMenu(() => machineItems(machines, machine.origin))}
    >
      <span className="machine-name">{name}</span>
      <span className={cx("machine-line", owed ? "machine-owed" : "row-dim")}>{line}</span>
    </button>
  );
}

/** The other machines, above the list of this one's worktrees on the phone's home screen, each
 * with what it needs of you; a tap switches the page to it. Nothing with one machine listed: the
 * screen is then exactly the list it was. */
export function MachineRows() {
  const machines = useMachines();
  const here = useMachine();
  const list = useMachineList();
  if (list.length < 2) return null;
  return (
    <div className="machine-rows">
      <div className="section-title section-row machine-head">{machines.displayName(here.origin)}</div>
      {list
        .filter((m) => m !== here)
        .map((m) => (
          <MachineRow key={m.origin} machine={m} />
        ))}
    </div>
  );
}
