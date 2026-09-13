// `toyon deploy fly`: toyon on the person's own Fly account, with their own keys. The machine is the
// image this CLI ships (context.ts), built in their Fly builder; the app, its volume, its secrets and
// its addresses are theirs, and toyon hosts nothing. Every step checks before it acts, so `up` again
// deploys the current CLI onto the same app and volume.

import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW_PORTS, portPreviews } from "@toyon/shared";
import type { Command } from "../args.ts";
import { home } from "../daemon.ts";
import { launcherAddLink } from "../launcher.ts";
import { bunVersion, machineSources, writeMachineContext } from "./context.ts";

type DeployCommand = Extract<Command, { kind: "deploy" }>;

const DAEMON_PORT = 4141;
const VOLUME = "toyon_data";
const VOLUME_GB = 5;

/** keys and tokens this machine keeps for its deploys, each file mode 600 */
const cloudDir = join(home, "cloud");
const tokenFile = (app: string) => join(cloudDir, `${app}.token`);

/** something the person reads and can act on, printed without a stack */
class DeployError extends Error {}

export function flyToml(app: string, region: string): string {
  const host = `${app}.fly.dev`;
  const lines = [
    "# written by toyon deploy fly for one deploy",
    `app = "${app}"`,
    `primary_region = "${region}"`,
    "",
    "[env]",
    `  TOYON_PUBLIC_HOST = "${host}"`,
    `  TOYON_PREVIEWS = "${portPreviews(host)}"`,
    "",
    "[mounts]",
    `  source = "${VOLUME}"`,
    '  destination = "/data"',
    "",
    "[[vm]]",
    '  size = "shared-cpu-2x"',
    '  memory = "2048mb"',
    "",
    "# the shell and the daemon's websocket",
    "[[services]]",
    `  internal_port = ${DAEMON_PORT}`,
    '  protocol = "tcp"',
    '  auto_stop_machines = "stop"',
    "  auto_start_machines = true",
    "  min_machines_running = 0",
    "  [[services.ports]]",
    "    port = 80",
    '    handlers = ["http"]',
    "    force_https = true",
    "  [[services.ports]]",
    "    port = 443",
    '    handlers = ["tls", "http"]',
    "  [[services.http_checks]]",
    '    interval = "15s"',
    '    timeout = "5s"',
    '    grace_period = "60s"',
    '    method = "get"',
    '    path = "/health"',
  ];
  // fly.dev holds no wildcard certificate, so each preview is the public name at its own TLS port
  for (let p = PREVIEW_PORTS.from; p <= PREVIEW_PORTS.to; p++) {
    lines.push(
      "",
      "[[services]]",
      `  internal_port = ${p}`,
      '  protocol = "tcp"',
      '  auto_stop_machines = "stop"',
      "  auto_start_machines = true",
      "  min_machines_running = 0",
      "  [[services.ports]]",
      `    port = ${p}`,
      '    handlers = ["tls", "http"]',
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Fly's edge ends each request id with the region that served it, and the region that answers the
 * person is the one nearest them */
export function regionFromRequestId(id: string | null): string | null {
  return id?.match(/-([a-z]{3})$/)?.[1] ?? null;
}

/** `fly secrets import` reads NAME=VALUE lines on stdin, which keeps every value out of argv */
export function secretsInput(secrets: Record<string, string | null>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (value === null) continue;
    if (/[\r\n]/.test(value)) throw new DeployError(`${name} holds a line break; a key is one line`);
    lines.push(`${name}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

async function nearestRegion(): Promise<string | null> {
  try {
    const res = await fetch("https://api.fly.io/", { method: "HEAD", signal: AbortSignal.timeout(5000) });
    return regionFromRequestId(res.headers.get("fly-request-id"));
  } catch {
    return null; // offline or blocked: the caller asks for --region instead
  }
}

/** a key from its environment variable, else from its file in ~/.toyon/cloud */
function secret(env: string, file: string): string | null {
  const fromEnv = process.env[env]?.trim();
  if (fromEnv) return fromEnv;
  const path = join(cloudDir, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim() || null : null;
}

async function capture(bin: string, args: string[], input?: string) {
  const p = Bun.spawn([bin, ...args], {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, out, err };
}

/** a long step whose own output the person should watch */
async function show(bin: string, args: string[]): Promise<boolean> {
  const p = Bun.spawn([bin, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return (await p.exited) === 0;
}

function must(r: { ok: boolean; err: string }, what: string): void {
  if (!r.ok) throw new DeployError(`${what}: ${r.err.trim().split("\n").at(-1) ?? "flyctl failed"}`);
}

function namesApp(json: string, app: string): boolean {
  try {
    const apps = JSON.parse(json) as { Name?: string; name?: string }[];
    return apps.some((a) => (a.Name ?? a.name) === app);
  } catch {
    return false; // not a list: treated as absent, and `apps create` then says what is wrong
  }
}

/** Once public DNS has the name. Public resolvers are asked directly because asking the OS before
 * the record exists caches the miss for fly.dev's negative TTL (300s), and the printed link then
 * fails to open for minutes after the machine is up. A resolver this network cannot reach says
 * nothing either way, so that goes ahead. */
async function published(host: string): Promise<boolean> {
  const r = new Resolver({ timeout: 3000, tries: 1 });
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await r.resolve4(host)).length) return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "ENOTFOUND" && code !== "ENODATA") return true;
    }
    await Bun.sleep(2000);
  }
  return false;
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false; // not up yet
  }
}

async function up(cmd: DeployCommand, bin: string): Promise<void> {
  const src = machineSources();
  if (!src)
    throw new DeployError(
      "there is no packed build to deploy here; in a source checkout run `bun scripts/pack.ts` first",
    );
  if (!(await capture(bin, ["auth", "whoami"])).ok)
    throw new DeployError("flyctl is not logged in; run `fly auth login`");
  const anthropic = secret("ANTHROPIC_API_KEY", "anthropic.key");
  if (!anthropic) {
    throw new DeployError(
      `no Anthropic key: set ANTHROPIC_API_KEY, or put it in ${join(cloudDir, "anthropic.key")} (mode 600)`,
    );
  }
  const region = cmd.region ?? (await nearestRegion());
  if (!region)
    throw new DeployError(
      "could not tell which Fly region is closest; pass --region (`fly platform regions` lists them)",
    );
  console.log(cmd.region ? `region ${region}` : `region ${region}, the closest to you; --region picks another`);

  mkdirSync(cloudDir, { recursive: true, mode: 0o700 });
  if (!existsSync(tokenFile(cmd.name)))
    writeFileSync(tokenFile(cmd.name), randomBytes(32).toString("hex"), { mode: 0o600 });
  const token = readFileSync(tokenFile(cmd.name), "utf8").trim();
  const app = ["-a", cmd.name];

  if (!namesApp((await capture(bin, ["apps", "list", "--json"])).out, cmd.name)) {
    console.log(`creating the app ${cmd.name}`);
    must(await capture(bin, ["apps", "create", cmd.name]), "could not create the app");
  }
  if (!(await capture(bin, ["volumes", "list", ...app, "--json"])).out.includes(`"${VOLUME}"`)) {
    console.log(`creating a ${VOLUME_GB} GB volume in ${region}`);
    must(
      await capture(bin, [
        "volumes",
        "create",
        VOLUME,
        ...app,
        "--region",
        region,
        "--size",
        String(VOLUME_GB),
        "--yes",
      ]),
      "could not create the volume",
    );
  }
  console.log("setting secrets");
  const secrets = secretsInput({
    TOYON_TOKEN: token,
    ANTHROPIC_API_KEY: anthropic,
    OPENAI_API_KEY: secret("OPENAI_API_KEY", "openai.key"),
    GITHUB_TOKEN: secret("GITHUB_TOKEN", "github.token"),
    TOYON_REPO_URL: cmd.repo,
  });
  must(await capture(bin, ["secrets", "import", ...app, "--stage"], secrets), "could not set the secrets");

  // addresses before the first deploy, so the name exists before flyctl or this command looks it up
  const ips = (await capture(bin, ["ips", "list", ...app, "--json"])).out;
  if (!/"Type":\s*"(shared_)?v4"/.test(ips))
    must(await capture(bin, ["ips", "allocate-v4", "--shared", ...app]), "could not add an IPv4 address");
  if (!/"Type":\s*"v6"/.test(ips))
    must(await capture(bin, ["ips", "allocate-v6", ...app]), "could not add an IPv6 address");

  const ctx = mkdtempSync(join(tmpdir(), "toyon-machine-"));
  try {
    writeMachineContext(src, ctx);
    writeFileSync(join(ctx, "fly.toml"), flyToml(cmd.name, region));
    console.log("building the machine in your Fly builder and deploying it");
    const deployArgs = ["deploy", ctx, "--config", join(ctx, "fly.toml"), "--remote-only", "--ha=false", "--yes"];
    if (!(await show(bin, [...deployArgs, "--build-arg", `BUN_VERSION=${bunVersion}`]))) {
      throw new DeployError("the deploy failed; flyctl's output above says why");
    }
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }

  console.log("waiting for the machine to answer");
  let up = false;
  if (!(await published(`${cmd.name}.fly.dev`))) console.log(`${cmd.name}.fly.dev is not in public DNS yet`);
  for (let i = 0; i < 60 && !up; i++) {
    up = await answers(`https://${cmd.name}.fly.dev/health`);
    if (!up) await Bun.sleep(2000);
  }
  if (!up) console.log(`it has not answered yet; \`fly logs -a ${cmd.name}\` shows what it is doing`);
  printLinks(cmd.name, token);
  console.log("the volume holds the only copy of anything not pushed to a remote");
}

function printLinks(app: string, token: string): void {
  console.log(`\ntoyon: https://${app}.fly.dev/#token=${token}`);
  console.log("the link grants a shell on that machine; keep it to yourself");
  console.log(`add it to your list at toyon.cloud: ${launcherAddLink(`https://${app}.fly.dev`)}`);
}

async function destroy(cmd: DeployCommand, bin: string): Promise<number> {
  if (!cmd.yes) {
    if (!process.stdin.isTTY) throw new DeployError("destroy deletes the app and its volume; pass --yes to confirm it");
    process.stdout.write(
      `this deletes ${cmd.name} and its volume, the only copy of anything not pushed. Type its name to confirm: `,
    );
    let typed = "";
    for await (const line of console) {
      typed = line;
      break;
    }
    if (typed.trim() !== cmd.name) {
      console.log("nothing deleted");
      return 0;
    }
  }
  must(await capture(bin, ["apps", "destroy", cmd.name, "--yes"]), "could not delete the app");
  rmSync(tokenFile(cmd.name), { force: true });
  console.log(`deleted ${cmd.name}`);
  return 0;
}

export async function deploy(cmd: DeployCommand): Promise<number> {
  const bin = Bun.which("fly") ?? Bun.which("flyctl");
  if (!bin) {
    console.error("toyon: flyctl is not installed; https://fly.io/docs/flyctl/install/ has it");
    return 1;
  }
  try {
    if (cmd.action === "up") await up(cmd, bin);
    else if (cmd.action === "destroy") return await destroy(cmd, bin);
    else if (existsSync(tokenFile(cmd.name))) {
      printLinks(cmd.name, readFileSync(tokenFile(cmd.name), "utf8").trim());
    } else {
      throw new DeployError(`${cmd.name} was not deployed from this machine; its token is not in ${cloudDir}`);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof DeployError)) throw e;
    console.error(`toyon: ${e.message}`);
    return 1;
  }
}
