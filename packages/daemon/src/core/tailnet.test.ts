import { expect, test } from "bun:test";
import { tailnetLine } from "@toyon/shared";
import { tailnetPhones } from "./tailnet.ts";

const status = (peers: object[]) => JSON.stringify({ Peer: Object.fromEntries(peers.map((p, i) => [`k${i}`, p])) });

test("phones are the android and iOS peers, with whether each is connected", () => {
  const json = status([
    { HostName: "Pixel 10 Pro", OS: "android", Online: true },
    { HostName: "", DNSName: "kyles-iphone.tail.ts.net.", OS: "iOS", Online: false },
    { HostName: "box", OS: "linux", Online: true },
  ]);
  expect(tailnetPhones(json)).toEqual([
    { name: "Pixel 10 Pro", online: true },
    { name: "kyles-iphone", online: false },
  ]);
});

test("a tailnet with no peers has no phones; prose from a stopped tailscaled is not an answer", () => {
  expect(tailnetPhones("{}")).toEqual([]);
  expect(tailnetPhones("failed to connect to local tailscaled")).toBeNull();
});

test("the line names the phone and says what to do when none is connected", () => {
  expect(tailnetLine([{ name: "Pixel", online: true }])).toEqual({ ok: true, text: "Pixel is on your tailnet." });
  expect(tailnetLine([{ name: "Pixel", online: false }])).toEqual({
    ok: false,
    text: "Pixel is off your tailnet. Turn Tailscale on there first.",
  });
  expect(
    tailnetLine([
      { name: "Pixel", online: false },
      { name: "iPhone", online: false },
    ]).text,
  ).toBe("Pixel and iPhone are off your tailnet. Turn Tailscale on there first.");
  expect(tailnetLine([]).ok).toBe(false);
  expect(tailnetLine(null).ok).toBe(true);
});
