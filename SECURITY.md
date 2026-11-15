# Security

Report a vulnerability privately: use **Report a vulnerability** on the repository's Security tab. Do not open a public issue. The report stays between you and the maintainer until a fix is released.

Include what you ran, the version (`toyon version`), your platform, and the smallest steps that show the problem.

## What counts

Toyon runs coding agents on your machine and serves your app through a local daemon. These matter most:

- Reaching the daemon without its token, or from a host or peer it should refuse, locally or through `toyon remote` and `toyon deploy fly`.
- An agent writing outside its copy of the project, widening its sandbox, or reading secrets it is not meant to read.
- A page in a preview reaching the shell, the daemon, or another project's preview.
- A client-supplied path reaching outside the project it names.

The gaps listed in the README's Trust section are known, such as `git push` being blocked by a command filter only. A way around them that goes further than the README describes is still worth a report.

## Versions

Toyon is pre-alpha. Fixes go into the latest release only.

## Rendered html pages

The editor pane can show an html file rendered, with its scripts running. A page in a cloned repository is untrusted, so it is never served from the origin that has the shell or the token. The daemon serves it from a separate frame origin: a loopback port locally, `frames.<name>` under a public name routed by name, and port 10000 under one routed by port (Tailscale, Fly). VS Code's webviews and Google's user content domains work the same way.

- **The address has a ticket in place of the token.** The shell requests an address from the daemon (`POST /frame`, behind the token). The address includes a random 128-bit ticket. The ticket lasts 15 minutes from minting and is never extended. The shell replaces it before it expires. The page can always read its own address and send it elsewhere, and no browser prevents that, so a ticket must give access to little.
- **What a ticket gives access to.** The page, and the files beside it that the page's markup and stylesheets name. The list is fixed when the ticket is minted: pictures, stylesheets, SVG, fonts and clips. A script, a dot file or another page is never on it. Every name is checked on the real file through plain folders, so a link named `logo.png` that points at `.env` is not served, and neither is a file with a second name on disk (a hard link). The check runs again on every request, so a file later swapped for a link is no longer served. A page in a copy can load files in that copy. A page opened from outside a copy can load files in its own folder and one level below. The daemon's own state is never served. A script that adds a picture at runtime gets a 404.
- **The policy is a header.** Every response from the frame origin, a 404 included, has `Content-Security-Policy: sandbox`, so nothing served there runs as that origin. The page's policy adds `allow-scripts` and then blocks what the page could use to send data out: `connect-src 'none'` (no response can be read back), nothing over plain http, which is how this machine's own servers are reached, no frame inside the frame, no form, no `<base>`, and `frame-ancestors` naming only the shells. The policy grammar has no IPv6 literal, so a shell at `http://[::1]:<port>` cannot be named. An address of that shape that is only listed is left out. While a shell is connected from one, the directive is left off, and the ticket and the opaque page are the remaining protection. Scripts, styles, pictures and fonts may still load from `https:` addresses, because the frame has nothing they could send out. Responses have `nosniff`, `no-store`, `referrer-policy: no-referrer` and a permissions policy that denies every feature. Only fonts are served with CORS headers, because the opaque document fetches them that way. Pictures are served without them, because a canvas could otherwise read their pixels.
- **What it does not stop.** The page can navigate its own frame to any address, including this machine's loopback and preview addresses, without reading the response. The `sandbox` attribute on the shell's frame keeps that navigation inside the frame. The page can send its own text and the files it names to any site over `https:`. A page that loops forever can freeze the window in a browser that keeps a same-site frame in the shell's process. A leaked ticket can be used until it expires by anyone who can reach the frame origin: that is loopback locally, the tailnet with Tailscale, and the internet with a public name. A browser request for the page as anything but a frame, or for a file as anything but a picture, style, font or clip, gets a 404. A request that does not state its purpose, as from `curl`, is let through.
- **Cookies.** Under one public name the frame origin is the same site as the shell, so the browser sends the preview cookie with the frame's requests. The frame handler does not read, set or echo a cookie. The sandboxed page is opaque, so its own requests have none.
- **Compared with the preview.** The preview runs the repository's own dev server with no sandbox, and the agents run its commands. The frame gives the repository's content less access than the preview does, and adds no trust that the preview did not already require.
