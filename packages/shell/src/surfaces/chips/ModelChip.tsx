import type { AgentInfo, ModelChoice } from "@toyon/shared";
import { STORAGE } from "../../state/keys.ts";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import { usePersisted } from "../../ui/hooks.ts";
import { agentModelRows, DEFAULT_OPTION, splitAgentModel } from "./choiceRows.ts";
import { OptionChip } from "./OptionChip.tsx";

/** the model a new worktree of this agent asks for: remembered per agent in this browser */
export function useNewWorktreeModel(agentId: string | undefined): [string, (m: string) => void] {
  const [stored, setStored] = usePersisted<string>(
    STORAGE.modelPrefix + (agentId ?? ""),
    DEFAULT_OPTION,
    (raw) => raw ?? "",
  );
  return [stored, setStored];
}

/** the same memory for an agent the hook above is not reading: picking another agent's model
 * stores it here just before the agent switches, and the hook reads it on the switch */
export function rememberNewWorktreeModel(agentId: string, model: string) {
  try {
    localStorage.setItem(STORAGE.modelPrefix + agentId, model);
  } catch {
    // storage blocked (a private window): the agent still switches, only the model is not kept
  }
}

/** which of the agent's models answers here */
export function ModelChip({
  models,
  value,
  current,
  onChange,
  onClose,
}: {
  models: ModelChoice[];
  value: string;
  current?: string;
  onChange: (id: string) => void;
  onClose?: () => void;
}) {
  return (
    <OptionChip
      choices={models}
      value={value}
      current={current}
      what="a model"
      defaultLabel="default model"
      defaultDescription="whatever the agent runs when nothing is asked for"
      placeholder="which model answers here"
      className="model-chip"
      onChange={onChange}
      onClose={onClose}
    />
  );
}

/** Which agent, and which of its models, a worktree that does not exist yet runs: every agent's
 * models in one list under each agent's name, so there is no agent to pick before the model. A
 * worktree's agent is fixed at birth, so once it exists (or for a draft stacked on one) the chip is
 * `ModelChip`, listing that agent's models only. */
export function AgentModelChip({
  agents,
  agent,
  model,
  onChange,
  onClose,
}: {
  agents: AgentInfo[];
  agent: string;
  model: string;
  onChange: (agent: string, model: string) => void;
  onClose?: () => void;
}) {
  const { rows, shown } = agentModelRows(agents, agent, model);
  if (rows.length === 0) return null;
  const label = rows.find((o) => o.id === shown)?.label ?? model;
  const name = agents.find((a) => a.id === agent)?.name ?? agent;
  return (
    <ChipPicker
      value={shown}
      options={rows}
      onChange={(key) => {
        const picked = splitAgentModel(key);
        onChange(picked.agent, picked.model);
      }}
      onClose={onClose}
      className="model-chip"
      hint={`${label === name ? name : `${name} on ${label}`} works on the new worktree; click to change`}
      placeholder="which agent and model work on it"
    />
  );
}
