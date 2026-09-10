// ACP's steering extension: how a client puts a message into the turn that is already running.
//
// The agent advertises `_meta.steering.supported` on initialize and then answers `_session/steering`
// requests. Unlike `session/prompt` the message joins the turn in flight rather than queueing behind
// it: the Claude adapter pushes it onto the same streaming input, pre-empting the current generation
// or slotting between tool calls, and holds the running prompt open so that one turn still settles
// once, at the real end.
//
// `idleBehavior: "promptRequired"` is the outcome we ask for when the turn settled underneath us: it
// leaves the message ours to send as an ordinary prompt, so one place still owns the turn lifecycle.
//
// Interim extension, hence the `_` prefix. Both builtin adapters implement it; an agent that
// advertises nothing keeps the visible queue instead.

import type * as acp from "@agentclientprotocol/sdk";

export const STEER_METHOD = "_session/steering";

/** what the agent did with a steered message */
export type SteerOutcome = "injected" | "promptRequired" | "startedNewTurn";

/** did it advertise the steering extension? */
export function supportsSteering(init: acp.InitializeResponse): boolean {
  const steering = (init._meta as Record<string, unknown> | undefined | null)?.steering;
  return typeof steering === "object" && steering !== null && (steering as { supported?: unknown }).supported === true;
}

/** the reply's outcome. Anything we do not recognise reads as `startedNewTurn`, the one answer that
 * means the message is the agent's problem now and must not be sent a second time. */
export function steerOutcome(value: unknown): SteerOutcome {
  const outcome = (value as { outcome?: unknown } | null | undefined)?.outcome;
  return outcome === "injected" || outcome === "promptRequired" ? outcome : "startedNewTurn";
}
