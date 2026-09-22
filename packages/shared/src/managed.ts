// A managed policy: what whoever runs the machine has turned off, from a file the person at the
// keyboard cannot edit. IT pushes it over MDM the way Chrome's and Claude Code's are pushed; the
// CLI reads it on every run, the daemon once at boot, and the shell learns it from hello.
//
// Pure: the loader (managed-load.ts) reads the files and hands their texts here, so the shell can
// import the type and the descriptions without pulling node in. Every key is locked, absent means
// allowed, and where two sources set one key the stricter value wins. A file that does not parse,
// or a key of the wrong type, fails closed: everything the policy governs goes to its strictest.
// Unknown keys are ignored, so a file written for a newer Toyon still reads here.

import { z } from "zod";

/** `remote`: the ladder, strictest first */
export const MANAGED_REMOTE = ["off", "tailscale", "any"] as const;
export type ManagedRemote = (typeof MANAGED_REMOTE)[number];

/** every key resolved: what the CLI, the daemon and the shell act on */
export interface ManagedPolicy {
  /** false: never check, never install; `toyon update` refuses */
  updates: boolean;
  /** false: `toyon deploy` refuses */
  deploy: boolean;
  /** off: `toyon remote` refuses and the daemon ignores remote.json; tailscale: a `.ts.net` name only */
  remote: ManagedRemote;
  /** the agent ids that may run; null when any may. An id not in the registry is ignored. */
  agents: string[] | null;
  /** false: `~/.toyon/agents.json` is ignored */
  customAgents: boolean;
  /** false: the portless `toyon.localhost` listener on port 80 is not bound */
  brandedListener: boolean;
  /** false: a sign-in with a consumer Claude plan is not offered, and refused if asked for */
  planSignIn: boolean;
}

export const MANAGED_DEFAULTS: ManagedPolicy = {
  updates: true,
  deploy: true,
  remote: "any",
  agents: null,
  customAgents: true,
  brandedListener: true,
  planSignIn: true,
};

/** what a file that cannot be read safely means. `agents` stays open: an empty allowlist would
 * leave nothing to run, and the builtin list with custom agents off is the closed shape. */
export const MANAGED_STRICTEST: ManagedPolicy = {
  updates: false,
  deploy: false,
  remote: "off",
  agents: null,
  customAgents: false,
  brandedListener: false,
  planSignIn: false,
};

const managedFileSchema = z.object({
  updates: z.boolean().optional(),
  deploy: z.boolean().optional(),
  remote: z.enum(MANAGED_REMOTE).optional(),
  agents: z.array(z.string()).optional(),
  customAgents: z.boolean().optional(),
  brandedListener: z.boolean().optional(),
  planSignIn: z.boolean().optional(),
});

/** what the shell is told: the policy, where it came from, and what went wrong when it did */
export interface ManagedView extends ManagedPolicy {
  /** the applied path, or the first invalid one; null when no source exists */
  source: string | null;
  /** why a source failed closed; null when every source read */
  problem: string | null;
}

export const MANAGED_NONE: ManagedView = { ...MANAGED_DEFAULTS, source: null, problem: null };

export type ManagedSourceKind = "json" | "plist";

/** a place a policy may be, on this platform */
export interface ManagedSourceSpec {
  path: string;
  kind: ManagedSourceKind;
}

/** Where the policy lives, read in this order. macOS reads the managed-preferences plists MDM
 * writes from a configuration profile, at computer scope and at the user's, and a JSON file for a
 * shop that pushes files with a script. Linux reads one JSON file. */
export function managedSources(platform: string, user?: string): ManagedSourceSpec[] {
  if (platform === "darwin") {
    return [
      { path: "/Library/Managed Preferences/dev.toyon.plist", kind: "plist" },
      ...(user ? [{ path: `/Library/Managed Preferences/${user}/dev.toyon.plist`, kind: "plist" as const }] : []),
      { path: "/Library/Application Support/toyon/policy.json", kind: "json" },
    ];
  }
  if (platform === "linux") return [{ path: "/etc/toyon/policy.json", kind: "json" }];
  return [];
}

/** one source as the loader found it: absent (no text, no problem), unreadable (a problem), or
 * its text. `owned` is the loader's word on a JSON file's ownership; false fails it closed. */
export interface ManagedSourceRead extends ManagedSourceSpec {
  text?: string;
  problem?: string;
  owned?: boolean;
}

export interface ManagedSourceState extends ManagedSourceSpec {
  state: "applied" | "absent" | "invalid";
  problem?: string;
}

