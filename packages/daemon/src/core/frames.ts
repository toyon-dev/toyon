// Rendered pages on an origin of their own. The editor pane's html view runs a page's scripts, and
// a page in a cloned repo is nobody's to trust, so it is never served where the shell or the token
// lives: the frame origin (server/frames.ts) holds nothing but these tickets. A ticket is the
// capability for one page. It reads that page and the files the page names, decided here when it
// is minted, and nothing else, for a fixed while. The page can always read its own address and
// send it somewhere, which no browser prevents, so a leaked ticket has to be worth little: a few
// pictures and stylesheets, for a few minutes.

import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { FILE_MAX_CHARS, type FrameSource, isPageAsset, renderedAs, viewerOf } from "@toyon/shared";
import { canonical, within } from "../agent/bounds.ts";
import { UserError } from "./errors.ts";
import { sameSecret } from "./remote.ts";

/** how long a ticket lasts, from minting and never extended */
export const FRAME_TTL_MS = 15 * 60_000;
/** how many references a page may name before the rest are left out */
export const FRAME_REFS_MAX = 256;
/** the most of one stylesheet read for the files it names, and the most read for one ticket */
const CSS_READ_MAX = 1_000_000;
const READ_BUDGET = 8_000_000;
/** the text held for pages nothing on disk holds, across every live ticket */
const TEXT_BUDGET = 32_000_000;
const LIVE_MAX = 64;
/** a loose page reaches its own folder and one below, no further: its folder may be a home directory */
const LOOSE_DEPTH = 2;

export interface Ticket {
  code: string;
  until: number;
  /** the page's key: its path under the root, which is the address's path too */
  page: string;
  /** what the keys hang off, canonical; null for a page held as text */
  root: string | null;
  /** the page's bytes when nothing on disk holds it */
  text: string | null;
  /** the files the page names, by key */
  files: ReadonlySet<string>;
}

export interface FrameTicketDeps {
  /** a worktree's directory, for one toyon runs or found; null for an id it does not know */
  worktreeRoot: (worktreeId: string) => string | null;
  /** the path behind a loose grant (files/open.ts); null for an id this daemon never granted */
  grantPath: (grantId: string) => string | null;
  /** paths a page never reaches beside itself: the daemon's own state and credentials */
  refused: string[];
  now?: () => number;
}

export class FrameTickets {
  private live: Ticket[] = [];

  constructor(private d: FrameTicketDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** a ticket for `source`: what the page may reach is fixed now. A `UserError` is the shell's to read. */
  async mint(source: FrameSource): Promise<{ code: string; page: string; ms: number }> {
    this.sweep();
    const scope = await this.scope(source);
    const code = randomBytes(16).toString("base64url");
    // the page's last ticket goes: the shell asks again on every save, and a run of saves would
    // otherwise push the tickets of every other open page out of the count
    if (scope.root !== null) this.live = this.live.filter((t) => t.root !== scope.root || t.page !== scope.page);
    this.live.push({ code, until: this.now() + FRAME_TTL_MS, ...scope });
    this.trim();
    return { code, page: scope.page, ms: FRAME_TTL_MS };
  }

  /** the live ticket for `code`, or null */
  get(code: string): Ticket | null {
    this.sweep();
    return this.live.find((t) => sameSecret(code, t.code)) ?? null;
  }

  /** Where the file at `key` under the ticket is, checked again now: the key must be one the page
   * named, and the path under the root must still be plain files and folders all the way down. A
   * file swapped for a link since the mint is gone. Null for anything else. */
  async file(t: Ticket, key: string): Promise<{ path: string } | { text: string } | null> {
    if (key === t.page) {
      if (t.text !== null) return { text: t.text };
      if (t.root === null) return null;
      return (await plainFile(t.root, key)) ? { path: join(t.root, key) } : null;
    }
    if (t.root === null || !t.files.has(key)) return null;
    return (await plainFile(t.root, key)) ? { path: join(t.root, key) } : null;
  }

  private async scope(source: FrameSource): Promise<Omit<Ticket, "code" | "until">> {
    if (source.kind === "text") {
      if (source.text.length > FILE_MAX_CHARS) throw new UserError("the page is too large to render");
      return { page: "page.html", root: null, text: source.text, files: new Set() };
    }
    let root: string;
    let page: string;
    let depth = Number.POSITIVE_INFINITY;
    if (source.kind === "worktree") {
      const dir = this.d.worktreeRoot(source.worktreeId);
      if (!dir) throw new UserError("that worktree is not one Toyon knows");
      root = canonical(resolve(dir));
      page = source.path;
      if (!plainKey(page) || renderedAs(page) !== "html") throw new UserError("only an html page is rendered");
    } else {
      const path = this.d.grantPath(source.grantId);
      if (!path) throw new UserError("that file is no longer open here: open it again");
      root = canonical(dirname(resolve(path)));
      page = basename(path);
      if (renderedAs(page) !== "html") throw new UserError("only an html page is rendered");
      depth = LOOSE_DEPTH;
    }
    if (!(await plainFile(root, page))) throw new UserError("the page is not a plain file in its folder");
    const pageFile = Bun.file(join(root, page));
    if (pageFile.size > FILE_MAX_CHARS) throw new UserError("the page is too large to render");
    let budget = READ_BUDGET - pageFile.size;
    const refs = await collectRefs(await pageFile.text(), page);
    const files = new Set<string>();
    const keep = async (key: string) => {
      if (files.size >= FRAME_REFS_MAX || files.has(key) || key === page) return false;
      if (key.split("/").length > depth) return false;
      if (viewerOf(key) === null && !isPageAsset(key)) return false;
      if (this.d.refused.some((r) => within(join(root, key), canonical(resolve(r))))) return false;
      if (!(await plainFile(root, key))) return false;
      files.add(key);
      return true;
    };
    for (const key of refs) {
      if (!(await keep(key))) continue;
      // one level: the files a stylesheet names, not what those name in turn
      if (!/\.css$/i.test(key)) continue;
      const css = Bun.file(join(root, key));
      if (css.size > CSS_READ_MAX || css.size > budget) continue;
      budget -= css.size;
      for (const inner of cssRefs(await css.text(), key)) await keep(inner);
    }
    return { page, root, text: null, files };
  }

  private sweep() {
    const t = this.now();
    this.live = this.live.filter((x) => t < x.until);
  }

  /** the oldest go first, past the count or past the memory the text pages take */
  private trim() {
    while (this.live.length > LIVE_MAX) this.live.shift();
    let text = this.live.reduce((n, t) => n + (t.text?.length ?? 0), 0);
    while (text > TEXT_BUDGET && this.live.length > 1) {
      const gone = this.live.shift();
      text -= gone?.text?.length ?? 0;
    }
  }
}

/** The attributes a page reaches beside itself through: a picture, a stylesheet, a poster, a clip's
 * source, an object. A script is not one: a .js served from the frame would be the page reading
 * the worktree's source, and the daemon serves none. */
const REFS: [string, string][] = [
  ["img[src]", "src"],
  ["source[src]", "src"],
  ["video[src]", "src"],
  ["audio[src]", "src"],
  ["video[poster]", "poster"],
  ["link[href]", "href"],
  ["object[data]", "data"],
  ["image[href]", "href"],
];
/** a picture offered at several sizes: each candidate is an address followed by its descriptor */
const SRCSETS = ["img[srcset]", "source[srcset]"];

/** the keys a page's markup names, in order, relative to the root; a reference the browser would
 * not resolve under the page's address (absolute, another origin, a fragment) is not one */
export async function collectRefs(html: string, page: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const dir = dirname(page) === "." ? "" : dirname(page);
  let rewriter = new HTMLRewriter();
  for (const [selector, attr] of REFS) {
    rewriter = rewriter.on(selector, {
      element(el) {
        if (out.length >= FRAME_REFS_MAX) return;
        const key = keyOf(dir, el.getAttribute(attr) ?? "", page);
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(key);
        }
      },
    });
  }
  const add = (key: string | null) => {
    if (key && !seen.has(key) && out.length < FRAME_REFS_MAX) {
      seen.add(key);
      out.push(key);
    }
  };
  for (const selector of SRCSETS) {
    rewriter = rewriter.on(selector, {
      element(el) {
        for (const candidate of (el.getAttribute("srcset") ?? "").split(",")) {
          add(keyOf(dir, candidate.trim().split(/\s+/)[0] ?? "", page));
        }
      },
    });
  }
  // a style block names files as a stylesheet does, against the page's own folder
  let style = "";
  rewriter = rewriter.on("style", {
    text(t) {
      style += t.text;
      if (t.lastInTextNode) {
        for (const key of cssRefs(style, page)) add(key);
        style = "";
      }
    },
  });
  await rewriter.transform(new Response(html)).text();
  return out;
}

