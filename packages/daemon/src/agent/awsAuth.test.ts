import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../core/errors.ts";
import { AWS_EXPIRED_RE, awsLoginCommand, awsMethods, readAwsAuth, setAwsAuthRefresh } from "./awsAuth.ts";

const root = mkdtempSync(join(tmpdir(), "toyon-aws-auth-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function home() {
  const dir = join(root, `h${n++}`);
  mkdirSync(join(dir, "claude"), { recursive: true });
  mkdirSync(join(dir, "wt", ".claude"), { recursive: true });
  return { config: join(dir, "claude"), wt: join(dir, "wt") };
}

describe("AWS_EXPIRED_RE", () => {
  test("reads the AWS SDK's and Claude Code's wording for a lapsed session", () => {
    for (const m of [
      "API Error: Could not load AWS credentials · Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
      "ExpiredTokenException: The security token included in the request is expired",
      "AWS authentication failed. If this is an SSO profile, run `aws sso login --profile NAME` first.",
      "awsAuthRefresh failed. Check the command in your settings and try running it in a separate terminal.",
    ])
      expect(AWS_EXPIRED_RE.test(m)).toBe(true);
  });

  test("leaves other failures of a Bedrock turn alone", () => {
    for (const m of [
      "403 Forbidden: your organization must enable this model",
      "unexpected status 401 Unauthorized: Incorrect API key provided",
      "on-demand throughput isn't supported for this model",
    ])
      expect(AWS_EXPIRED_RE.test(m)).toBe(false);
  });
});

describe("readAwsAuth", () => {
  test("the profile comes from the env block of the nearest settings file, then the env", () => {
    const { config, wt } = home();
    expect(readAwsAuth(config, wt, {})).toEqual({});
    expect(readAwsAuth(config, wt, { AWS_PROFILE: "shell" })).toEqual({ profile: "shell" });
    writeFileSync(join(config, "settings.json"), JSON.stringify({ env: { AWS_PROFILE: "user" } }));
    expect(readAwsAuth(config, wt, { AWS_PROFILE: "shell" })).toEqual({ profile: "user" });
    writeFileSync(join(wt, ".claude", "settings.json"), JSON.stringify({ env: { AWS_PROFILE: "project" } }));
    expect(readAwsAuth(config, wt, {})).toEqual({ profile: "project" });
    writeFileSync(join(wt, ".claude", "settings.local.json"), JSON.stringify({ env: { AWS_PROFILE: "local" } }));
    expect(readAwsAuth(config, wt, {})).toEqual({ profile: "local" });
  });

  test("a refresh command already set is reported, and a file that is not JSON is skipped", () => {
    const { config, wt } = home();
    writeFileSync(join(wt, ".claude", "settings.json"), "{ not json");
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({ awsAuthRefresh: "aws sso login --profile claude", env: { AWS_PROFILE: "claude" } }),
    );
    expect(readAwsAuth(config, wt, {})).toEqual({ profile: "claude", refresh: "aws sso login --profile claude" });
  });
});

describe("awsLoginCommand and awsMethods", () => {
  test("the command names the profile, quoted only when it has to be", () => {
    expect(awsLoginCommand()).toBe("aws sso login");
    expect(awsLoginCommand("claude")).toBe("aws sso login --profile claude");
    expect(awsLoginCommand("my team")).toBe("aws sso login --profile 'my team'");
  });

  test("the refresh leads for Claude without a refresh command already set", () => {
    expect(awsMethods({ profile: "claude" }, true).map((m) => [m.id, m.kind])).toEqual([
      ["aws-refresh", "agent"],
      ["aws-login", "terminal"],
    ]);
    expect(awsMethods({ profile: "claude", refresh: "aws sso login" }, true).map((m) => m.id)).toEqual(["aws-login"]);
    expect(awsMethods({}, false).map((m) => m.id)).toEqual(["aws-login"]);
    expect(awsMethods({ profile: "claude" }, true)[1]?.description).toContain("aws sso login --profile claude");
  });
});

describe("setAwsAuthRefresh", () => {
  test("writes the one key first and keeps the rest of the file", () => {
    const { config } = home();
    const file = join(config, "settings.json");
    writeFileSync(file, JSON.stringify({ env: { AWS_PROFILE: "claude", AWS_REGION: "us-east-1" }, model: "opus" }));
    expect(setAwsAuthRefresh(config, "aws sso login --profile claude")).toBe(file);
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text)).toEqual({
      awsAuthRefresh: "aws sso login --profile claude",
      env: { AWS_PROFILE: "claude", AWS_REGION: "us-east-1" },
      model: "opus",
    });
    expect(text.split("\n")[1]).toContain("awsAuthRefresh");
    // set again: the key moves nowhere and nothing doubles
    setAwsAuthRefresh(config, "aws sso login --profile other");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      awsAuthRefresh: "aws sso login --profile other",
      env: { AWS_PROFILE: "claude", AWS_REGION: "us-east-1" },
      model: "opus",
    });
  });

  test("makes the file when there is none, and refuses to overwrite one it cannot read", () => {
    const { config } = home();
    const dir = join(config, "fresh");
    setAwsAuthRefresh(dir, "aws sso login");
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ awsAuthRefresh: "aws sso login" });
    writeFileSync(join(config, "settings.json"), "{ not json");
    expect(() => setAwsAuthRefresh(config, "aws sso login")).toThrow(UserError);
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe("{ not json");
  });
});
