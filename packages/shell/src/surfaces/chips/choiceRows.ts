import { type AgentInfo, agentDefault, defaultStandsFor, type ModelChoice } from "@toyon/shared";
import type { ChipOption } from "../../ui/ChipPicker.tsx";

/** the empty id: the agent's own default, which is what a worktree runs until a value is named */
export const DEFAULT_OPTION = "";

/** A choice's words, split the way the picker draws them: a label, a version a tier quieter after
 * it, and a line under it keeping only what the name does not say. The two builtin agents spell a
 * model two ways. Claude names one "Opus (1M context)" and describes it "Opus 5 with 1M context ·
 * Best for everyday, complex tasks", so the row says "Opus 5" over "1M context · Best for everyday,
 * complex tasks". Codex puts the version inside the name, "GPT-5.6-Sol", and its description never
 * repeats it, so the row says "Sol 5.6", or "GPT 5.5" for a model with no codename. Anything else
 * (every effort level, a name with more parts than that) is left as the agent wrote it. */
export function modelWords(c: ModelChoice): { label: string; version?: string; description?: string } {
  // only a capitalised word counts as a codename, so a slug like "gemini-2.5-pro" stays whole
  const dashed = c.name.match(/^([A-Za-z]+)-(\d+(?:\.\d+)*)(?:-([A-Z][a-z]+))?$/);
  if (dashed?.[1] && dashed[2]) {
    return {
      label: dashed[3] ?? dashed[1],
      version: dashed[2],
      ...(c.description ? { description: c.description } : {}),
    };
  }
  const [head = "", ...rest] = (c.description ?? "").split(" · ");
  const base = c.name.replace(/\s*\([^)]*\)$/, "");
  const m = head.match(/^(.+?) (\d+(?:\.\d+)*)(?: with (.+))?$/);
  if (!m?.[2] || m[1] !== base) return { label: c.name, ...(c.description ? { description: c.description } : {}) };
  // the qualifier survives in the line under the name, from the description or else the name's own parentheses
  const qualifier = m[3] ?? c.name.match(/\(([^)]*)\)$/)?.[1];
  const description = [qualifier, ...rest].filter(Boolean).join(" · ");
  return { label: base, version: m[2], ...(description ? { description } : {}) };
}

/** The rows for one of an agent's select options (its model, its effort level) and which row the
 * value is. `value` is the record's request, `current` what the session reported.
 *
 * An agent that lists its own default row is taken at its word: that row stands in for the empty
 * option and no second "default" is drawn beside it. When that row only names another (Claude's
 * "Default" is "Opus"), the named row is drawn in place of both and marked recommended, so one
 * model is never two rows; not picking still follows the agent, picking it pins it. Names are
 * split by `modelWords`, unless two rows would then read the same, label and version both (an "Opus
 * 5" beside an "Opus (1M context)" that is also 5), when both keep the agent's own words so the chip
 * can tell them apart. Rows that share only a label ("GPT 5.5" beside "GPT 5.2") keep the split,
 * and their chip carries the version, since the chip otherwise shows the label alone. */
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
  const split = listed.map((c) => ({ c, words: modelWords(c) }));
  const reads = (w: { label: string; version?: string }) => [w.label, w.version].filter(Boolean).join(" ");
  const rows: ChipOption<string>[] = [
    ...(own ? [] : [{ id: DEFAULT_OPTION, label: empty.label, description: empty.description }]),
    ...split.map(({ c, words }) => {
      const w = split.filter((o) => reads(o.words) === reads(words)).length === 1 ? words : undefined;
      const description = w ? w.description : c.description;
      return {
        id: c.id,
        label: w ? w.label : c.name,
        ...(w?.version ? { suffix: w.version } : {}),
        ...(w?.version && split.some((o) => o.c !== c && o.words.label === w.label) ? { chip: reads(w) } : {}),
        description: c === named ? ["recommended", description].filter(Boolean).join(" · ") : description,
      };
    }),
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

/** Every agent's models in one list, for a worktree that does not exist yet: picking a model picks
 * the agent that runs it. Each model's row starts with its agent's short name ("Claude Fable 5.1")
 * and the chip keeps only the model ("Fable"). An agent that is not installed is one dimmed row with
 * the reason, and one that has never listed its models (not logged in yet) is one row for its own
 * default, so every agent can still be chosen. With a single agent there is nothing to tell apart
 * and no row takes the agent's name. */
export function agentModelRows(
  agents: AgentInfo[],
  agent: string,
  model: string,
): { rows: ChipOption<string>[]; shown: string } {
  const several = agents.length > 1;
  let shown = agentModelKey(agent, model);
  const rows = agents.flatMap((a): ChipOption<string>[] => {
    const short = a.short ?? a.name;
    const mine = a.id === agent;
    if (!a.available || !a.models?.length) {
      if (mine) shown = agentModelKey(a.id, DEFAULT_OPTION);
      return [
        {
          id: agentModelKey(a.id, DEFAULT_OPTION),
          label: short,
          description: !a.available
            ? (a.reason ?? "not installed")
            : "its own default model; the rest are listed once it has run",
          disabled: !a.available,
        },
      ];
    }
    const r = choiceRows(a.models, mine ? model : DEFAULT_OPTION, undefined, {
      label: `${short} default`,
      description: `whatever ${a.name} runs when nothing is asked for`,
    });
    if (mine) shown = agentModelKey(a.id, r.shown);
    return r.rows.map((o) => ({
      ...o,
      id: agentModelKey(a.id, o.id),
      // the empty option already says whose default it is
      ...(several && o.id !== DEFAULT_OPTION ? { prefix: short } : {}),
    }));
  });
  return { rows, shown };
}
