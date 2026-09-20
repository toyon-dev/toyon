import type { InstallMethod, RepoInfo, SelfState, UpdateState } from "@toyon/shared";
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
  /** what a press does: restart onto what is installed, run the project's `afterLand`, install what
   * is out, or ask the registry. Null where a press could do nothing: a checkout updates by
   * landing on its own branch. */
  act: "restart" | "rebuild" | "update" | "check" | null;
  /** something is under way, so the chip shows it and takes no press */
  busy: boolean;
}

const INSTALL_TEXT: Record<InstallMethod, string> = {
  npm: "installed with npm. A newer version installs itself when nothing is busy; press to check for one now",
  bun: "installed with bun. A newer version installs itself when nothing is busy; press to check for one now",
  npx: "run with npx, which fetches the newest version itself. Press to check for one now",
  none: "run from a checkout, which does not update itself",
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
  const notice = selfNotice(self, repos);
  if (notice) {
    if (notice.busy) return { value: `${version}, rebuilding`, text: notice.text, act: "rebuild", busy: true };
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
    text: `Toyon ${version}, ${INSTALL_TEXT[install]}`,
    act: install === "none" ? null : "check",
    busy: false,
  };
}
