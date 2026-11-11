# Phone and other devices

Open Toyon from your phone or from another computer. The device connects to the machine Toyon runs on over Tailscale, or over a public address if you set one up in [remote.md](remote.md).

## Requirements

- Tailscale installed and signed in on both devices.
- MagicDNS and HTTPS certificates turned on in the Tailscale admin console.

## Pair a phone

1. In Toyon, press the phone button in the top bar.
2. Press "turn on". This sets up `tailscale serve` for Toyon.
3. Scan the QR code with the phone's camera.
4. The phone shows two words. When the same two words appear on the card in Toyon, press let in.

Below the QR code, the card lists every device on your tailnet. A dot shows whether the device is reachable from this machine. A grey dot on this machine's own row means Tailscale is off here.

On a phone, tabs in the bar switch between the chat, the preview and the code.

## Pair another computer

1. In Toyon on the other computer, open "your devices" in the app menu. It lists the Toyons on your tailnet.
2. Press "request access" on this machine's row.
3. On this machine, press let in.

For a machine that is not on your tailnet, such as a Fly machine, enter its address in the field below the list.

## Pair from a terminal

On a machine with no Toyon window open, such as a server you reach over ssh, run:

```sh
toyon pair
```

It turns remote access on if it is off, prints the address, and asks about each device in the terminal.

## Pair with a Fly machine

A Fly machine is listed in Toyon on the laptop that deployed it. Pair your phone from there.

## Requests

- Every device pairs the same way: it opens the address, asks for access, and shows two words. Toyon shows the same two words and a button.
- The access token is sent to the device only when you press let in.
- Unexpected requests are shown too, with the address they came from.
- A request unanswered for five minutes is dropped.
- On a public address, one IP address can have two requests waiting at most.

## Limits

- Over Tailscale, eight copies can have a preview at once.
- Over Tailscale, all copies share one set of cookies. Two copies of an app with a login sign each other out.
- If your frontend builds another server's address into its bundle, as an `API_URL` variable does, the phone's browser is sent to `127.0.0.1` and cannot reach it. A project with one server works.
