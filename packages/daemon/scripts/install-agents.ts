// Pre-install the builtin agent adapters (the cloud image runs this at build time so a fresh
// machine never downloads at boot). Honors TOYON_AGENTS_DIR / TOYON_HOME like the daemon.
import { loadAgentRegistry } from "../src/agent/registry.ts";
import { ensureDirs, makePaths } from "../src/core/paths.ts";

const paths = makePaths();
ensureDirs(paths);
const agents = loadAgentRegistry(paths.home, paths.agentsDir);
await agents.installMissing();
const bad = agents.infos().filter((a) => !a.available);
if (bad.length) {
  console.error(bad.map((a) => `${a.id}: ${a.reason}`).join("\n"));
  process.exit(1);
}
console.log(
  agents
    .infos()
    .map((a) => a.id)
    .join(", "),
  "ready in",
  paths.agentsDir,
);
