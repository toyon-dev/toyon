import { type AgentInfo, agentDefault, defaultStandsFor, type ModelChoice } from "@toyon/shared";
import type { ChipOption } from "../../ui/ChipPicker.tsx";

/** the empty id: the agent's own default, which is what a worktree runs until a value is named */
export const DEFAULT_OPTION = "";

/** The rows for one of an agent's select options (its model, its effort level) and which row the
 * value is. `value` is the record's request, `current` what the session reported.
 *
 * An agent that lists its own default row is taken at its word: that row stands in for the empty
 * option and no second "default" is drawn beside it. When that row only names another (Claude's
 * "Default" is "Opus"), the named row is drawn in place of both and marked recommended, so one
 * model is never two rows; not picking still follows the agent, picking it pins it. */
export function choiceRows(
  choices: ModelChoice[],
  value: string,
  current: string | undefined,
  empty: { label: string; description: string },
): { rows: ChipOption<string>[]; shown: string } {
  const own = agentDefault(choices);
  const named = defaultStandsFor(choices);
  // the default's id (what the session reports when nothing is asked, or a record that asked for
  // it) reads as the row it names
  const requested = value || current || own?.id || DEFAULT_OPTION;
  const shown = named && requested === own?.id ? named.id : requested;
  const listed = named ? choices.filter((c) => c !== own) : choices;
  const known = listed.some((c) => c.id === shown);
  const rows: ChipOption<string>[] = [
    ...(own ? [] : [{ id: DEFAULT_OPTION, label: empty.label, description: empty.description }]),
    ...listed.map((c) => ({
      id: c.id,
      label: c.name,
      description: c === named ? ["recommended", c.description].filter(Boolean).join(" · ") : c.description,
    })),
    // the session reported something the list does not carry: show it rather than lie
    ...(shown && !known ? [{ id: shown, label: shown }] : []),
  ];
  return { rows, shown };
}

/** A row on a new worktree's picker names the agent and its model together. Registry ids are
 * lowercase letters, digits and dashes, so the space is never part of one. */
export const agentModelKey = (agent: string, model: string) => `${agent} ${model}`;

export function splitAgentModel(key: string): { agent: string; model: string } {
  const at = key.indexOf(" ");
  return at < 0 ? { agent: key, model: DEFAULT_OPTION } : { agent: key.slice(0, at), model: key.slice(at + 1) };
}

/** Every agent's models in one list, under each agent's name, for a worktree that does not exist
 * yet: picking a model picks the agent that runs it. An agent that is not installed is one dimmed
 * row with the reason, and one that has never listed its models (not logged in yet) is one row
 * for its own default, so every agent can still be chosen. With a single agent there are no
 * headings. */
export function agentModelRows(
  agents: AgentInfo[],
  agent: string,
  model: string,
): { rows: ChipOption<string>[]; shown: string } {
  const grouped = agents.length > 1;
  let shown = agentModelKey(agent, model);
  const rows = agents.flatMap((a): ChipOption<string>[] => {
    const group = grouped ? a.name : undefined;
    const mine = a.id === agent;
    if (!a.available || !a.models?.length) {
      if (mine) shown = agentModelKey(a.id, DEFAULT_OPTION);
      return [
        {
          id: agentModelKey(a.id, DEFAULT_OPTION),
          label: a.name,
          description: !a.available
            ? `not installed: ${a.reason ?? ""}`
            : "its own default model; the rest are listed once it has run",
          disabled: !a.available,
          group,
        },
      ];
    }
    const r = choiceRows(a.models, mine ? model : DEFAULT_OPTION, undefined, {
      label: `${a.name} default`,
      description: `whatever ${a.name} runs when nothing is asked for`,
    });
    if (mine) shown = agentModelKey(a.id, r.shown);
    return r.rows.map((o) => ({ ...o, id: agentModelKey(a.id, o.id), group }));
  });
  return { rows, shown };
}
