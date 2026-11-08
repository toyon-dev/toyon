// Where a repo keeps toyon's settings. Two places, one per repo: the `.toyon/` folder, which is
// where toyon writes a new file, or the repo root, for a repo that wants the file in plain sight.
// Each place holds a shared file (committed if the team wants it) and a local one beside it that
// overrides it for one person and is kept out of git by name.

import { parseDuration } from "./duration.ts";
import {
  DEFAULT_TIMEOUT_MS,
  type Owned,
  type ProcSource,
  type RunEntry,
  type RunKind,
  type ToyonConfig,
} from "./model.ts";

export const CONFIG_FILES = {
  folder: { shared: ".toyon/settings.json", local: ".toyon/settings.local.json" },
  root: { shared: "toyon.json", local: "toyon.local.json" },
} as const;

/** the folder a repo's settings live in when they are not at the root */
export const CONFIG_DIR = ".toyon";

/** the ceiling a kind of run has under these settings, in milliseconds: what `timeouts` says, else
 * the default. The schema has refused a duration that does not parse, so one that reaches here
 * and still does not is treated as unset rather than as zero. */
export function timeoutFor(config: Pick<ToyonConfig, "timeouts">, kind: RunKind): number {
  const text = config.timeouts?.[kind];
  return (text ? parseDuration(text) : null) ?? DEFAULT_TIMEOUT_MS;
}

/** the command of a `run` entry, whichever form it takes */
export function runCmd(entry: RunEntry): string {
  return typeof entry === "string" ? entry : entry.cmd;
}

/** what a `run` entry says about who runs it: the trunk for everyone (and, when its files cannot
 * be placed in the tree, no change flips it), every copy its own, or nothing (shared when its
 * files can be placed in the tree) */
export function runFrom(entry: RunEntry): "trunk" | "copy" | undefined {
  return typeof entry === "string" ? undefined : entry.from;
}

/** the paths a shared proc flips on, as written (the schema refuses an empty list); undefined
 * means infer them from the command */
export function runPaths(entry: RunEntry): string[] | undefined {
  return typeof entry === "string" ? undefined : entry.paths;
}

/** the proc's own setup commands; none for the short form */
export function runSetup(entry: RunEntry): string[] {
  return typeof entry === "string" ? [] : (entry.setup ?? []);
}

/** the proc's own teardown commands; none for the short form */
export function runTeardown(entry: RunEntry): string[] {
  return typeof entry === "string" ? [] : (entry.teardown ?? []);
}

/** the addresses a copy's page may point the proc at, by name; none for the short form */
export function runRemotes(entry: RunEntry): Record<string, string> {
  return typeof entry === "string" ? {} : (entry.remotes ?? {});
}

/** the remote a copy's page points a proc at, when it does */
export function remoteOf(at: ProcSource["at"]): string | undefined {
  return at && "remote" in at ? at.remote : undefined;
}

/** why a copy runs a proc itself, when it does */
export function ownedBy(at: ProcSource["at"]): Owned | undefined {
  return at && "by" in at ? at : undefined;
}

/** the proc a run's preview shows: the one named, else `web`, else the first */
export function previewProc(procs: string[], preferred: string | undefined): string | undefined {
  if (preferred && procs.includes(preferred)) return preferred;
  return procs.includes("web") ? "web" : procs[0];
}

/** whether the settings name the worktree anywhere a command runs: the sign that a database or a
 * compose project is made per worktree rather than shared by all of them */
export function keepsCopiesApart(config: ToyonConfig): boolean {
  const commands = [
    ...(config.setup ?? []),
    ...(config.teardown ?? []),
    ...Object.values(config.run).flatMap((e) => [runCmd(e), ...runSetup(e), ...runTeardown(e)]),
  ];
  return commands.some((c) => c.includes("TOYON_WORKTREE"));
}

/** a local file: one person's, never committed */
export function isLocalConfigFile(rel: string): boolean {
  return rel === CONFIG_FILES.folder.local || rel === CONFIG_FILES.root.local;
}

/** which of a place's pair a settings file is: the shared one git sees, or one person's */
export type ConfigFileKind = "shared" | "local";

export function configFileKind(rel: string): ConfigFileKind {
  return isLocalConfigFile(rel) ? "local" : "shared";
}

/** the file of `kind` in the same place as `rel`: what the setup pane's choice between committed
 * and kept local turns the file a save would write into. A path in neither place gets the folder. */
export function configSibling(rel: string, kind: ConfigFileKind): string {
  const place = Object.values(CONFIG_FILES).find((p) => p.shared === rel || p.local === rel) ?? CONFIG_FILES.folder;
  return place[kind];
}
