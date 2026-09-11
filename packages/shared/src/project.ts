// Rules about a new project's name and source that the daemon and the shell must agree on: the
// picker offers a row, the form disables a button, and the daemon throws on the same input. Two
// copies of these rules would disagree the first time either changed.

/** The folder under home a first project goes in when there are no others to put it beside. The
 * shell offers `~/Projects` and the daemon makes this one missing parent, so the two must name it
 * the same way. */
export const PROJECTS_FOLDER = "Projects";

/** Control characters and DEL. `\s` does not cover them and a filesystem will happily take one, so
 * a name carrying one would render as something other than what it is everywhere it appeared.
 * Written as a code-point scan rather than a regex: the character class would need literal control
 * bytes in the source, which every editor and diff viewer renders differently. */
function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A folder name that is safe to make, safe to pass to git, and not a surprise once it exists.
 * Returns the reason it is unusable, or null when it is fine. Unicode is allowed: a project named
 * `café` is ordinary, and the things worth refusing are structural rather than alphabetic. */
export function projectNameError(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "a project name is required";
  if (name.length > 100) return "that name is too long: keep it under 100 characters";
  if (name.includes("/") || name.includes("\\")) return "a project name cannot contain a slash";
  if (/\s/.test(name)) return "a project name cannot contain spaces";
  if (hasControlChar(name)) return "a project name cannot contain control characters";
  if (name === "." || name === "..") return `"${name}" is not a project name`;
  // a leading dash reads as a flag to git, and a leading dot hides the folder from the person who made it
  if (name.startsWith("-") || name.startsWith(".")) return "a project name cannot start with a dot or a dash";
  return null;
}

/** `https://`, `ssh://`, `git://` and the scp-like `git@host:owner/repo` form. A plain filesystem
 * path is deliberately not a URL here: the picker routes those down the path-completion branch, and
 * treating them as clone sources would make every typed folder look like a remote. */
const URL_FORM = /^(?:https?|ssh|git|file):\/\/\S+$/i;
const SCP_FORM = /^[\w.-]+@[\w.-]+:\S+$/;

/** the clone source a query names, and the folder name to default to, or null if it names none */
export function gitUrl(raw: string): { url: string; name: string } | null {
  const url = raw.trim();
  if (!URL_FORM.test(url) && !SCP_FORM.test(url)) return null;
  const name = repoNameFrom(url);
  return name && !projectNameError(name) ? { url, name } : null;
}

/** the last path segment, without `.git`: what `git clone` would have named the folder itself */
function repoNameFrom(url: string): string {
  // a fragment or query is never part of the repo name, and a trailing slash is a typo, not a segment
  const bare = url.split(/[?#]/)[0]?.replace(/\/+$/, "") ?? "";
  const afterHost = SCP_FORM.test(bare) ? (bare.split(":")[1] ?? "") : bare;
  const last = afterHost.split("/").pop() ?? "";
  return last.replace(/\.git$/i, "");
}
