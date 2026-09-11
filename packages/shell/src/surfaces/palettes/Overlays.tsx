import { useStore } from "../../state/context.tsx";
import { useActiveId, useOverlay } from "../../state/selectors.ts";
import { AgentPage } from "./AgentPage.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { AppearancePicker } from "./AppearancePicker.tsx";
import { ArchivePicker } from "./ArchivePicker.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { FolderPicker } from "./FolderPicker.tsx";
import { KeysHelp } from "./KeysHelp.tsx";
import { NewProjectOverlay } from "./NewProjectOverlay.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { QuickOpen } from "./QuickOpen.tsx";
import { RefPicker } from "./RefPicker.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { ThemePicker } from "./ThemePicker.tsx";
import "./palettes.css";

/** whichever overlay is open (they are mutually exclusive). The project picker is here only in
 * its dialog form: normally it hangs off its pill in the top bar, where the click already is. */
export function Overlays() {
  const overlay = useOverlay();
  const activeId = useActiveId();
  const activeRepoId = useStore((s) => s.activeRepoId);
  return (
    <>
      {overlay?.kind === "quick-open" && activeId && <QuickOpen worktreeId={activeId} />}
      {overlay?.kind === "search" && activeId && <SearchPalette worktreeId={activeId} />}
      {overlay?.kind === "refs" && activeRepoId && <RefPicker repoId={activeRepoId} />}
      {overlay?.kind === "archived" && <ArchivePicker repoId={overlay.repoId} />}
      {overlay?.kind === "keys" && <KeysHelp />}
      {overlay?.kind === "theme" && <ThemePicker slot={overlay.slot} />}
      {overlay?.kind === "appearance" && <AppearancePicker />}
      {overlay?.kind === "agent" && <AgentPicker />}
      {overlay?.kind === "agent-page" && <AgentPage agentId={overlay.agent} />}
      {overlay?.kind === "commands" && <CommandPalette />}
      {overlay?.kind === "projects" && overlay.dialog && <ProjectPicker dialog />}
      {overlay?.kind === "new-project" && <NewProjectOverlay overlay={overlay} />}
      {overlay?.kind === "choose-folder" && <FolderPicker form={overlay.form} />}
    </>
  );
}
