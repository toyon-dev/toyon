#!/usr/bin/env bun
// Write the machine image's build context from a packed source tree, for CI to build and publish:
// the same context `toyon deploy fly` sends to a Fly builder. Run `bun run pack` first. Prints
// BUN_VERSION=<version> for the build argument.
//
//   bun scripts/machine-context.ts <out>

import { bunVersion, machineSources, writeMachineContext } from "../packages/cli/src/deploy/context.ts";

const out = process.argv[2];
const src = machineSources();
if (!out || !src) {
  console.error("usage: bun scripts/machine-context.ts <out>, after bun run pack");
  process.exit(2);
}
writeMachineContext(src, out);
console.log(`BUN_VERSION=${bunVersion}`);
