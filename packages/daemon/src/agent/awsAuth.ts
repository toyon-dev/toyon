// Claude on Amazon Bedrock runs on AWS credentials, and an SSO session is good for a working day.
// When it lapses, the turn fails with the AWS SDK's own words and ACP has no code for it: the
// adapter advertises Claude's own logins (browser, API key), which are the wrong fix. The way
// back is `aws sso login` for the profile Claude reads, and the way to stop it happening again is
// Claude Code's `awsAuthRefresh` setting, which runs that command itself when the credentials
// expire and retries the request.
//
// What Claude reads is found the way Claude finds it: `AWS_PROFILE` from the `env` block of its
// settings files (the worktree's local, then project, then user settings), and the process env
// last. The user settings file is the one place toyon writes, and only the one key, on a press.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuthMethodInfo } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";

/** the AWS SDK's wording when the credential chain has nothing live to give: an SSO token past
 * its time, a session token the request was refused on, or Claude Code's own refresh command
 * reporting it could not get one. Kept to phrasings that are about AWS credentials, since any
 * other failure of a Bedrock turn (a model not enabled, a region) is no login problem. */
export const AWS_EXPIRED_RE =
  /could not load aws credentials|aws sso login|aws authentication failed|expiredtoken|security token included in the request is (expired|invalid)|sso (session|token)[^.]*expired|token is expired|awsauthrefresh/i;

export const AWS_LOGIN_METHOD = "aws-login";
export const AWS_REFRESH_METHOD = "aws-refresh";

export interface AwsAuth {
  /** the profile Claude's credential chain resolves, when a settings file or the env names one */
  profile?: string;
  /** Claude Code's `awsAuthRefresh` command, when the settings already carry one */
  refresh?: string;
}

/** what Claude would read: the `env` blocks of its settings files, nearest first, then the env */
export function readAwsAuth(configDir: string, cwd: string, env: NodeJS.ProcessEnv = process.env): AwsAuth {
  const files = [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(configDir, "settings.json"),
  ];
  let profile: string | undefined;
  let refresh: string | undefined;
  for (const file of files) {
    const s = readSettings(file);
    if (!s) continue;
    const e = s.env as Record<string, unknown> | undefined;
    profile ??= str(e?.AWS_PROFILE);
    refresh ??= str(s.awsAuthRefresh);
  }
  profile ??= str(env.AWS_PROFILE);
  return { ...(profile ? { profile } : {}), ...(refresh ? { refresh } : {}) };
}

/** the command a person would type, and the one the setting carries */
export function awsLoginCommand(profile?: string): string {
  return profile ? `aws sso login --profile ${shellWord(profile)}` : "aws sso login";
}

/** the card's buttons, the first being the one the card leads with. For Claude (`settable`,
 * since the setting is Claude Code's) that is the setting that makes every next login its own
 * job, with the login now behind it; once the settings carry a refresh command it is the command
 * that failed, and the login now is all there is. */
export function awsMethods(auth: AwsAuth, settable: boolean): AuthMethodInfo[] {
  const login: AuthMethodInfo = {
    id: AWS_LOGIN_METHOD,
    name: "log in to AWS",
    description: `runs ${awsLoginCommand(auth.profile)} in the terminal pane`,
    kind: "terminal",
  };
  if (auth.refresh || !settable) return [login];
  return [
    {
      id: AWS_REFRESH_METHOD,
      name: "refresh automatically",
      description:
        "sets awsAuthRefresh in your Claude settings, so Claude runs the login itself when the session expires",
      kind: "agent",
    },
    login,
  ];
}

/** write `awsAuthRefresh` into the user settings file, keeping everything else in it as it was.
 * A file that is not JSON is left alone and named, since overwriting it would lose what Claude
 * Code could not read either. */
export function setAwsAuthRefresh(configDir: string, command: string): string {
  const file = join(configDir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const v: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      settings = v as Record<string, unknown>;
    } catch (e) {
      throw new UserError(
        `${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}); fix it, then try again`,
      );
    }
  }
  // first, where a person reading the file looks for it; the env block it works with follows
  const rest = Object.fromEntries(Object.entries(settings).filter(([k]) => k !== "awsAuthRefresh"));
  const next = { awsAuthRefresh: command, ...rest };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

function readSettings(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch (e) {
    // the agent's own file, read for one key: a line, and the next file answers instead
    log.warn("aws-auth", `${file} is not valid JSON`, e);
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** a profile name as a shell word: the plain ones go bare, anything else single-quoted */
function shellWord(s: string): string {
  return /^[\w.@-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
