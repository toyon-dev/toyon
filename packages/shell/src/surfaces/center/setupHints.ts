// What the setup pane says under a command about who runs it: the three answers the file can
// give, and what the daemon made of the saved one. Pure, so the words are tested as data.

import type { RepoInfo } from "@toyon/shared";
import { runCmd } from "@toyon/shared";
import type { ChipOption } from "../../ui/ChipPicker.tsx";

/** who runs a command, as the file says it: nothing (main, when Toyon can place its files), the
 * trunk whether or not it can (no change flips one it cannot), or every copy its own */
export type From = "auto" | "trunk" | "copy";

export const SHARING: ChipOption<From>[] = [
  {
    id: "auto",
    label: "auto",
    chip: "shared: auto",
    description:
      "main runs it for every worktree when the command names a folder Toyon can watch; a worktree that changes it runs its own",
  },
  {
    id: "trunk",
    label: "always",
    chip: "shared: always",
    description:
      "main runs it for every worktree; a worktree that changes a folder the command names runs its own, and nothing flips a command that names none",
  },
  { id: "copy", label: "never", chip: "shared: never", description: "every worktree runs its own" },
];

/** What the saved file comes to for this row, read off the daemon's tier: nothing while the row is
 * not what the file has (a new or edited command has no tier yet), nothing for a command every
 * copy runs by the file's word (the chip says it), else who runs it and what flips it. */
export function tierHint(
  name: string,
  cmd: string,
  from: From,
  repo: Pick<RepoInfo, "config" | "tier">,
): string | null {
  const saved = repo.config.run[name.trim()];
  if (saved === undefined || runCmd(saved) !== cmd.trim()) return null;
  if (from === "copy") return null;
  const tier = repo.tier?.[name.trim()];
  if (tier && tier.paths.length > 0) {
    return `main runs it; a worktree that changes ${tier.paths.join(", ")} runs its own`;
  }
  // the trunk's word shares a command that names nothing to watch, and then nothing flips it
  if (tier || from === "trunk") return "main runs it for every worktree; no change here flips it";
  return "every worktree runs its own: the command names nothing Toyon can watch";
}
