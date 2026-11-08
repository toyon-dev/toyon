// Where a shared command runs for one worktree's page: main's copy, this worktree's own, or a
// remote the page was pointed at. Pure, so the chip's rows, words and sends are tested as data;
// SourceChip.tsx draws them.

import type { ClientMsg, OwnedWorktree, RepoInfo, TrunkStatus } from "@toyon/shared";
import { ownedBy, remoteOf, runRemotes } from "@toyon/shared";
import type { ChipOption } from "../../ui/ChipPicker.tsx";
import { dirtyNote } from "./baseNote.ts";

/** main's copy, this worktree's own, or one of the command's remotes by name */
export type Source = "main" | "here" | `remote:${string}`;
export type SourceOption = ChipOption<Source>;

const remoteIn = (s: Source): string | null => (s.startsWith("remote:") ? s.slice("remote:".length) : null);

/** where the named command runs for this worktree, as the record says: a remote it was pointed
 * at, its own, else main's */
export function sourceOf(name: string, wt: Pick<OwnedWorktree, "worktree">): Source {
  const at = wt.worktree.sources?.[name]?.at;
  const remote = remoteOf(at);
  if (remote !== undefined) return `remote:${remote}`;
  return ownedBy(at) ? "here" : "main";
}

/** the chip's state: its value, whether it is held (the page is not talking to this worktree's
 * edits), its tooltip, and the rows it opens into, in the order they are reached for */
export function sourceOptions(
  name: string,
  wt: Pick<OwnedWorktree, "worktree" | "borrowed" | "remoteBehind">,
  repo: Pick<RepoInfo, "config">,
  trunk: Pick<TrunkStatus, "dirty"> | null,
): { value: Source; held: boolean; hint: string; options: SourceOption[] } {
  const value = sourceOf(name, wt);
  const held = wt.remoteBehind?.includes(name) ?? false;
  const dirty = trunk?.dirty ?? 0;
  const mainState = wt.borrowed?.find((b) => b.name === name)?.status;
  const down = mainState !== undefined && mainState !== "running" && mainState !== "starting" && mainState !== "cold";
  const mainDesc = [
    "main runs it for every worktree",
    ...(dirty > 0 ? [dirtyNote(dirty, name)] : []),
    ...(down ? [`main's ${name} is ${mainState}`] : []),
  ].join("; ");
  const main: SourceOption = { id: "main", label: "main", chip: `${name} · main`, description: mainDesc };
  const here: SourceOption = {
    id: "here",
    label: "here",
    chip: `${name} · here`,
    description: "this worktree runs its own",
  };
  const remotes: SourceOption[] = Object.entries(runRemotes(repo.config.run[name] ?? "")).map(([r, url]) => ({
    id: `remote:${r}`,
    label: r,
    chip: `${name} · ${r}`,
    description: url,
  }));
  const options = held ? [here, main, ...remotes] : [main, here, ...remotes];
  let hint: string;
  if (held) hint = `${name} edits here are not what the page is talking to; pick here to run them`;
  else if (value === "main") {
    hint = `${name} runs on main for every worktree${dirty > 0 ? `; ${dirtyNote(dirty, name)}` : ""}. Click to change`;
  } else if (value === "here") hint = `${name} runs here: this worktree's own. Click to change`;
  else hint = `${name} points at ${remoteIn(value)} for this worktree. Click to change`;
  return { value, held, hint, options };
}

/** the frame a pick sends, and the question asked before it when there is one (handing a proc the
 * worktree runs back to main's drops what it held); null when nothing changes */
export function sourcePick(
  name: string,
  from: Source,
  to: Source,
  worktreeId: string,
): { msg: ClientMsg; confirm?: string } | null {
  if (from === to) return null;
  const remote = remoteIn(to);
  const source = remote !== null ? { remote } : to === "main" ? ("main" as const) : ("here" as const);
  const msg: ClientMsg = { t: "set-proc-source", worktreeId, name, source };
  if (to === "main" && from === "here") {
    return {
      msg,
      confirm: `Stop this worktree's own ${name} and use main's?\n\nWhat they hold that main's do not (a database of their own) is not carried over.`,
    };
  }
  return { msg };
}
