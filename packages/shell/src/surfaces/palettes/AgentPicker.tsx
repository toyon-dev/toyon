import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { byName } from "./commands.ts";
import { PaletteRow } from "./PaletteRow.tsx";

/** which agent a new worktree gets when the prompt does not say; installed ones only are pickable */
export function AgentPicker() {
  const dispatch = useDispatch();
  const sock = useSock();
  const agents = useStore((s) => s.agents);
  const current = useStore((s) => s.defaultAgent);
  return (
    <ListPicker
      items={agents}
      filter={(as, q) => as.filter((a) => byName(q, a.name, a.id))}
      rowClass={(a) => (a.available ? "cmd-item" : "cmd-item dim")}
      keyOf={(a) => a.id}
      initialIndex={(as) =>
        Math.max(
          0,
          as.findIndex((a) => a.id === current),
        )
      }
      onPick={(a) => {
        if (!a.available) return;
        sock?.send({ t: "set-default-agent", agent: a.id });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder="default agent for new worktrees"
      keys={{ pick: "sets", back: "closes" }}
      row={(a) => (
        <PaletteRow
          label={a.name}
          current={a.id === current}
          hint={!a.available ? `not installed: ${a.reason ?? ""}` : a.sandboxed ? undefined : "unsandboxed"}
        />
      )}
    />
  );
}
