import { KEEP_AWAKE_MODES, type KeepAwakeMode } from "@toyon/shared";
import { keepAwakeLabel } from "../../state/actions/settings.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { byName } from "./commands.ts";
import { PaletteRow } from "./PaletteRow.tsx";

/** what each value holds the Mac awake for, since the label alone leaves "use" open */
const HINT: Record<KeepAwakeMode, string> = {
  use: "an agent working, a question waiting, a phone connected",
  always: "whenever Toyon runs, on battery too",
  off: "the Mac sleeps when it would anyway",
};

/** when the daemon holds off its Mac's idle sleep */
export function KeepAwakePicker() {
  const dispatch = useDispatch();
  const sock = useSock();
  const current = useStore((s) => s.keepAwake);
  return (
    <ListPicker
      items={[...KEEP_AWAKE_MODES]}
      filter={(ms, q) => ms.filter((m) => byName(q, keepAwakeLabel[m]))}
      rowClass={() => "picker-row"}
      keyOf={(m) => m}
      initialIndex={(ms) => Math.max(0, current ? ms.indexOf(current) : 0)}
      onPick={(m) => {
        sock?.send({ t: "set-keep-awake", mode: m });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder="keep awake"
      keys={{ pick: "sets", back: "closes" }}
      row={(m) => <PaletteRow label={keepAwakeLabel[m]} current={m === current} hint={HINT[m]} />}
    />
  );
}
