import { describe, expect, test } from "bun:test";
import { flyToml, regionFromRequestId, secretsInput } from "./fly.ts";

describe("flyToml", () => {
  test("names the app, its region and public name, the volume, and a TLS port for each preview", () => {
    const toml = flyToml("my-toyon", "fra");
    for (const line of [
      'app = "my-toyon"',
      'primary_region = "fra"',
      'TOYON_PUBLIC_HOST = "my-toyon.fly.dev"',
      'TOYON_PREVIEWS = "https://my-toyon.fly.dev:{port}"',
      'source = "toyon_data"',
      'path = "/health"',
      "internal_port = 4141",
    ]) {
      expect(toml).toContain(line);
    }
    for (let p = 10001; p <= 10008; p++) expect(toml).toContain(`internal_port = ${p}`);
  });
});

describe("regionFromRequestId", () => {
  test("reads the serving region off the end of Fly's request id", () => {
    expect(regionFromRequestId("01M2E48G4PVS168AWNEX10ZFB1-fra")).toBe("fra");
    expect(regionFromRequestId("01M2E48G4PVS168AWNEX10ZFB1")).toBeNull();
    expect(regionFromRequestId(null)).toBeNull();
  });
});

describe("secretsInput", () => {
  test("one NAME=VALUE line per secret that is set", () => {
    expect(secretsInput({ TOYON_TOKEN: "abc", GITHUB_TOKEN: null, ANTHROPIC_API_KEY: "sk" })).toBe(
      "TOYON_TOKEN=abc\nANTHROPIC_API_KEY=sk\n",
    );
  });
  test("a value with a line break is refused rather than split into two secrets", () => {
    expect(() => secretsInput({ A: "one\nB=two" })).toThrow("line break");
  });
});
