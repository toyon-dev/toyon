import type { Theme } from "@toyon/shared";
import { effectiveKind, pickFamily, type ThemeFamily, themeFamilies } from "@toyon/shared";
import { useEffect, useMemo, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { byName } from "./commands.ts";
import { PaletteRow } from "./PaletteRow.tsx";

const sourceOf = (t: Theme) => (t.source === "file" ? "~/.toyon/themes" : t.source === "vscode" ? "VS Code" : "");

/** Theme picker. Main mode lists families (a dark/light pair is one row; ←→ peeks at the other
 * variant, enter fills both slots and appearance stays as set). Slot overrides list single themes of that kind. */
export function ThemePicker({ slot }: { slot: "theme" | "light" | "dark" }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const prefs = useStore((s) => s.themePrefs);
  const themes = useStore((s) => s.themes);
  const systemDark = useStore((s) => s.systemDark);
  const nowKind = effectiveKind(prefs, systemDark);
  const selectedId = prefs[slot === "theme" ? nowKind : slot];
  const close = () => dispatch({ a: "close" });
  const back = () => dispatch({ a: "close", back: true });
  const preview = (t: Theme | null) => dispatch({ a: "preview-theme", theme: t });

  // ←→ picks a column (null = whatever appearance says) and it sticks as ↑↓ walks the rows, so
  // "browse the light variants" is one keypress; a family missing that kind shows what it has
  const [active, setActive] = useState<ThemeFamily | null>(null);
  const [peek, setPeek] = useState<"dark" | "light" | null>(null);
  const previewOf = (f: ThemeFamily, k: "dark" | "light" | null) => f[k ?? nowKind] ?? f.dark ?? f.light ?? null;
  const families = useMemo(() => themeFamilies(themes), [themes]);
  const slotThemes = useMemo(() => themes.filter((t) => t.kind === slot), [themes, slot]);
  useEffect(() => {
    if (slot === "theme") preview(active ? previewOf(active, peek) : null);
  }, [active, peek]);

  if (slot !== "theme") {
    return (
      <ListPicker
        items={slotThemes}
        filter={(ts, q) => ts.filter((t) => byName(q, t.name, t.id))}
        rowClass={() => "picker-row"}
        keyOf={(t) => t.id}
        initialIndex={(ts) => ts.findIndex((t) => t.id === selectedId)}
        onActive={preview}
        onPick={(t) => {
          sock?.send({ t: "set-theme", prefs: { ...prefs, [slot]: t.id } });
          close();
        }}
        onBack={back}
        placeholder={`${slot} slot override`}
        keys={{ nav: "preview", pick: "keeps", back: "reverts" }}
        empty="no matching theme"
        row={(t) => <PaletteRow label={t.name} current={t.id === selectedId} hint={sourceOf(t)} />}
      />
    );
  }

  return (
    <ListPicker
      items={families}
      filter={(fs, q) => fs.filter((f) => byName(q, f.name, f.dark?.name, f.light?.name))}
      rowClass={() => "picker-row"}
      keyOf={(f) => f.name + (f.dark?.id ?? f.light?.id)}
      initialIndex={(fs) => fs.findIndex((f) => f.dark?.id === selectedId || f.light?.id === selectedId)}
      onActive={setActive}
      onSide={(f) => {
        if (f.dark && f.light) setPeek((previewOf(f, peek)?.kind ?? nowKind) === "dark" ? "light" : "dark");
      }}
      onPick={(f) => {
        sock?.send({ t: "set-theme", prefs: pickFamily(prefs, f) });
        close();
      }}
      onBack={back}
      placeholder="theme"
      keys={{ nav: "preview", side: "dark/light", pick: "keeps", back: "reverts" }}
      empty="no matching theme"
      row={(f, isActive) => {
        const shown = previewOf(f, isActive ? peek : null);
        const src = sourceOf(f.dark ?? f.light!);
        const current = f.dark?.id === selectedId || f.light?.id === selectedId;
        return (
          <PaletteRow
            label={f.name}
            current={current}
            hint={
              <span className="theme-kinds">
                {src && <span>{src}</span>}
                <span className={`kind ${isActive && shown?.kind === "dark" ? "on" : ""}`}>{f.dark ? "dark" : ""}</span>
                <span className={`kind ${isActive && shown?.kind === "light" ? "on" : ""}`}>
                  {f.light ? "light" : ""}
                </span>
              </span>
            }
          />
        );
      }}
    />
  );
}
