import { MONO_FACE_IDS, monoFaceHint, monoFaceLabel, setMonoFace, useMonoFace } from "../../app/monoFace.ts";
import { useDispatch } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { byName } from "./commands.ts";
import { PaletteRow } from "./PaletteRow.tsx";

/** which candidate mono face the chat, the editor and the terminal are read in.
 * No preview on the active row: a face is a download, and the pick shows the moment it is in. */
export function MonoFacePicker() {
  const dispatch = useDispatch();
  const current = useMonoFace();
  return (
    <ListPicker
      items={[...MONO_FACE_IDS]}
      filter={(ids, q) => ids.filter((id) => byName(q, monoFaceLabel(id)))}
      rowClass={() => "picker-row"}
      keyOf={(id) => id}
      initialIndex={(ids) => Math.max(0, ids.indexOf(current))}
      onPick={(id) => {
        setMonoFace(id);
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder="mono face"
      row={(id) => <PaletteRow label={monoFaceLabel(id)} current={id === current} hint={monoFaceHint(id)} />}
    />
  );
}
