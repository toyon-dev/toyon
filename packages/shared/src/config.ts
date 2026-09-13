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
