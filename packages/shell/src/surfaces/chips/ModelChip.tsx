import type { AgentInfo, ModelChoice } from "@toyon/shared";
import { useMemo } from "react";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import { agentModelRows, splitAgentModel } from "./choiceRows.ts";
import { OptionChip } from "./OptionChip.tsx";

/** which of the agent's models answers here */
export function ModelChip({
  models,
  value,
  current,
  runs,
  onChange,
  onClose,
}: {
  models: ModelChoice[];
  value: string;
  current?: string;
  /** the agent's defaultModel: what its default row stands for */
  runs?: string;
  onChange: (id: string) => void;
  onClose?: () => void;
}) {
  return (
    <OptionChip
      choices={models}
      value={value}
      current={current}
      runs={runs}
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
 * models in one list, each row led by its agent, so there is no agent to pick before the model. A
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
  // the composer renders on every change to the chat, and the rows are the same until an agent's
  // list or the choice changes
  const { rows, shown } = useMemo(() => agentModelRows(agents, agent, model), [agents, agent, model]);
  if (rows.length === 0) return null;
  // the chip names only the model, so the tooltip carries the whole row: "Claude Fable 5.1"
  const row = rows.find((o) => o.id === shown);
  const full = row ? [row.prefix, row.label, row.suffix].filter(Boolean).join(" ") : model;
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
      hint={`${full} works on the new worktree; click to change`}
      placeholder="which agent and model work on it"
    />
  );
}
