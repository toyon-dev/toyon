import type { RepoInfo } from "@toyon/shared";
import { profileNames } from "../../state/profiles.ts";
import { ChipPicker } from "../../ui/ChipPicker.tsx";

/** the profile a new worktree of this repo runs when nothing is picked for it: the repo's pick,
 * made on a draft's row and kept by the daemon per repo, while the file still has it; else the
 * repo's default. Undefined when the repo has no profiles. */
export function newWorktreeProfile(repo: RepoInfo | null): string | undefined {
  const names = profileNames(repo);
  if (names.length === 0) return undefined;
  const picked = repo?.picks?.profile;
  return picked && names.includes(picked) ? picked : repo?.config.defaultProfile;
}

/** which of the repo's profiles the new worktree runs, each row naming the procs it starts;
 * renders nothing for a repo without any */
export function ProfileChip({
  repo,
  value,
  onChange,
  onClose,
}: {
  repo: RepoInfo | null;
  value: string | undefined;
  onChange: (p: string) => void;
  onClose?: () => void;
}) {
  const names = profileNames(repo);
  if (names.length === 0 || !value) return null;
  const profiles = repo?.config.profiles ?? {};
  const file = repo?.configFile ?? "the settings";
  const runs = (name: string) => {
    const procs = profiles[name]?.run ?? [];
    const what = procs.length > 0 ? `runs ${procs.join(", ")}` : "runs nothing";
    return name === repo?.config.defaultProfile ? `${what}; the default in ${file}` : what;
  };
  return (
    <ChipPicker
      value={value}
      options={names.map((n) => ({ id: n, description: runs(n) }))}
      onChange={onChange}
      onClose={onClose}
      hint={names.length > 1 ? `${value}: ${runs(value)}. Click to change` : `the only profile in ${file}`}
      placeholder="the profile the worktree runs"
    />
  );
}
