import { CHORD_SECTIONS, CHORDS, resolveTheme } from "@toyon/shared";
import { useDispatch, useStore } from "../../state/context.tsx";
import type { Action } from "../../state/store.ts";
import { Kbd } from "../../ui/Kbd.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { chord } from "../util.ts";
import { appearanceLabel } from "./commands.ts";

const KEY_SECTIONS = CHORD_SECTIONS.map((title) => ({
  title,
  rows: CHORDS.filter((c) => c.section === title).map((c): [string, string] => [chord(c.id), c.label]),
}));

/** gear / ⌘,: settings card stacked over the shortcut card — the one non-worktree surface, so global
 * settings live here as well as in the palette; esc from a picker opened here comes back */
export function KeysHelp() {
  const dispatch = useDispatch();
  const prefs = useStore((s) => s.themePrefs);
  const themes = useStore((s) => s.themes);
  const systemDark = useStore((s) => s.systemDark);
  const agents = useStore((s) => s.agents);
  const defaultAgent = useStore((s) => s.defaultAgent);
  const open = (a: Action) => {
    dispatch({ a: "palette-return", v: { mode: "keys", q: "" } });
    dispatch(a);
  };
  return (
    <Overlay bare boxClass="keys-stack" onClose={() => dispatch({ a: "close" })}>
      <div className="keys-card settings-card">
        <div className="keys-h">Settings</div>
        <div className="set-row">
          <span className="keys-d">theme</span>
          <button
            className="btn btn-outline set-v"
            onClick={() => open({ a: "open", overlay: { kind: "theme", slot: "theme" } })}
          >
            {resolveTheme(prefs, themes, systemDark).name}
          </button>
        </div>
        <div className="set-row">
          <span className="keys-d">light/dark mode</span>
          <button
            className="btn btn-outline set-v"
            onClick={() => open({ a: "open", overlay: { kind: "appearance" } })}
          >
            {appearanceLabel[prefs.mode]}
          </button>
        </div>
        <div className="set-row">
          <span className="keys-d">default agent</span>
          <button className="btn btn-outline set-v" onClick={() => open({ a: "open", overlay: { kind: "agent" } })}>
            {agents.find((a) => a.id === defaultAgent)?.name ?? defaultAgent}
          </button>
        </div>
      </div>
      <div className="keys-card">
        {KEY_SECTIONS.map((sec) => (
          <div className="keys-section" key={sec.title}>
            <div className="keys-h">{sec.title}</div>
            {sec.rows.map(([k, d]) => (
              <div className="keys-row" key={k}>
                <Kbd k={k} chip />
                <span className="keys-d">{d}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Overlay>
  );
}
