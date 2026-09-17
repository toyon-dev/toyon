import { useDispatch, useStore } from "../../state/context.tsx";
import { markHits } from "../../ui/highlight.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import type { Anchored } from "../../ui/Overlay.tsx";
import { type Command, commandHits, filterCommands, useCommands } from "./commands.ts";
import { PaletteRow } from "./PaletteRow.tsx";

/** a command row, shared with ⌘P's `>` mode */
export function commandRow(c: Command, q: string) {
  const needle = q.trim();
  return (
    <PaletteRow
      label={markHits(c.label, needle ? commandHits(c.label, needle) : null, 0)}
      hint={c.hint && <Kbd k={c.hint} />}
    />
  );
}

/** ⌘⇧P (F1 on Firefox), centred; the phone's menu renders it anchored, inside its button's wrapper */
export function CommandPalette({ anchored }: { anchored?: Anchored }) {
  const dispatch = useDispatch();
  const commands = useCommands();
  const initialQuery = useStore((s) => (s.paletteReturn?.mode === "commands" ? s.paletteReturn.q : ""));
  return (
    <ListPicker
      anchored={anchored}
      items={commands}
      filter={filterCommands}
      rowClass={() => "picker-row"}
      keyOf={(c) => c.id}
      onPick={(c, q) => {
        // a sub-picker command remembers the query so esc there comes back here
        if (c.sub) dispatch({ a: "palette-return", v: { mode: "commands", q } });
        else dispatch({ a: "close" });
        c.run();
      }}
      onBack={() => dispatch({ a: "close" })}
      placeholder="run a command…"
      keys={{ pick: "runs", back: "closes" }}
      initialQuery={initialQuery}
      empty="no matching command"
      row={(c, _active, q) => commandRow(c, q)}
    />
  );
}
