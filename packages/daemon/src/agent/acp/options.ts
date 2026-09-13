// The select config options toyon drives on an ACP session: the model, and the effort level
// (ACP's `thought_level`). Keyed by category rather than option id, because the id is the
// adapter's (Claude says `effort`, Codex says `reasoning_effort`) and the category is the
// protocol's. Pure functions, so the session and the update mapper read a list the same way.

import type * as acp from "@agentclientprotocol/sdk";
import type { ModelChoice, WorktreeInfo } from "@toyon/shared";

/** the categories toyon drives, and the worktree field each one is asked from */
export const OPTION_FIELDS = { model: "model", thought_level: "effort" } as const;
export type OptionCategory = keyof typeof OPTION_FIELDS;
export type OptionField = (typeof OPTION_FIELDS)[OptionCategory];
export const OPTION_CATEGORIES = Object.keys(OPTION_FIELDS) as OptionCategory[];

/** a select option the agent advertised, as the session tracks it: the id to set it by, the ids
 * it accepts, the value as last told to us, and the choices for a picker */
export interface LiveOption {
  id: string;
  ids: string[];
  current: string;
  choices: ModelChoice[];
}

export type LiveOptions = Map<OptionCategory, LiveOption>;

/** a select's options come flat or in named groups; the picker wants them flat */
export function flattenSelect(options: acp.SessionConfigSelectOptions): acp.SessionConfigSelectOption[] {
  const out: acp.SessionConfigSelectOption[] = [];
  for (const o of options) {
    if ("options" in o) out.push(...o.options);
    else out.push(o);
  }
  return out;
}

/** every category present in the list; one that is absent (effort on a model without it) is
 * simply missing from the map */
export function readOptions(configOptions: acp.SessionConfigOption[] | null | undefined): LiveOptions {
  const out: LiveOptions = new Map();
  for (const category of OPTION_CATEGORIES) {
    const opt = configOptions?.find((o) => o.category === category && o.type === "select");
    if (opt?.type !== "select") continue;
    const flat = flattenSelect(opt.options);
    out.set(category, {
      id: opt.id,
      ids: flat.map((o) => String(o.value)),
      current: String(opt.currentValue),
      choices: flat.map((o) => ({
        id: String(o.value),
        name: o.name,
        ...(o.description ? { description: o.description } : {}),
      })),
    });
  }
  return out;
}

/** The agent's session modes, when it advertises them as a config option (OpenCode's `mode`, build
 * and plan) rather than as ACP's `modes`. Kept apart from OPTION_FIELDS on purpose: a worktree's
 * `mode` field is toyon's permission mode, which the agent's mode is mapped from, never stored as. */
export function readModeOption(configOptions: acp.SessionConfigOption[] | null | undefined): LiveOption | null {
  const opt = configOptions?.find((o) => o.category === "mode" && o.type === "select");
  if (opt?.type !== "select") return null;
  const flat = flattenSelect(opt.options);
  return {
    id: opt.id,
    ids: flat.map((o) => String(o.value)),
    current: String(opt.currentValue),
    choices: flat.map((o) => ({ id: String(o.value), name: o.name })),
  };
}

/** what is currently selected, in the session-info event's fields */
export function currentValues(options: LiveOptions): Partial<Pick<WorktreeInfo, OptionField>> {
  const out: Partial<Pick<WorktreeInfo, OptionField>> = {};
  for (const [category, opt] of options) out[OPTION_FIELDS[category]] = opt.current;
  return out;
}
