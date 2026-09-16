import { expect, test } from "bun:test";
import { launcherAddLink, pairLink } from "@toyon/shared";

// The inline boot script in index.html runs before any module, so it spells out two shapes shared
// owns: the pairing fragment it reads, and the toyon.cloud link it sends a paired phone to.

const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

test("the boot script reads the fragment a pairing link carries", () => {
  const link = pairLink("box.example.com", "AbC_12-xyZ9q");
  const m = new URL(link).hash.match(/pair=([A-Za-z0-9_-]+)/);
  expect(m?.[1]).toBe("AbC_12-xyZ9q");
  expect(html).toContain("/pair=([A-Za-z0-9_-]+)/");
});

test("the boot script sends a paired phone to the launcher's add link", () => {
  // an empty origin encodes to nothing, which leaves the link's fixed part
  const prefix = launcherAddLink("");
  expect(html).toContain(`\`${prefix}\${encodeURIComponent(location.origin)}\``);
});
