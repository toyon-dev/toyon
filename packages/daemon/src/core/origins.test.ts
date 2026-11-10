import { describe, expect, test } from "bun:test";
import type { Remote } from "@toyon/shared";
import { Origins } from "./origins.ts";

const origins = (remote: Remote | null = null) =>
  new Origins({
    setting: { get: () => remote } as never,
    port: 4141,
    branded: () => true,
    appPorts: () => [5173, 6001],
  });

describe("isPreview", () => {
  test("a worktree's preview and proc ports are the app's, under any loopback name", () => {
    const o = origins();
    for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173", "http://[::1]:6001"]) {
      expect(o.isPreview(origin)).toBe(true);
    }
  });
  test("a name under the shell's is a preview's, whatever the port", () => {
    const o = origins();
    expect(o.isPreview("http://w3.toyon.localhost:4141")).toBe(true);
    expect(o.isPreview("http://w3.toyon.localhost")).toBe(true);
    expect(o.isPreview("http://app.localhost:4242")).toBe(true);
  });
  test("a second daemon's shell on this machine is not one", () => {
    const o = origins();
    for (const origin of ["http://127.0.0.1:4242", "http://localhost:4242", "http://toyon.localhost:4242"]) {
      expect(o.isPreview(origin)).toBe(false);
    }
  });
  test("under a public name its previews and the frame authority are, by name or by port", () => {
    const named = origins({ host: "mac.example.com", previews: "https://w{id}.mac.example.com", front: "local" });
    expect(named.isPreview("https://w3.mac.example.com")).toBe(true);
    expect(named.isPreview("https://frames.mac.example.com")).toBe(true);
    expect(named.isPreview("https://mac.example.com")).toBe(false);
    expect(named.isPreview("https://home.example.com")).toBe(false);
    const ported = origins({ host: "mac.example.com", previews: "https://mac.example.com:{port}", front: "local" });
    expect(ported.isPreview("https://mac.example.com:10001")).toBe(true);
    expect(ported.isPreview("https://mac.example.com")).toBe(false);
  });
  test("what names no origin is treated as one", () => {
    expect(origins().isPreview("null")).toBe(true);
  });
});
