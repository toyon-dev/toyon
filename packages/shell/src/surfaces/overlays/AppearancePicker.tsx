import type { ThemePrefs } from "@toyon/shared";
import { effectiveKind, resolveTheme } from "@toyon/shared";
import { appearanceLabel } from "../../state/actions/settings.ts";
import { useDarkNow, useDispatch, useSock, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { byName } from "./commands.ts";
import { PaletteRow } from "./PaletteRow.tsx";

const MODES: ThemePrefs["mode"][] = ["dark", "light", "system", "daylight"];

/** the clock the boundary is read on: the hour is what someone checks it against, so the minutes
 * matter and the seconds do not */
const AT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** dark / light / follow system / follow daylight — previews the slot each would paint */
export function AppearancePicker() {
  const dispatch = useDispatch();
  const sock = useSock();
  const prefs = useStore((s) => s.themePrefs);
  const themes = useStore((s) => s.themes);
  const dark = useDarkNow();
  const daylight = useStore((s) => s.daylight);
  const slotName = (m: ThemePrefs["mode"]) =>
    themes.find((t) => t.id === prefs[effectiveKind({ ...prefs, mode: m }, dark)])?.name ?? "";

  // Both following modes say which way they are leaning right now, because that is the question a
  // row called "follow" leaves open. Daylight can also say when it turns, which is the answer to
  // the next one; it cannot while the page is still carrying an answer forward from last time.
  const hint = (m: ThemePrefs["mode"]) => {
    if (m === "system") return `${dark.system ? "dark" : "light"} now · ${slotName(m)}`;
    if (m !== "daylight") return slotName(m);
    const turns =
      daylight && daylight.until > Date.now()
        ? ` · ${dark.daylight ? "light" : "dark"} at ${AT.format(daylight.until)}`
        : "";
    return `${dark.daylight ? "dark" : "light"} now${turns} · ${slotName(m)}`;
  };

  return (
    <ListPicker
      items={MODES}
      filter={(ms, q) => ms.filter((m) => byName(q, appearanceLabel[m]))}
      rowClass={() => "picker-row"}
      keyOf={(m) => m}
      initialIndex={(ms) => ms.indexOf(prefs.mode)}
      onActive={(m) =>
        dispatch({ a: "preview-theme", theme: m ? resolveTheme({ ...prefs, mode: m }, themes, dark) : null })
      }
      onPick={(m) => {
        sock?.send({ t: "set-theme", prefs: { ...prefs, mode: m } });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder="light/dark mode"
      keys={{ nav: "preview", pick: "keeps", back: "reverts" }}
      row={(m) => <PaletteRow label={appearanceLabel[m]} current={m === prefs.mode} hint={hint(m)} />}
    />
  );
}
