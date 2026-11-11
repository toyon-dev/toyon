# Managed policy

A policy file turns parts of Toyon off for everyone on a machine. IT deploys it the same way as managed settings for Chrome, Firefox, Docker Desktop and Claude Code. The user of the machine cannot change it. `toyon doctor` shows the active policy and which file it came from.

## File locations

| Platform | Path | Format |
|---|---|---|
| macOS | `/Library/Managed Preferences/dev.toyon.plist` | Configuration profile for the `dev.toyon` domain, at computer scope |
| macOS | `/Library/Managed Preferences/<user>/dev.toyon.plist` | The same profile, at user scope |
| macOS | `/Library/Application Support/toyon/policy.json` | JSON, for deploying with a script |
| Linux | `/etc/toyon/policy.json` | JSON |

- Toyon reads every file that exists and merges them. If two files set the same key, the stricter value applies.
- A JSON file must be owned by root, and not writable by group or others. Otherwise it is treated as invalid.
- The profile plists are trusted because MDM controls that location.
- The CLI reads the files on every run. A running Toyon reads them once, at start. After you deploy a file, run `toyon restart`. `toyon doctor` reports when the running Toyon has an older policy.

## Keys

Every key is optional. A missing key means the feature is allowed. Unknown keys are ignored, so a file written for a newer Toyon still works.

| Key | Type | What it turns off |
|---|---|---|
| `updates` | boolean | `false`: Toyon does not check for or install updates, `toyon update` is refused, and a Toyon started with npx does not offer the global install. A user can still run `npx toyon@latest`. Use your software allowlist to pin versions. |
| `deploy` | boolean | `false`: `toyon deploy` is refused. |
| `remote` | `"any"`, `"tailscale"` or `"off"` | `"off"`: `toyon remote` is refused, and an existing `remote.json` is ignored. `"tailscale"`: only a `*.ts.net` hostname is accepted, so Toyon can be opened only over your tailnet. |
| `agents` | list of agent ids | Only the listed agents are available. The others are not shown in the picker and are never installed. The built-in ids are `claude`, `codex` and `opencode`. |
| `customAgents` | boolean | `false`: `~/.toyon/agents.json` is ignored. Users cannot add an agent, replace a built-in agent, or change a built-in agent's environment and session options. |
| `brandedListener` | boolean | `false`: Toyon does not listen on port 80 for `http://toyon.localhost`. It is available at `http://toyon.localhost:4141` only. |
| `planSignIn` | boolean | `false`: signing in with a personal Claude plan is not offered in the chat, and is refused if requested. API keys and gateways still work. |

This example keeps company laptops off the public internet and on company accounts:

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

The same policy as a profile payload, for the `dev.toyon` preference domain:

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

## What users see

A command the policy turns off prints the reason and exits with status 1:

```
toyon: deploy is turned off by your organization's policy (/etc/toyon/policy.json)
```

In the app:

- The update chip is not shown.
- A disabled menu row reads "managed by your organization".
- The chat's sign-in card leaves out the plan login and says why.
- The settings card (<kbd>⌘,</kbd>) has one line that lists what is turned off.

## Verify the policy

Run `toyon doctor`:

```
$ toyon doctor
ok   cli      toyon 0.21.0, bun 1.4.4, darwin arm64
ok   home     /Users/kyle/.toyon
ok   git      git version 2.47.0
ok   github   gh version 2.80.0, signed in; the pull request land route can open and merge pull requests
ok   policy   /Library/Application Support/toyon/policy.json: updates off, deploy off, remote tailscale, agents claude, codex, custom agents off, plan sign-in off
ok   daemon   0.21.0 at http://127.0.0.1:4141, pid 41231
ok   running  2 of 5 worktrees started; the rest start when opened
ok   updates  off by your organization's policy
```

A file that cannot be read is a failing line. Everything the policy controls is turned off until the file is fixed:

```
FAIL policy   /etc/toyon/policy.json: not valid JSON (everything it governs is off)
```

If the running Toyon started before the file changed, `toyon doctor` adds a failing `daemon` line that says to run `toyon restart`.

## Limits

- The policy applies to this install of Toyon only. It does not stop a user from running another copy of Toyon, an older version, or the agents directly.
- The sandbox and the permission modes are the same with or without a policy. See [trust.md](trust.md).
- What the policy guarantees: on this machine, this Toyon has the listed features turned off for every user, and `toyon doctor` shows it.
