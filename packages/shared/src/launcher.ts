// toyon.cloud is a static page, in its own repository, that keeps a person's machines in their
// browser. It reads exactly this fragment, so a change to it is made there too. The CLI prints it
// after a deploy and the shell offers it on a machine's public name.

export const LAUNCHER_ORIGIN = "https://toyon.cloud";

/** the link that adds a machine to that list; it carries the address alone, never the token */
export const launcherAddLink = (machineOrigin: string): string =>
  `${LAUNCHER_ORIGIN}/#add=${encodeURIComponent(machineOrigin)}`;
