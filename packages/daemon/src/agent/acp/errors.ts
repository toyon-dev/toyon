// What a failed ACP request says, for a chat row, a picker row or a pattern that reads the
// provider's wording.

import * as acp from "@agentclientprotocol/sdk/unstable";

/** The words of a failed request. A handler that threw is answered by the SDK with its code's name
 * alone ("Internal error") and what was thrown under `data.details`; an adapter that builds the
 * error itself puts the same name in front of the provider's words. The name is JSON-RPC's and
 * tells a person nothing, so it is the words behind it either way. */
export function errorWords(e: unknown): string {
  const details = e instanceof acp.RequestError ? (e.data as { details?: unknown } | null)?.details : undefined;
  const message = typeof details === "string" && details ? details : e instanceof Error ? e.message : String(e);
  return message.replace(/^Internal error: /, "");
}
