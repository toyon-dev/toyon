// OpenCode's side of toyon's rules. On its own OpenCode allows every edit and command, so toyon never
// saw them. Its setup injects a config through OPENCODE_CONFIG_CONTENT, which a repo's own
// opencode.json cannot loosen, that puts everything which writes to toyon's permission policy: the
// same place Claude's and Codex's asks go, where the worktree's auto, ask or plan decides.

import { DENIED_COMMANDS } from "./commands.ts";

type Rule = "allow" | "ask" | "deny";

/** OpenCode's form of the commands no agent runs: a glob per command, refused outright */
export function opencodeDenyRules(): Record<string, Rule> {
  return Object.fromEntries(DENIED_COMMANDS.map((c) => [`${c}*`, "deny" as const]));
}

export function opencodeConfig() {
  const bash: Record<string, Rule> = { "*": "ask", ...opencodeDenyRules() };
  return {
    autoupdate: false,
    share: "disabled",
    permission: {
      "*": "ask",
      // reads never write, the same as NON_WRITE_KINDS in policy.ts, so they are not asked
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      // its subagents' permission prompts hang over ACP, so a subagent cannot be answered
      task: "deny",
      external_directory: "ask",
      bash,
    },
    // OpenCode's own plan agent denies edits but runs shell commands unasked
    agent: { plan: { permission: { bash } } },
  };
}

/** names that mark a provider's small model */
const SMALL_MODEL = /haiku|mini|flash|nano|small|lite|luna/i;
/** providers that run the model on the person's own machine, where a large model costs nothing */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llama.cpp"]);

/** OpenCode's models are whatever the person logged into, so there is no one id to name. The small
 * model from the current model's provider; failing that the current model itself, but only a local
 * one. A recap or a commit message is not worth a large paid model's price, and costs nothing locally. */
export function opencodeQuickModel(offered: readonly string[], current?: string): string | undefined {
  const provider = current?.split("/")[0];
  if (!provider) return undefined;
  const small = offered.find((id) => id.startsWith(`${provider}/`) && SMALL_MODEL.test(id.slice(provider.length + 1)));
  if (small) return small;
  return LOCAL_PROVIDERS.has(provider) && offered.includes(current!) ? current : undefined;
}

/** what OpenCode's setup adds to its environment, before every launch */
export function opencodeEnv(): Record<string, string> {
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig()),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_CLIENT: "toyon",
  };
}
