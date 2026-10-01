import { LATEST_RELEASE_URL, REPO_URL, releaseUrl } from "../../app/versionRow.ts";
import { grouped, type MenuEntry } from "../../ui/menu.ts";
import { copyText } from "./deps.ts";

/** The version chip's menu: the check its press makes, then where to read about this Toyon and
 * the next one. The check stays on the list where a policy takes it away, and says who did. */
export function versionItems(version: string, check: { run: () => void; off?: string } | null): MenuEntry[] {
  const out = (url: string) => () => window.open(url, "_blank");
  return grouped([
    check
      ? [
          {
            id: "check-update",
            label: "check for updates",
            ...(check.off ? { disabled: check.off } : {}),
            onClick: check.run,
          },
        ]
      : [],
    [
      { id: "release-notes", label: `release notes for ${version}`, onClick: out(releaseUrl(version)) },
      { id: "latest-release", label: "latest release", onClick: out(LATEST_RELEASE_URL) },
      { id: "repo", label: "Toyon on GitHub", onClick: out(REPO_URL) },
      { id: "report", label: "report a problem", onClick: out(`${REPO_URL}/issues/new`) },
    ],
    [{ id: "copy-version", label: "copy version", onClick: () => copyText(version) }],
  ]);
}
