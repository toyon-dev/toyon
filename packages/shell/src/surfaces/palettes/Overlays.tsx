import { useActiveId, useOverlay } from "../../state/selectors.ts";
import { PromptOverlay } from "../prompt/PromptOverlay.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { AppearancePicker } from "./AppearancePicker.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { KeysHelp } from "./KeysHelp.tsx";
import { QuickOpen } from "./QuickOpen.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { ThemePicker } from "./ThemePicker.tsx";

/** whichever overlay is open (they are mutually exclusive) */
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
    </>
  );
}
