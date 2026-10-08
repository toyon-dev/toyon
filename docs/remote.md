# Toyon somewhere other than your laptop

Toyon can run on a box you open from your phone, or on your own Fly account with the laptop closed. None of it passes through a Toyon server; there is none. These routes are new. On Fly, a browser has opened the shell and two copies' previews, an agent's edit has shown up in a preview without a reload, and every refusal has been checked from outside. On a tailnet, a phone has opened the shell and a preview and seen an agent's edit arrive without a reload. The Caddy route has been checked with requests shaped like its own, and has not been opened from a phone yet. On a phone, the shell switches between the chat, the preview and the code with tabs in the bar.

## Pairing a device

Every device gets in the same way: it opens the machine's address, asks to be let in, and shows two words. Toyon's window on the machine shows the same two words with one button, and a yes there opens the shell on the device. The token never leaves the machine except through that yes.

- **Your phone.** Press the phone button in the bar. With Tailscale signed in and HTTPS on, the card offers "turn on", which sets up `tailscale serve` for Toyon and takes effect at once. The card then draws the address as a QR code; scan it with the phone's camera, and let the phone in when its two words appear on the card.
- **Another machine.** In Toyon on the other machine, "add a machine" in the app menu lists the Toyons on your tailnet. Press "request access" on this one, and let it in here. A machine not on the tailnet, such as a Fly machine, goes in the address field underneath.
- **A box with no window open on it**, such as a server over ssh: `toyon pair` turns the name on if it is off, prints the address, and answers each device from the terminal.
- **A Fly machine** is listed in Toyon on the laptop that deployed it. Pair your phone with it from there.

A knock that you did not expect shows too, named by where it came from. Nothing gets in until you press let in, and an unanswered knock is gone in five minutes. On a public name one address can hold only two of the waiting slots.

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

The wildcard certificate needs Caddy's DNS challenge, built with your DNS provider's module; the example uses Cloudflare's. Each copy's preview gets its own name under yours, so each keeps its own cookies. The setting takes effect at once.

## Your own box on your tailnet, with no domain

Turn on MagicDNS and HTTPS certificates in the Tailscale admin console, sign the box in with `tailscale up`, then:

```sh
toyon remote --tailscale
```

Toyon reads the box's name from Tailscale and sets up `tailscale serve` for itself on 443 and for previews on ports 10001-10008; Tailscale cannot issue a wildcard certificate, so each preview gets its own port and eight copies can run at once. If one of those ports already serves something else, the command stops before changing anything. The phone button in the bar does the same without a terminal. `toyon remote off` removes every entry that proxies one of those ports to this machine, including one you set yourself in that shape, and leaves the rest; run it before `toyon uninstall`, which does not. The setting takes effect at once; copies already running move onto the forwarded ports. On this route every copy shares one set of cookies, so two copies of an app with a login sign each other out.

## Your own Fly account

```sh
npx toyon deploy fly up my-toyon
```

It needs flyctl signed in (`fly auth login`). An Anthropic API key in `ANTHROPIC_API_KEY` or `~/.toyon/cloud/anthropic.key` goes to the machine; without one, the first chat asks you to sign in with your Claude plan, in toyon's terminal, and the login stays on the volume. Toyon builds the machine in your Fly builder from the package you ran, gives it a 5 GB volume in the region closest to you, and lists it in Toyon on this machine, or prints the link when no Toyon runs here. `--repo https://github.com/you/app.git` clones your repository onto it the first time; a private one needs a GitHub token with access to it in `GITHUB_TOKEN` or `~/.toyon/cloud/github.token`. `toyon deploy fly url my-toyon` prints the link again, and `toyon deploy fly destroy my-toyon` deletes the app and its volume.

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

The daemon still listens on loopback only. A front on the same machine admits one name, over https only, and on a Fly machine the platform's proxy is that front. The name typed without `https://` is sent to it; the token in the link stays in the browser through that. A preview reached through the name also needs a cookie the toyon page is given, which the dev server behind it never sees. The rest of the boundary is in [trust.md](trust.md).
