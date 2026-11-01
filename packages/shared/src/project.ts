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
/** `github.com/x/y` as a browser's address bar hands it over, scheme dropped: a dotted host, then
 * a path. A bare name has no dot and a path starts with `~`, `/` or `.`, so neither reads as one. */
const BARE_HOST_FORM = /^[\w-]+(?:\.[\w-]+)+\/\S+$/;

/** a clone source: where to clone from, the folder name to default to, and the branch to check
 * out when the URL was a page on one */
export type GitSource = { url: string; name: string; branch?: string };

/** the clone source a query names, or null if it names none */
export function gitUrl(raw: string): GitSource | null {
  const typed = raw.trim();
  const url = BARE_HOST_FORM.test(typed) ? `https://${typed}` : typed;
  if (!URL_FORM.test(url) && !SCP_FORM.test(url)) return null;
  const page = fromForgePage(url);
  const name = repoNameFrom(page?.url ?? url);
  if (!name || projectNameError(name)) return null;
  return page ? { url: page.url, name, ...(page.branch ? { branch: page.branch } : {}) } : { url, name };
}

/** what a forge's page path says past `owner/repo`: how many segments name the repository, and
 * the branch the page was on, if any */
type ForgeRead = { repo: string[]; branch?: string } | null;

/** Hosts whose page URLs people copy from the address bar in place of the clone URL: a file, a
 * branch, a pull request, the actions tab. Each is read back to the repository, and to the branch
 * when the page was on one. An unknown host is cloned as typed: a self-hosted forge's URL shape is
 * nobody's to guess here, and git says what it makes of it. */
const FORGES: Record<string, (segs: string[]) => ForgeRead> = {
  "github.com": (segs) => {
    if (segs.length < 2) return null;
    const [kind, ...rest] = segs.slice(2);
    // a branch may carry slashes, and the page people copy to mean "this branch" is its root, so
    // a tree URL is the branch whole; a folder under it reads as part of the name, and git says
    // so in its own words. A blob or commits page has a file path after the branch, so only its
    // first segment can be the branch, and a branch with a slash in it is the first segment of
    // itself: the default branch is what gets cloned then.
    const branch = kind === "tree" ? rest.join("/") : kind === "blob" || kind === "commits" ? rest[0] : undefined;
    return { repo: segs.slice(0, 2), branch };
  },
  "gitlab.com": (segs) => {
    // a group can hold subgroups, so the repository is every segment up to the `/-/` that
    // GitLab puts before a page's kind, and a URL with no `/-/` is the repository itself
    const cut = segs.indexOf("-");
    if (cut < 2) return segs.length >= 2 && cut < 0 ? { repo: segs } : null;
    const [kind, ...rest] = segs.slice(cut + 1);
    const branch = kind === "tree" ? rest.join("/") : kind === "blob" || kind === "commits" ? rest[0] : undefined;
    return { repo: segs.slice(0, cut), branch };
  },
  "codeberg.org": (segs) => {
    if (segs.length < 2) return null;
    // Gitea names what follows `src`: `src/branch/<name>/<path>`, `src/tag/...`, `src/commit/...`
    const [kind, what, ...rest] = segs.slice(2);
    const branch = kind === "src" && what === "branch" ? rest[0] : undefined;
    return { repo: segs.slice(0, 2), branch };
  },
};

/** an https URL on a known forge, read back to its repository and branch; null for anything else */
function fromForgePage(url: string): { url: string; branch?: string } | null {
  if (!/^https?:\/\//i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null; // not a URL the browser would have had in its bar; git gets it as typed
  }
  const read = FORGES[u.hostname.toLowerCase()]?.(u.pathname.split("/").filter(Boolean));
  if (!read) return null;
  const branch = read.branch ? decodeSegment(read.branch).replace(/\/+$/, "") : "";
  return { url: `${u.protocol}//${u.host}/${read.repo.join("/")}`, ...(branch ? { branch } : {}) };
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a stray percent sign: the branch is read as written
  }
}

/** the last path segment, without `.git`: what `git clone` would have named the folder itself */
function repoNameFrom(url: string): string {
  // a fragment or query is never part of the repo name, and a trailing slash is a typo, not a segment
  const bare = url.split(/[?#]/)[0]?.replace(/\/+$/, "") ?? "";
  const afterHost = SCP_FORM.test(bare) ? (bare.split(":")[1] ?? "") : bare;
  const last = afterHost.split("/").pop() ?? "";
  return last.replace(/\.git$/i, "");
}
