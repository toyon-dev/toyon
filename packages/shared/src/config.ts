// Where a repo keeps toyon's settings. Two places, one per repo: the `.toyon/` folder, which is
// where toyon writes a new file, or the repo root, for a repo that wants the file in plain sight.
// Each place holds a shared file (committed if the team wants it) and a local one beside it that
// overrides it for one person and is kept out of git by name.

export const CONFIG_FILES = {
  folder: { shared: ".toyon/settings.json", local: ".toyon/settings.local.json" },
  root: { shared: "toyon.json", local: "toyon.local.json" },
} as const;

/** the folder a repo's settings live in when they are not at the root */
export const CONFIG_DIR = ".toyon";

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
