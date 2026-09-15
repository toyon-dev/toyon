# Toyon somewhere other than your laptop

Toyon can run on a box you open from your phone, or on your own Fly account with the laptop closed. None of it passes through a Toyon server; there is none. These routes are new. On Fly, a browser has opened the shell and two copies' previews, an agent's edit has shown up in a preview without a reload, and every refusal has been checked from outside. On a tailnet, a phone has opened the shell and a preview and seen an agent's edit arrive without a reload. The Caddy route has been checked with requests shaped like its own, and has not been opened from a phone yet. The shell has no phone layout yet: on a phone, open a preview in its own tab.

[toyon.cloud](https://toyon.cloud) keeps a list of your machines in your browser, and nothing else. `toyon deploy fly up` and `toyon remote` open it with the new machine added, and a machine's own menu has "add to toyon.cloud" for another browser. The link carries the address, never the token.

A host needs a process that stays up, a disk that survives restarts, WebSockets, and either a wildcard name or a range of ports it forwards. That rules out serverless hosts and hosts that scale to zero with no disk.

## Your own box, with your own domain

Tell toyon the name, then point the name and everything under it at a Caddy on the same machine:

```sh
toyon remote toyon.example.com
```

```
toyon.example.com, *.toyon.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:4141
}
```

The wildcard certificate needs Caddy's DNS challenge, built with your DNS provider's module; the example uses Cloudflare's. Each copy's preview gets its own name under yours, so each keeps its own cookies. `toyon stop` then `toyon` applies the setting.

## Your own box on your tailnet, with no domain

Turn on MagicDNS and HTTPS certificates in the Tailscale admin console, sign the box in with `tailscale up`, then:

```sh
toyon remote --tailscale
```

Toyon reads the box's name from Tailscale and sets up `tailscale serve` for itself on 443 and for previews on ports 10001-10008; Tailscale cannot issue a wildcard certificate, so each preview gets its own port and eight copies can run at once. If one of those ports already serves something else, the command stops before changing anything. `toyon remote off` removes every entry that proxies one of those ports to this machine, including one you set yourself in that shape, and leaves the rest; run it before `toyon uninstall`, which does not. `toyon stop` then `toyon` applies the setting. On this route every copy shares one set of cookies, so two copies of an app with a login sign each other out.

## Your own Fly account

```sh
npx toyon deploy fly up my-toyon
```

It needs flyctl signed in (`fly auth login`). An Anthropic API key in `ANTHROPIC_API_KEY` or `~/.toyon/cloud/anthropic.key` goes to the machine; without one, the first chat asks you to sign in with your Claude plan, in toyon's terminal, and the login stays on the volume. Toyon builds the machine in your Fly builder from the package you ran, gives it a 5 GB volume in the region closest to you, and prints the link. `--repo https://github.com/you/app.git` clones your repository onto it the first time; a private one needs a GitHub token with access to it in `GITHUB_TOKEN` or `~/.toyon/cloud/github.token`. `toyon deploy fly url my-toyon` prints the link again, and `toyon deploy fly destroy my-toyon` deletes the app and its volume.

- The machine measured about $4-6 a month in ordinary use and $10-11 left running all month, volume included, plus whatever your agents spend.
- It stops when idle, but an open Toyon tab keeps it awake.
- The volume holds the only copy of anything you have not pushed.
- Code you run on it can read the Anthropic key or the Claude login, as it can on your laptop.
- The first prompt waits while the agents install.
- flyctl warns that some preview ports have nothing listening. Each one gets a listener when a copy uses it.
- The first deploy right after an app is created can fail with "unauthorized". Running `up` again finishes it.

## Another host

The Dockerfile that machine is built from ships in the package under `cloud/`, and runs on any host that meets the needs above. It reads:

| Setting | What it is |
| --- | --- |
| `TOYON_PUBLIC_HOST` | The name your host answers for, like `toyon.example.com`. Required. |
| `TOYON_PREVIEWS` | Where previews live under that name: `https://toyon.example.com:{port}` when the host forwards ports 10001-10008 (the default), or `https://w{id}.toyon.example.com` behind your own wildcard domain. |
| `TOYON_TOKEN` | A long random string; the link is `https://<host>/#token=<it>`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | For the agents. |
| `GITHUB_TOKEN`, `TOYON_REPO_URL` | Optional: a repository to clone on first start, and access to it. |
| `TOYON_PROC_SLEEP_MS` | Optional: how long a copy nobody looks at keeps its servers running, in milliseconds. Five minutes by default on a deployed machine; `off` keeps them running. |
| `/data` | A disk that survives restarts. |
| Ports | 4141 for Toyon, over https with the host's TLS in front, and 10001-10008 when previews use ports. |

A host with a single public port needs your own wildcard domain and the `w{id}` form.

## On every route

The link carries the token, and the token is a shell on that machine: keep it to yourself. A project whose server bakes another server's address into its bundle (`API_URL` and the like) points the browser at `127.0.0.1`, which a phone cannot reach; a project with one server works.

The daemon still listens on loopback only. A front on the same machine admits one name, over https only, and on a Fly machine the platform's proxy is that front. A preview reached through the name also needs a cookie the toyon page is given, which the dev server behind it never sees. The rest of the boundary is in [trust.md](trust.md).
