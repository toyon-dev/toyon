// ACP's `authStatus` extension: how an agent tells us which credential it is actually using.
//
// Push only, connection-scoped. The agent advertises `agentCapabilities._meta.authStatus` (an empty
// marker object) and then sends `_auth/status_update` whenever the identity it sees changes — at
// initialize, after an authenticate or logout, and at the start of each prompt. There is no request
// method; a client that never hears one knows nothing, which is not the same as logged out ("none"
// is a payload of its own). Both builtin adapters implement it; a custom agent simply pushes nothing.
//
// Interim extension: when the upstream RFD lands these move from `_meta` to first-class fields.

import type * as acp from "@agentclientprotocol/sdk";
import type { AuthStatus } from "@toyon/shared";

export const AUTH_STATUS_UPDATE_METHOD = "_auth/status_update";

const KINDS = new Set<AuthStatus["kind"]>(["none", "api_key", "account", "external", "gateway"]);

/** did it advertise ACP's logout method? */
export function supportsLogout(caps: acp.InitializeResponse["agentCapabilities"]): boolean {
  return !!caps?.auth?.logout;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** `_auth/status_update` params → a status, or null when the agent sent something we cannot read.
 * Doubles as the notification's params parser, so a malformed push is dropped, not thrown. */
export function parseAuthStatus(params: unknown): AuthStatus | null {
  const status = (params as { authStatus?: unknown })?.authStatus as Record<string, unknown> | undefined;
  if (!status || typeof status !== "object") return null;
  const kind = status.kind as AuthStatus["kind"];
  if (!KINDS.has(kind)) return null;
  const account = (status.account ?? undefined) as Record<string, unknown> | undefined;
  const fields = account
    ? {
        ...(str(account.email) ? { email: str(account.email)! } : {}),
        ...(str(account.organization) ? { organization: str(account.organization)! } : {}),
        ...(str(account.plan) ? { plan: str(account.plan)! } : {}),
      }
    : {};
  return {
    kind,
    // the label is the agent's own wording; only its absence is ours to fill in
    label: str(status.label) ?? (kind === "none" ? "not logged in" : "logged in"),
    ...(str(status.detail) ? { detail: str(status.detail)! } : {}),
    ...(Object.keys(fields).length ? { account: fields } : {}),
  };
}
