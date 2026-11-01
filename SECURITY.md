# Security

Please report a vulnerability privately, not in a public issue: use **Report a vulnerability** on the repository's Security tab. The report stays between you and the maintainer until a fix is out.

Useful to include: what you ran, the version (`toyon version`), your platform, and the smallest steps that show the problem.

## What counts

Toyon runs coding agents on your machine and serves your app through a local daemon, so these matter most:

- Reaching the daemon without its token, or from a host or peer it should refuse, locally or through `toyon remote` and `toyon deploy fly`.
- An agent writing outside its own copy of the project, widening its own sandbox, or reading secrets it is meant not to see.
- A page in a preview reaching the shell, the daemon, or another project's preview.
- A client-supplied path reaching outside the project it names.

The limits already written in the README's Trust section, such as the push deny list being a command filter rather than a wall, are known. A way around them that goes further than the README says is still worth a report.

## Versions

Toyon is pre-alpha. Fixes go into the latest release only.

## Rendered html pages

The editor pane can show an html file rendered, with its scripts running. A page in a cloned repository is nobody's to trust, so it is never shown where the shell or the token lives. The daemon serves it from a frame origin of its own: a loopback port locally, `frames.<name>` under a public name routed by name, and port 10000 under one routed by port (Tailscale, Fly). This is the same shape as VS Code's webviews and Google's user content domains.

- **A ticket, not the token.** The shell asks the daemon for an address (`POST /frame`, behind the token). The answer carries a random 128-bit ticket that lasts 15 minutes from minting, is never extended, and is replaced by the shell before it runs out. The page can always read its own address and send it somewhere, which no browser prevents, so a ticket has to be worth little.
- **What a ticket reads.** The page, and the files the page's markup and stylesheets name beside it, decided when the ticket is minted: pictures, stylesheets, SVG, fonts and clips, never a script, a dot file, or another page. Every name is checked on the real file through plain folders, so a link named `logo.png` that points at `.env` is not served, nor a file with a second name on disk (a hard link), and the check runs again on every request, so a file swapped for a link later is gone. A page in a worktree reaches files in that worktree; a page opened from outside one reaches its own folder and one below; the daemon's own state is never reached. A script that adds a picture at runtime gets a 404.
- **The policy is a header.** Every answer from the frame origin, a 404 included, carries `Content-Security-Policy: sandbox`, so nothing served there ever runs as that origin. The page's policy adds `allow-scripts` and then shuts what the page could use to carry something off: `connect-src 'none'` (no response can be read back), nothing over plain http (this machine's own servers), no frame inside the frame, no form, no `<base>`, and `frame-ancestors` naming the shells alone. The policy grammar has no IPv6 literal, so a shell at `http://[::1]:<port>` cannot be named: an address of that shape that is merely listed is left out, and while a shell has actually connected from one the directive is left off, and the ticket and the opaque page are what hold. Scripts, styles, pictures and fonts may still load from `https:` addresses, since the frame holds nothing those could carry off. Responses carry `nosniff`, `no-store`, `referrer-policy: no-referrer` and a permissions policy that denies every feature. Fonts alone answer CORS, because the opaque document fetches them that way; a picture does not, or a canvas could read its pixels.
- **What it does not stop.** The page can navigate its own frame to any address, including this machine's loopback and preview addresses, without reading the answer; the `sandbox` attribute on the shell's frame is what keeps that navigation inside the frame. It can send what it holds, which is its own text and the files it names, to a site of its own over `https:`. A page that loops forever can freeze the window in a browser that keeps a same-site frame in the shell's process. A leaked ticket can be used by anyone who reaches the frame origin for the rest of its minutes: that is loopback locally, the tailnet with Tailscale, and the internet with a public name. A browser asking for the page as anything but a frame, or for a file as anything but a picture, style, font or clip, gets a 404; `curl` says nothing about what it is and is let through.
- **Cookies.** Under one public name the frame origin is the same site as the shell, so the preview cookie arrives on the frame's requests. The frame handler neither reads, sets nor echoes a cookie, and the sandboxed page is opaque, so its own requests carry none.
- **Against the preview.** The preview runs the repository's own dev server with no sandbox, and the agents run its commands. The frame is a narrower place to run the repository's content than Toyon has always had; it adds no trust the preview did not already take.
