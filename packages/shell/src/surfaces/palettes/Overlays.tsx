import { useActiveId, useOverlay } from "../../state/selectors.ts";
import { NewProjectOverlay } from "../prompt/NewProjectOverlay.tsx";
import { PromptOverlay } from "../prompt/PromptOverlay.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { AppearancePicker } from "./AppearancePicker.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { KeysHelp } from "./KeysHelp.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { QuickOpen } from "./QuickOpen.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { ThemePicker } from "./ThemePicker.tsx";
import "./palettes.css";

/** whichever overlay is open (they are mutually exclusive). The project picker is here only in
 * its dialog form: normally it hangs off its pill in the top bar, where the click already is. */
export function Overlays() {
  const overlay = useOverlay();
  const activeId = useActiveId();
  return (
    <>
      {overlay?.kind === "quick-open" && activeId && <QuickOpen worktreeId={activeId} />}
      {overlay?.kind === "search" && activeId && <SearchPalette worktreeId={activeId} />}
      {overlay?.kind === "keys" && <KeysHelp />}
      {overlay?.kind === "theme" && <ThemePicker slot={overlay.slot} />}
      {overlay?.kind === "appearance" && <AppearancePicker />}
      {overlay?.kind === "agent" && <AgentPicker />}
      {overlay?.kind === "commands" && <CommandPalette />}
      {overlay?.kind === "prompt" && <PromptOverlay />}
      {overlay?.kind === "projects" && overlay.dialog && <ProjectPicker dialog />}
      {overlay?.kind === "new-project" && <NewProjectOverlay overlay={overlay} />}
    </>
  );
}
