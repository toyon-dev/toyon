// The commands toyon adds to the `/` menu of its own: names a hand types from habit, for what the
// mode chip and the send seat already do. The agent's advertised list is the rest of the menu and
// stays as given. Pure, like mentions.ts, so the rules have tests; Composer.tsx runs the actions.
// A name earns a row only where toyon already owns the action; an agent's own command is never
// reimplemented here, and a name with no home in the shell (clear, cost, todos) gets no row.

import { type AgentCommand, PERMISSION_MODES, type PermissionMode } from "@toyon/shared";

/** the names toyon answers itself: a mode, or the seat's verb */
export type OwnName = PermissionMode | "check" | "land" | "archive";

/** a draft that leads with one of toyon's own commands: the name, and whatever followed it */
export type OwnInvocation = { name: OwnName; args: string };

export const isMode = (name: string): name is PermissionMode => PERMISSION_MODES.some((m) => m.id === name);

/** the rows: each mode with its chip's line and a description as its argument, then the seat's
 * verbs, land described the way the repo's settings have it (`describeLand`) */
export function ownCommands(landLine: string): AgentCommand[] {
  return [
    ...PERMISSION_MODES.map((m) => ({ name: m.id, description: m.description, hint: "[<description>]" })),
    { name: "check", description: "run the repo's check here and write the recap and the commit message" },
    { name: "land", description: landLine },
    { name: "archive", description: "archive this worktree once its work has landed" },
  ];
}

/** toyon's rows ahead of the agent's, minus any agent row named like one of toyon's. An agent's
 * own `plan` switches the agent for one turn while the chip never knew, so the typed name goes to
 * the chip; the agent's mode is still what toyon sets on its behalf. */
export function mergeCommands(own: AgentCommand[], agent: AgentCommand[]): AgentCommand[] {
  const taken = new Set(own.map((c) => c.name));
  return [...own, ...agent.filter((c) => !taken.has(c.name))];
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