export interface ManagedResolved {
  policy: ManagedPolicy;
  sources: ManagedSourceState[];
  /** over the texts that applied, so a re-pushed file at the same path reads as a change; null
   * when nothing applied */
  hash: string | null;
  source: string | null;
  problem: string | null;
}

/** an applied policy's keys, ordered by how they are printed */
const KEYS = ["updates", "deploy", "remote", "agents", "customAgents", "brandedListener", "planSignIn"] as const;

/** the stricter of two values of one key */
function stricter<K extends keyof ManagedPolicy>(key: K, a: ManagedPolicy[K], b: ManagedPolicy[K]): ManagedPolicy[K] {
  if (key === "remote") {
    const ra = MANAGED_REMOTE.indexOf(a as ManagedRemote);
    const rb = MANAGED_REMOTE.indexOf(b as ManagedRemote);
    return (ra <= rb ? a : b) as ManagedPolicy[K];
  }
  if (key === "agents") {
    const la = a as string[] | null;
    const lb = b as string[] | null;
    if (la === null) return b;
    if (lb === null) return a;
    return la.filter((id) => lb.includes(id)) as ManagedPolicy[K];
  }
  return ((a as boolean) && (b as boolean)) as ManagedPolicy[K];
}

function merge(into: ManagedPolicy, from: Partial<ManagedPolicy>): ManagedPolicy {
  const out = { ...into };
  for (const key of KEYS) {
    const v = from[key];
    if (v === undefined) continue;
    (out as Record<string, unknown>)[key] = stricter(key, into[key], v as never);
  }
  return out;
}

/** FNV-1a over the text, in hex: a change detector, not a credential. Pure so the shell's bundle
 * can hold this file without node's crypto. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** the first line of a zod failure, in the file's own terms */
function describeIssue(e: z.ZodError): string {
  const issue = e.issues[0];
  if (!issue) return "not a policy";
  const at = issue.path.map(String).join(".");
  return at ? `"${at}" ${issue.message.toLowerCase()}` : issue.message.toLowerCase();
}

/** What the sources add up to. Every applied source tightens the policy; one invalid source fails
 * the whole thing closed, since a file that will not read is a file someone may have tampered
 * with, and the person at the keyboard is not the one to decide what it meant. */
export function resolveManaged(reads: ManagedSourceRead[]): ManagedResolved {
  let policy = MANAGED_DEFAULTS;
  const sources: ManagedSourceState[] = [];
  const applied: string[] = [];
  let source: string | null = null;
  let problem: string | null = null;
  for (const r of reads) {
    const spec = { path: r.path, kind: r.kind };
    let why = r.problem ?? (r.owned === false ? "not owned by root, or writable by others" : null);
    if (why === null && r.text === undefined) {
      sources.push({ ...spec, state: "absent" });
      continue;
    }
    let parsed: Partial<ManagedPolicy> | null = null;
    if (why === null) {
      try {
        const json: unknown = JSON.parse(r.text ?? "");
        const result = managedFileSchema.safeParse(json);
        if (result.success) parsed = result.data;
        else why = describeIssue(result.error);
      } catch {
        why = r.kind === "plist" ? "not a plist plutil can read" : "not valid JSON";
      }
    }
    if (why !== null || parsed === null) {
      sources.push({ ...spec, state: "invalid", problem: why ?? "unreadable" });
      if (problem === null) {
        problem = `${r.path}: ${why ?? "unreadable"}`;
        source = r.path;
      }
      continue;
    }
    sources.push({ ...spec, state: "applied" });
    applied.push(r.text ?? "");
    if (problem === null && source === null) source = r.path;
    policy = merge(policy, parsed);
  }
  if (problem !== null) policy = MANAGED_STRICTEST;
  return {
    policy,
    sources,
    hash: applied.length ? textHash(applied.join("\n")) : null,
    source,
    problem,
  };
}

export function managedView(r: ManagedResolved): ManagedView {
  return { ...r.policy, source: r.source, problem: r.problem };
}

/** what the policy turns off, one phrase each, for doctor's line and the settings card's hint;
 * empty when it turns off nothing */
export function describeManaged(p: ManagedPolicy): string[] {
  const out: string[] = [];
  if (!p.updates) out.push("updates off");
  if (!p.deploy) out.push("deploy off");
  if (p.remote !== "any") out.push(`remote ${p.remote}`);
  if (p.agents !== null) out.push(`agents ${p.agents.join(", ") || "none"}`);
  if (!p.customAgents) out.push("custom agents off");
  if (!p.brandedListener) out.push("toyon.localhost listener off");
  if (!p.planSignIn) out.push("plan sign-in off");
  return out;
}
