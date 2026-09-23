# Managed policy

A file IT pushes to a machine that turns parts of Toyon off for everyone who uses it. The person at the keyboard cannot change it, every key is locked, and `toyon doctor` shows what is in effect and where it came from. It is the same shape Chrome, Firefox, Docker Desktop and Claude Code use for managed settings, so the tooling that deploys those deploys this.

## Where it lives

| Platform | Path | Format |
|---|---|---|
| macOS | `/Library/Managed Preferences/dev.toyon.plist` | a configuration profile for the `dev.toyon` domain, installed at computer scope |
| macOS | `/Library/Managed Preferences/<user>/dev.toyon.plist` | the same profile installed at user scope |
| macOS | `/Library/Application Support/toyon/policy.json` | JSON, for a shop that pushes files with a script |
| Linux | `/etc/toyon/policy.json` | JSON |

Every file that exists is read and merged. Where two set the same key, the stricter value wins. A JSON file must be owned by root and not writable by group or others; one that is not is treated as invalid. The profile plists are trusted as MDM's own location.

The CLI reads the files on every run. The daemon reads them once, when it starts, so a file pushed while it is running takes effect at the next `toyon restart`; `toyon doctor` says when the running daemon is behind.

## Keys

Every key is optional. A key that is absent is allowed. Unknown keys are ignored, so a file written for a newer Toyon still reads.

| Key | Type | What it turns off |
|---|---|---|
| `updates` | boolean | `false`: Toyon never checks for or installs a newer version, and `toyon update` refuses. This governs self-update only; a person can still run `npx toyon@latest`, and pinning what runs is the job of your software allowlist. |
| `deploy` | boolean | `false`: `toyon deploy` refuses, and the "add to toyon.cloud" row in the app is greyed. |
| `remote` | `"any"`, `"tailscale"` or `"off"` | `off`: `toyon remote` refuses and the daemon ignores a `remote.json` it finds. `tailscale`: only a `*.ts.net` name is accepted, so the shell opens over your tailnet and nowhere else. |
| `agents` | list of agent ids | Only the agents listed exist: the others are gone from the picker and are never installed. The builtin ids are `claude`, `codex` and `opencode`. |
| `customAgents` | boolean | `false`: `~/.toyon/agents.json` is ignored, so nobody can add an agent of their own or shadow a builtin with one. |
| `brandedListener` | boolean | `false`: the daemon does not bind port 80 for `http://toyon.localhost`; the shell is at `http://toyon.localhost:4141` only. |
| `planSignIn` | boolean | `false`: signing in with a personal Claude plan is not offered in the chat, and a request for it is refused. Keys and gateways still work. |

An example that keeps a company's laptops off the public internet and on its own accounts:

```json
{
  "updates": false,
  "deploy": false,
  "remote": "tailscale",
  "agents": ["claude", "codex"],
  "customAgents": false,
  "planSignIn": false
}
```

The same file as a profile payload, for the `dev.toyon` preference domain:

```xml
<dict>
  <key>updates</key><false/>
  <key>deploy</key><false/>
  <key>remote</key><string>tailscale</string>
  <key>agents</key><array><string>claude</string><string>codex</string></array>
  <key>customAgents</key><false/>
  <key>planSignIn</key><false/>
</dict>
```

## What a person sees

A verb the policy turns off says so and exits 1:

```
toyon: deploy is turned off by your organization's policy (/etc/toyon/policy.json)
```

In the app, the update chip does not appear, a greyed menu row reads "managed by your organization", the chat's sign-in card leaves the plan login out and says why, and the settings card (⌘,) carries one line naming what is off.

## Checking it took

```
$ toyon doctor
ok   cli      toyon 0.4.1, bun 1.4.2, darwin arm64
ok   home     /Users/kyle/.toyon
ok   policy   /Library/Application Support/toyon/policy.json: updates off, deploy off, remote tailscale, agents claude, codex, custom agents off, plan sign-in off
ok   git      git version 2.47.0
ok   daemon   0.4.1 at http://127.0.0.1:4141, pid 41231
ok   updates  off by your organization's policy
```

A file that will not read is a failing line, and everything the policy governs is off until it is fixed:

```
FAIL policy   /etc/toyon/policy.json: not valid JSON (everything it governs is off)
```

When the running daemon started before the file changed, doctor adds a failing `daemon` line saying `toyon restart` applies the current one.

## What it does not do

It is a policy for Toyon, not a wall around the machine. It cannot stop a person running another copy of Toyon, an older one, or the agents directly. The sandbox and the permission modes in [trust.md](trust.md) are the same with or without it. What the policy guarantees is that this Toyon, on this machine, has the listed things off for everyone, and that doctor proves it.