/** the keys a stylesheet names: `url()` and `@import`, resolved against the stylesheet's own folder */
export function cssRefs(css: string, sheet: string): string[] {
  const out: string[] = [];
  const dir = dirname(sheet) === "." ? "" : dirname(sheet);
  const add = (ref: string | undefined) => {
    const key = ref === undefined ? null : keyOf(dir, ref, sheet);
    if (key && !out.includes(key)) out.push(key);
  };
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/g)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/g)) add(m[1]);
  return out.slice(0, FRAME_REFS_MAX);
}

/** The key a reference from the file at `dir/from` names, resolved as the browser resolves it
 * against `/<ticket>/<from>`: `..` and `.` folded, the query and fragment dropped, each segment
 * decoded. Null for a reference that lands outside the ticket, names another origin or scheme,
 * or has a segment that starts with a dot (`.env`, `.git`, a dot folder), which no page reaches. */
export function keyOf(dir: string, ref: string, from: string): string | null {
  const r = ref.trim();
  if (r === "" || r.startsWith("#") || r.startsWith("/") || r.startsWith("\\") || /^[a-z][a-z\d+.-]*:/i.test(r)) {
    return null;
  }
  const base = `http://x/t/${[...(dir ? dir.split("/") : []), basename(from)].map(encodeURIComponent).join("/")}`;
  let u: URL;
  try {
    u = new URL(r, base);
  } catch {
    return null;
  }
  if (u.host !== "x" || !u.pathname.startsWith("/t/")) return null;
  const out: string[] = [];
  for (const seg of u.pathname.slice(3).split("/")) {
    let d: string;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (d === "" || d.startsWith(".") || d.includes("/") || d.includes("\\") || d.includes("\0")) return null;
    out.push(d);
  }
  return out.length ? out.join("/") : null;
}

/** a key as the shell may name one: segments that are names, none starting with a dot */
const plainKey = (key: string) =>
  key !== "" && key.split("/").every((s) => s !== "" && !s.startsWith(".") && !/[\\\0]/.test(s));

/** whether `key` under `root` is a regular file reached through plain folders: no component is a
 * link, so the name checked is the file served, and nothing points out of the root */
export async function plainFile(root: string, key: string): Promise<boolean> {
  if (!plainKey(key)) return false;
  let at = root;
  const segs = key.split("/");
  for (let i = 0; i < segs.length; i++) {
    at = join(at, segs[i] as string);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(at);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return false;
    // a file with a second name on disk (a hard link) is read by the other name's rules, not this one's
    if (st.isFile() && st.nlink > 1) return false;
    if (i < segs.length - 1 ? !st.isDirectory() : !st.isFile()) return false;
  }
  return true;
}
