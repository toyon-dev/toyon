import type { ThemePrefs } from "@orchardist/shared";
import { effectiveKind, resolveTheme } from "@orchardist/shared";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { appearanceLabel, byName } from "./commands.ts";

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
        <>
          <span className="cmd-label">
            {m === prefs.mode ? "● " : ""}
            {appearanceLabel[m]}
          </span>
          <span className="cmd-hint">
            {m === "system" ? `${systemDark ? "dark" : "light"} now · ${slotName(m)}` : slotName(m)}
          </span>
        </>
      )}
    />
  );
}
