# Your own server

Run Toyon on a server to keep it working when your laptop is closed. There is no hosted Toyon service, and your code and keys are never sent to Toyon. These setups are new: see [What has been tested](#what-has-been-tested).

To open Toyon from a phone or another computer, see [phone.md](phone.md).

## Requirements

A host needs:

- a process that stays running,
- a disk that survives restarts,
- WebSockets,
- a wildcard domain, or a range of ports it forwards.

Serverless hosts, and hosts that scale to zero with no disk, do not work.

## Your own domain

1. Tell Toyon the domain:

   ```sh
   toyon remote toyon.example.com
   ```

2. Point the domain and its subdomains at Caddy on the same machine:

   ```
   toyon.example.com, *.toyon.example.com {
   	tls {
   		dns cloudflare {env.CF_API_TOKEN}
   	}
   	reverse_proxy 127.0.0.1:4141
   }
   ```

- The wildcard certificate needs Caddy's DNS challenge, built with your DNS provider's module. The example uses Cloudflare's.
- Each copy's preview gets a separate subdomain and separate cookies.
- The setting takes effect at once.

## Tailscale, with no domain

1. In the Tailscale admin console, turn on MagicDNS and HTTPS certificates.
2. Sign the machine in with `tailscale up`.
3. Run:

   ```sh
   toyon remote --tailscale
   ```

Toyon reads the machine's name from Tailscale and sets up `tailscale serve` on these ports:

| Port | Used for |
|---|---|
| 443 | Toyon |
| 10000 | rendered HTML pages |
| 10001-10008 | previews |

- Tailscale cannot issue a wildcard certificate, so each preview gets a port. Eight copies can have a preview at once.
- If one of those ports is already in use, the command stops before it changes anything.
- The setting takes effect at once. Copies already running move to the forwarded ports.
- All copies share one set of cookies. Two copies of an app with a login sign each other out.
- The phone button in Toyon's top bar does the same setup without a terminal.

`toyon remote off` removes every `tailscale serve` entry that forwards one of those ports to this machine, including one you added yourself in that form. Other entries are kept. Run it before `toyon uninstall`, which does not remove them.

## Fly

```sh
npx toyon deploy fly up my-toyon
```

You need flyctl, signed in with `fly auth login`.

- **Agent login.** An Anthropic API key in `ANTHROPIC_API_KEY` or `~/.toyon/cloud/anthropic.key` is sent to the machine. Without one, the first chat asks you to sign in with your Claude plan in Toyon's terminal. The login is stored on the volume.
- **What it creates.** Toyon builds the machine in your Fly builder, from the package you ran. It gets a 5 GB volume in the region closest to you.
- **Where to find it.** The machine is listed in Toyon on this computer. If Toyon is not running here, the command prints the link.
- **Your repository.** `--repo https://github.com/you/app.git` clones it onto the machine the first time. A private repository needs a GitHub token in `GITHUB_TOKEN` or `~/.toyon/cloud/github.token`.

| Command | What it does |
|---|---|
| `toyon deploy fly url my-toyon` | Print the link again. |
| `toyon deploy fly destroy my-toyon` | Delete the app and its volume. |

Cost and limits:

- The machine measured about $4-6 a month in ordinary use and $10-11 running all month, volume included. Agent usage is extra.
- It stops when idle. An open Toyon tab keeps it running.
- Work you have not pushed exists only on the volume.
- Code you run on it can read the Anthropic key or the Claude login, as it can on your laptop.
- The first message is delayed while the agents install.
- flyctl warns that some preview ports have nothing listening. This is expected: a port gets a listener when a copy uses it.
- The first deploy after an app is created can fail with "unauthorized". Run `up` again.

## Another host

The Dockerfile for the Fly machine is in the package under `cloud/`. It runs on any host that meets the requirements above.

| Setting | What it is |
| --- | --- |
| `TOYON_PUBLIC_HOST` | The hostname your host answers for, such as `toyon.example.com`. Required. |
| `TOYON_PREVIEWS` | Where previews are served. `https://toyon.example.com:{port}` when the host forwards ports 10001-10008; this is the default. `https://w{id}.toyon.example.com` behind your own wildcard domain. |
| `TOYON_TOKEN` | A long random string. The link is `https://<host>/#token=<it>`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Keys for the agents. |
| `GITHUB_TOKEN`, `TOYON_REPO_URL` | Optional. A repository to clone on first start, and a token with access to it. |
| `TOYON_PROC_SLEEP_MS` | Optional. How long an unopened copy keeps its servers running, in milliseconds. Default on a deployed machine: five minutes. `off` keeps them running. |
| `/data` | A disk that survives restarts. |
| Ports | 4141 for Toyon, over https with the host's TLS in front. 10001-10008 when previews use ports. |

A host with one public port needs your own wildcard domain and the `w{id}` form.

## Security

- Anyone with the link has shell access to the machine. Do not share it.
- Toyon still listens on loopback only. A reverse proxy on the same machine accepts one hostname, over https only. On Fly, Fly's proxy does this.
- A name typed without `https://` is redirected to https. The token in the link stays in the browser during the redirect.
- A preview reached through the hostname also needs a cookie that Toyon's page is given. The dev server behind the preview never sees that cookie.

See [trust.md](trust.md) for the sandbox, the tokens and the network traffic.

## What has been tested

- **Fly.** A browser opened Toyon and two copies' previews. An agent's edit appeared in a preview without a reload. Requests that should be refused were tested from outside the machine.
- **Tailscale.** A phone opened Toyon and a preview, and an agent's edit appeared without a reload.
- **Caddy.** Checked with requests shaped like Caddy's. Not opened from a phone yet.
