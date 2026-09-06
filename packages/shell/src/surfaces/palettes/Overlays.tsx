import { useStore } from "../../state/context.tsx";
import { useActiveId, useOverlay } from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { ConfigCard } from "../prompt/ConfigCard.tsx";
import { PromptOverlay } from "../prompt/PromptOverlay.tsx";
import { AppearancePicker } from "./AppearancePicker.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { KeysHelp } from "./KeysHelp.tsx";
import { QuickOpen } from "./QuickOpen.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { ThemePicker } from "./ThemePicker.tsx";

/** whichever overlay is open (they are mutually exclusive), plus the first-run config card */
export function Overlays() {
  const overlay = useOverlay();
  const activeId = useActiveId();
  const repoNeedsSetup = useStore((s) => {
    const wt = worktreeById(s, s.activeId);
    const repo = wt ? s.repos.find((r) => r.id === wt.worktree.repoId) : null;
    return repo?.needsSetup ? repo : null;
  });
  return (
    <>
      {repoNeedsSetup && <ConfigCard key={repoNeedsSetup.id} repo={repoNeedsSetup} />}
      {overlay?.kind === "quick-open" && activeId && <QuickOpen worktreeId={activeId} />}
      {overlay?.kind === "search" && activeId && <SearchPalette worktreeId={activeId} />}
      {overlay?.kind === "keys" && <KeysHelp />}
      {overlay?.kind === "theme" && <ThemePicker slot={overlay.slot} />}
      {overlay?.kind === "appearance" && <AppearancePicker />}
      {overlay?.kind === "commands" && <CommandPalette />}
      {overlay?.kind === "prompt" && <PromptOverlay />}
    </>
  );
}
