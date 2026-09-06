import { useDispatch, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { type Command, commandHits, filterCommands, useCommands } from "./commands.ts";
import { markHits } from "./highlight.tsx";

/** a command row, shared with ⌘P's `>` mode */
export function commandRow(c: Command, q: string) {
  const needle = q.trim();
  return (
    <>
      <span className="cmd-label">{markHits(c.label, needle ? commandHits(c.label, needle) : null, 0)}</span>
      {c.hint && <span className="cmd-hint">{c.hint}</span>}
    </>
  );
}

/** ⌘⇧P (⌘⇧E on Firefox) */
export function CommandPalette() {
  const dispatch = useDispatch();
  const commands = useCommands();
  const initialQuery = useStore((s) => (s.paletteReturn?.mode === "commands" ? s.paletteReturn.q : ""));
  return (
    <ListPicker
      items={commands}
      filter={filterCommands}
      keyOf={(c) => c.id}
      onPick={(c, q) => {
        // a sub-picker command remembers the query so esc there comes back here
        if (c.sub) dispatch({ a: "palette-return", v: { mode: "commands", q } });
        else dispatch({ a: "close" });
        c.run();
      }}
      onBack={() => dispatch({ a: "close" })}
      placeholder="run a command…"
      initialQuery={initialQuery}
      empty="no matching command"
      row={(c, _active, q) => commandRow(c, q)}
    />
  );
}
