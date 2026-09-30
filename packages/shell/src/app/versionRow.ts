import { type InstallMethod, type RepoInfo, registryHost, type SelfState, type UpdateState } from "@toyon/shared";
import { selfNotice } from "./selfNotice.ts";
import { restartWaitLine } from "./updateNotice.ts";

/** what the settings card's version chip reads, says and does */
export interface VersionRow {
  /** the chip: the version, and what is happening to it when something is */
  value: string;
  /** its tip: what the state means */
  text: string;
  /** what the last build printed before it stopped */
  detail?: string;
  /** what a press does: restart onto what is installed, run the project's `afterLand`, load this
   * page again onto a finished build, install what is out, or ask the registry. Null where a press
   * could do nothing: a checkout updates by landing on its own branch. */
  act: "restart" | "rebuild" | "reload" | "update" | "check" | null;
  /** something is under way, so the chip shows it and takes no press */
  busy: boolean;
}

/** how this copy came to be and where a newer one comes from. The registry is named because a
 * company mirror can sit releases behind the public one, and "newest" then means newest it lists. */
const installText = (install: InstallMethod, registry: string | null): string => {
  const from = registryHost(registry);
  switch (install) {
    case "npm":
    case "bun":
      return `installed with ${install}. A newer version from ${from} installs itself when nothing is busy; press to check for one now`;
    case "npx":
      return `run with npx, which fetches the newest version from ${from} itself. Press to check for one now`;
    case "none":
      return "run from a checkout, which does not update itself";
  }
};

/**
 * The one row that says which Toyon this is. The bar's chips show only what needs a person; this
 * row is always there, so it reads the whole state: an update on its way, a checkout that has
 * moved on, or nothing, in which case it names the version and how it was installed.
 */
export function versionRow(
  version: string,
  install: InstallMethod,
  update: UpdateState | null,
  self: SelfState | null,
  repos: RepoInfo[],
  rebuilt = false,
  registry: string | null = null,
): VersionRow {
  if (update) {
    if (update.restarting) {
      const to = update.installed ?? update.running;
      const text =
        update.restarting.length > 0
          ? restartWaitLine(update.restarting)
          : "Toyon is restarting; this page reloads when it is back";
      return { value: `${to}, restarting`, text, act: "restart", busy: true };
    }
    if (update.installing) {
      const to = update.latest ?? update.installed ?? update.running;
      return { value: `${to}, installing`, text: `Installing Toyon ${to}`, act: "update", busy: true };
    }
    if (update.failed) {
      const why = update.failed.line.replace(/\.$/, "");
      return {
        value: `${update.running}, update failed`,
        text: `Installing Toyon ${update.failed.version} stopped: ${why}. Press to try again, or run ${update.failed.command}`,
        act: "update",
        busy: false,
      };
    }
    if (update.installed) {
      return {
        value: `${update.installed} ready`,
        text: `Toyon ${update.installed} is installed and ${update.running} is still running. It restarts onto the new one when nothing is busy; press to restart now`,
        act: "restart",
        busy: false,
      };
    }
    if (update.latest) {
      return {
        value: `${update.running}, ${update.latest} out`,
        text:
          update.method === "npx"
            ? `Toyon ${update.latest} is out. This copy runs with npx, so run npx toyon@${update.latest} to use it`
            : `Toyon ${update.latest} is out and installs when nothing is busy; press to install now`,
        act: "update",
        busy: false,
      };
    }
  }
  const notice = selfNotice(self, repos, rebuilt);
  if (notice) {
    if (notice.busy) return { value: `${version}, rebuilding`, text: notice.text, act: "rebuild", busy: true };
    if (notice.reload) return { value: `${version}, rebuilt`, text: notice.text, act: "reload", busy: false };
    if (notice.build === "try again") {
      return {
        value: `${version}, rebuild stopped`,
        text: notice.text,
        detail: notice.detail,
        act: "rebuild",
        busy: false,
      };
    }
    return { value: `${version}, behind`, text: notice.text, act: notice.build ? "rebuild" : "restart", busy: false };
  }
  return {
    value: version,
    text: `Toyon ${version}, ${installText(install, registry)}`,
    act: install === "none" ? null : "check",
    busy: false,
  };
}
