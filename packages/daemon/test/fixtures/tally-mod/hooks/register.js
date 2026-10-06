// The smallest mod: a plugin whose hooks are functions Claude Code calls in its own process. The
// integration test loads it from this folder through agents.json and runs /tally.
let calls = 0;

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "tally", description: "Show how many tool calls Claude has made" });
    return next(e);
  });
  on("tool.call", async (_$, e, next) => {
    calls += 1;
    return next(e);
  });
  on("command.run", { command: "tally" }, async () => {
    return { text: `Claude has made ${calls} tool calls since this mod loaded` };
  });
}
