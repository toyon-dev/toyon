// The commands toyon adds to the `/` menu of its own: names a hand types from habit, for what the
// mode chip and the send seat already do. The agent's advertised list is the rest of the menu and
// stays as given. Pure, like mentions.ts, so the rules have tests; Composer.tsx runs the actions.
// A name earns a row only where toyon already owns the action; an agent's own command is never
// reimplemented here, and a name with no home in the shell (clear, cost, todos) gets no row.

import { type AgentCommand, PERMISSION_MODES, type PermissionMode, type RepoInfo } from "@toyon/shared";

/** the names toyon answers itself: a mode, the seat's verb, or a new worktree for part of the
 * work, here or in another open project */
export type OwnName = PermissionMode | "check" | "land" | "archive" | "handoff";

/** a draft that leads with one of toyon's own commands: the name, and whatever followed it */
export type OwnInvocation = { name: OwnName; args: string };

export const isMode = (name: string): name is PermissionMode => PERMISSION_MODES.some((m) => m.id === name);

/** the rows: each mode with its chip's line and a description as its argument, then the seat's
 * verbs, land described the way the repo's settings have it (`describeLand`) */
export function ownCommands(landLine: string): AgentCommand[] {
  return [
    ...PERMISSION_MODES.map((m) => ({ name: m.id, description: m.description, hint: "[<description>]" })),
    {
      name: "check",
      description: "run the repo's check here and write the recap and the commit message",
      hint: "[<note for the commit message>]",
    },
    { name: "land", description: landLine },
    { name: "archive", description: "archive this worktree once its work has landed" },
    {
      name: "handoff",
      description: "a new worktree for part of this work, here or in another project, born with a plan for it",
      hint: "<project> [<message>]",
    },
  ];
}

/** what `/handoff <project> [text]` means: the project the new worktree goes in and the person's
 * own words, the picker when nothing was named, or why the name does not pick one */
export type HandoffArgs = { repo: RepoInfo; text?: string } | { error: string } | { pick: true };

/** The first word names the project, by its name as listed: an exact match first (case does not
 * matter), else the one project whose name starts with it; `here`, or this worktree's own
 * project, means a new worktree here. The rest is the person's own words for what it should do. */
export function parseHandoffArgs(args: string, repos: readonly RepoInfo[], hereRepoId: string): HandoffArgs {
  const trimmed = args.trim();
  if (!trimmed) return { pick: true };
  const gap = trimmed.search(/\s/);
  const word = gap === -1 ? trimmed : trimmed.slice(0, gap);
  // the words as typed: the message is theirs, and its spacing is not this parser's to tidy
  const text = gap === -1 ? undefined : trimmed.slice(gap).trim() || undefined;
  const needle = word.toLowerCase();
  const own = repos.find((r) => r.id === hereRepoId);
  if (needle === "here" && own) return { repo: own, ...(text ? { text } : {}) };
  const exact = repos.filter((r) => r.name.toLowerCase() === needle);
  const hits = exact.length > 0 ? exact : repos.filter((r) => r.name.toLowerCase().startsWith(needle));
  if (hits.length === 0) return { error: `no open project named "${word}"` };
  if (hits.length > 1) return { error: `"${word}" names more than one project` };
  return { repo: hits[0]!, ...(text ? { text } : {}) };
}

/** the `/` menu's three tiers, in rank order: the person's own skills and commands (the ones the
 * daemon found on disk, in the agent's order), toyon's, then the rest of the agent's as given.
 * An agent row named like one of toyon's is dropped wherever it came from: an agent's own `plan`
 * switches the agent for one turn while the chip never knew, so the typed name goes to the chip;
 * the agent's mode is still what toyon sets on its behalf. */
export function commandTiers(own: AgentCommand[], agent: AgentCommand[]) {
  const taken = new Set(own.map((c) => c.name));
  const free = agent.filter((c) => !taken.has(c.name));
  return { yours: free.filter((c) => c.origin), own, rest: free.filter((c) => !c.origin) };
}

/** every row, tier by tier: what a typed letter searches, and the order a tie falls back on */
export function mergeCommands(own: AgentCommand[], agent: AgentCommand[]): AgentCommand[] {
  const t = commandTiers(own, agent);
  return [...t.yours, ...t.own, ...t.rest];
}

/** the menu before a letter is typed: the person's own rows and toyon's, the way the agent's own
 * terminal leads with what the person wrote, and how many of the agent's a letter would find. The
 * built-ins are many and the same in every project, so they wait for a letter instead of burying
 * the rows made for this one. */
export function browseCommands(own: AgentCommand[], agent: AgentCommand[]): { rows: AgentCommand[]; more: number } {
  const t = commandTiers(own, agent);
  return { rows: [...t.yours, ...t.own], more: t.rest.length };
}

/** the command a draft leads with, when it is one of toyon's; null for a message, a `!` command or
 * an agent's command. The name is everything up to the first space, the way triggerAt reads it;
 * the rest, trimmed, is the arguments. */
export function ownCommandOf(text: string, own: AgentCommand[]): OwnInvocation | null {
  const m = /^\/(\S*)([\s\S]*)$/.exec(text);
  if (!m) return null;
  const name = m[1] ?? "";
  if (!own.some((c) => c.name === name)) return null;
  return { name: name as OwnName, args: (m[2] ?? "").trim() };
}
