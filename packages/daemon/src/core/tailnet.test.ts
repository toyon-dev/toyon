import { expect, test } from "bun:test";
import { tailnetLine } from "@toyon/shared";
import { readTailnetPhones, tailnetPhones } from "./tailnet.ts";

const status = (peers: object[]) => JSON.stringify({ Peer: Object.fromEntries(peers.map((p, i) => [`k${i}`, p])) });

test("phones are the android and iOS peers, with whether each is connected", () => {
  const json = status([
    { HostName: "Pixel 10 Pro", OS: "android", Online: true, TailscaleIPs: ["100.1.1.1"] },
    { HostName: "", DNSName: "kyles-iphone.tail.ts.net.", OS: "iOS", Online: false },
    { HostName: "box", OS: "linux", Online: true },
  ]);
  expect(tailnetPhones(json)).toEqual([
    { name: "Pixel 10 Pro", online: true, ip: "100.1.1.1" },
    { name: "kyles-iphone", online: false, ip: null },
  ]);
});

test("a phone the status calls offline is on when it answers a ping", async () => {
  const json = status([
    { HostName: "idle", OS: "android", Online: false, TailscaleIPs: ["100.1.1.1"] },
    { HostName: "gone", OS: "android", Online: false, TailscaleIPs: ["100.1.1.2"] },
  ]);
  const phones = await readTailnetPhones(async (args) =>
    args[0] === "status" ? { ok: true, out: json } : { ok: args.at(-1) === "100.1.1.1", out: "" },
  );
  expect(phones).toEqual([
    { name: "idle", online: true },
    { name: "gone", online: false },
  ]);
  expect(await readTailnetPhones(null)).toBeNull();
});

test("a tailnet with no peers has no phones; prose from a stopped tailscaled is not an answer", () => {
  expect(tailnetPhones("{}")).toEqual([]);
  expect(tailnetPhones("failed to connect to local tailscaled")).toBeNull();
});

test("the line names the phone and says what to do when none is connected", () => {
  expect(tailnetLine([{ name: "Pixel", online: true }])).toEqual({ ok: true, text: "Pixel is on your tailnet." });
  expect(tailnetLine([{ name: "Pixel", online: false }])).toEqual({
    ok: false,
    text: "Pixel is not answering on your tailnet. Check Tailscale is on there.",
  });
  expect(
    tailnetLine([
      { name: "Pixel", online: false },
      { name: "iPhone", online: false },
    ]).text,
  ).toBe("Pixel and iPhone are not answering on your tailnet. Check Tailscale is on there.");
  expect(tailnetLine([]).ok).toBe(false);
  expect(tailnetLine(null).ok).toBe(true);
});
