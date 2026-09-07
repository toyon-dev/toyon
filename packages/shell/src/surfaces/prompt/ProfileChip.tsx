import type { RepoInfo } from "@toyon/shared";
import { STORAGE } from "../../state/keys.ts";
import { nextProfile, profileNames } from "../../state/profiles.ts";
import { usePersisted } from "../../ui/hooks.ts";
import { tip } from "../../ui/Tooltip.tsx";

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

/** click cycles through the repo's profiles; renders nothing for a repo without any */
export function ProfileChip({
  repo,
  value,
  onChange,
}: {
  repo: RepoInfo | null;
  value: string | undefined;
  onChange: (p: string) => void;
}) {
  const names = profileNames(repo);
  if (names.length === 0 || !value) return null;
  const next = nextProfile(names, value);
  return (
    <button
      className="btn btn-outline profile-chip"
      {...tip(names.length > 1 ? `run with ${next} instead` : "the only profile in toyon.json")}
      onClick={() => next && onChange(next)}
    >
      {value}
    </button>
  );
}
