import type { ThemePrefs } from "@toyon/shared";
import { effectiveKind, resolveTheme } from "@toyon/shared";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { appearanceLabel, byName } from "./commands.ts";
import { PaletteRow } from "./PaletteRow.tsx";

const MODES: ThemePrefs["mode"][] = ["dark", "light", "system"];

/** dark / light / follow system — previews the slot each would paint */
export function AppearancePicker() {
  const dispatch = useDispatch();
  const sock = useSock();
  const prefs = useStore((s) => s.themePrefs);
  const themes = useStore((s) => s.themes);
  const systemDark = useStore((s) => s.systemDark);
  const slotName = (m: ThemePrefs["mode"]) =>
    themes.find((t) => t.id === prefs[effectiveKind({ ...prefs, mode: m }, systemDark)])?.name ?? "";
  return (
    <ListPicker
      items={MODES}
      filter={(ms, q) => ms.filter((m) => byName(q, appearanceLabel[m]))}
      rowClass={() => "cmd-item"}
      keyOf={(m) => m}
      initialIndex={(ms) => ms.indexOf(prefs.mode)}
      onActive={(m) =>
        dispatch({ a: "preview-theme", theme: m ? resolveTheme({ ...prefs, mode: m }, themes, systemDark) : null })
      }
      onPick={(m) => {
        sock?.send({ t: "set-theme", prefs: { ...prefs, mode: m } });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder="light/dark mode · ↑↓ preview · enter keeps · esc reverts"
      row={(m) => (
        <PaletteRow
          label={appearanceLabel[m]}
          current={m === prefs.mode}
          hint={m === "system" ? `${systemDark ? "dark" : "light"} now · ${slotName(m)}` : slotName(m)}
        />
      )}
    />
  );
}
