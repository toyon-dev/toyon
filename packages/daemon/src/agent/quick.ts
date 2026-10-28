// Which model a side question (a name, a recap, a landing verdict) runs on. Most agents have one
// small model under a fixed id. An agent whose models depend on what the person logged into (OpenCode)
// picks from the list it offers instead.

import type { AgentSpec } from "./registry.ts";

/** the quick model among `offered`, or undefined when the agent has none to offer right now */
export function quickModelFor(
  spec: Pick<AgentSpec, "quickModel">,
  offered: readonly string[],
  current?: string,
): string | undefined {
  const quick = spec.quickModel;
  if (typeof quick === "function") return quick(offered, current);
  return quick && offered.includes(quick) ? quick : undefined;
}

/** `name` itself when offered, else the first offered id that carries it: the same small model
 * arrives as `haiku` from Anthropic, as bedrock/claude-haiku-5-5 from Bedrock and under a dated id
 * elsewhere, and none of those is a reason to name one in a file. */
export function quickModelNamed(name: string): (offered: readonly string[]) => string | undefined {
  return (offered) => (offered.includes(name) ? name : offered.find((id) => id.includes(name)));
}
