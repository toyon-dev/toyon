// The files tab's tree, built from the worktree's file list. Pure, so the rules are testable: the
// shell has no React harness.

import type { GitFileStatus } from "@toyon/shared";
import { ancestors, naturalCompare } from "../util.ts";

export type TreeKind = "file" | "folder" | "submodule";

export interface TreeNode {
  path: string;
  name: string;
  kind: TreeKind;
  children: TreeNode[];
}

/** one line the tree draws: a node at its depth, and whether a folder is open */
export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  kind: TreeKind;
  open: boolean;
}

/** the tree's top level: folders first, then files, each in natural order (file2 before file10) */
export function buildTree(paths: readonly string[], submodules: readonly string[] = []): TreeNode[] {
  const root: TreeNode = { path: "", name: "", kind: "folder", children: [] };
  const folders = new Map<string, TreeNode>([["", root]]);
  const folder = (path: string): TreeNode => {
    const found = folders.get(path);
    if (found) return found;
    const slash = path.lastIndexOf("/");
    const node: TreeNode = { path, name: path.slice(slash + 1), kind: "folder", children: [] };
    folder(slash === -1 ? "" : path.slice(0, slash)).children.push(node);
    folders.set(path, node);
    return node;
  };
  const leaf = (path: string, kind: TreeKind) => {
    const slash = path.lastIndexOf("/");
    const parent = folder(slash === -1 ? "" : path.slice(0, slash));
    parent.children.push({ path, name: path.slice(slash + 1), kind, children: [] });
  };
  for (const p of paths) leaf(p, "file");
  for (const p of submodules) leaf(p, "submodule");
  const sort = (node: TreeNode) => {
    // a submodule reads as a folder, so it sorts with them
    const rank = (n: TreeNode) => (n.kind === "file" ? 1 : 0);
    node.children.sort((a, b) => rank(a) - rank(b) || naturalCompare(a.name, b.name));
    for (const c of node.children) if (c.kind === "folder") sort(c);
  };
  sort(root);
  return root.children;
}

/** the rows on screen: every node whose folders are all open */
export function visibleRows(nodes: readonly TreeNode[], isOpen: (path: string) => boolean): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (list: readonly TreeNode[], depth: number) => {
    for (const n of list) {
      const open = n.kind === "folder" && isOpen(n.path);
      out.push({ path: n.path, name: n.name, depth, kind: n.kind, open });
      if (open) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

/** what the tree marks: each changed file's status, and the folders with a change somewhere inside */
export interface TreeMarks {
  files: Map<string, GitFileStatus>;
  folders: Set<string>;
}

export function marks(status: readonly GitFileStatus[]): TreeMarks {
  const files = new Map<string, GitFileStatus>();
  const folders = new Set<string>();
  for (const s of status) {
    // an untracked folder listed whole ("?? src/new/") marks itself and what holds it
    const path = s.path.endsWith("/") ? s.path.slice(0, -1) : s.path;
    if (path === s.path) files.set(path, s);
    else folders.add(path);
    for (const a of ancestors(path)) folders.add(a);
  }
  return { files, folders };
}

/**
 * What decides that the file list is stale: the commit checked out, and the paths git says were
 * added, deleted or are untracked. An edit to a file that exists changes none of it, so an agent's
 * tool calls do not refetch the list. HEAD catches a rebase or pull that adds files while the
 * status stays clean; it also refetches after a plain commit, which costs one listing.
 */
export function listingKey(head: string | undefined, status: readonly GitFileStatus[]): string {
  const moved: string[] = [];
  for (const s of status) {
    if (s.xy.includes("D")) moved.push(`-${s.path}`);
    else if (/[?ARC]/.test(s.xy)) moved.push(`+${s.path}`);
  }
  return `${head ?? ""}\n${moved.sort().join("\n")}`;
}
