import type { RepoInfo } from "@toyon/shared";
import { STORAGE } from "../../state/keys.ts";
import { profileNames } from "../../state/profiles.ts";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import { usePersisted } from "../../ui/hooks.ts";

/** the profile a new worktree of this repo will run: remembered per repo in this browser, the
 * repo's default until chosen. Returns undefined when the repo has no profiles. */
export function useNewWorktreeProfile(repo: RepoInfo | null): [string | undefined, (p: string) => void] {
  const names = profileNames(repo);
  const [stored, setStored] = usePersisted<string>(
    STORAGE.profilePrefix + (repo?.id ?? ""),
    repo?.config.defaultProfile ?? "",
    (raw) => raw ?? undefined,
  );
  // a remembered name the file no longer has falls back to the default
  const value = names.length === 0 ? undefined : names.includes(stored) ? stored : repo?.config.defaultProfile;
  return [value, setStored];
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
