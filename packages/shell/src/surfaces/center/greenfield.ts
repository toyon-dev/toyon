import { CONFIG_FILES } from "@toyon/shared";

/** Rides behind the first message on an empty project, out of the transcript, the way the
 * live-page context does. The agent picks the stack from what the message describes; nothing here
 * is a scaffold toyon runs. */
export function greenfieldContext(name: string, configFile: string = CONFIG_FILES.folder.shared): string {
  return `[New project: ${name}. The repository is empty apart from a root commit. Pick the mainstream stack for what the message describes, and say which in your first sentence; if the message names a stack, that wins. Scaffold it in this directory, write its .gitignore before installing anything, make it start on $PORT, and write ${configFile}.]`;
}
