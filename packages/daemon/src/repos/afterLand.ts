// The repo's `afterLand` commands: what the main checkout needs doing to it once work has arrived
// on the default branch. A build, a migration, an install. They run there rather than in the
// worktree that landed, because the worktree's copy is not the one anybody looks at afterwards.
//
// Nothing waits on these. Landing is meant to feel finished the moment it is, and a build that
// takes minutes would otherwise hold the toast, the rail and the composer behind it. What a person
// gets instead is a line in the main row's log while it runs and a notice if it fails.

import type { RepoInfo } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { SelfWatch } from "../core/self.ts";
import type { StateStore } from "../core/state.ts";
import { runSetup } from "../runtime/setup.ts";

export interface AfterLandDeps {
  state: StateStore;
  hub: Hub;
  /** kept in step so the shell's notice can say "rebuilding" rather than stay on "rebuild" */
  self: SelfWatch;
}

export class AfterLand {
  private running = new Set<string>();

  constructor(private d: AfterLandDeps) {}

  busy(repoId: string): boolean {
    return this.running.has(repoId);
  }

  /** Start the repo's `afterLand`, unless it has none or a run is already going. A second land
   * while the first run is still going is not queued: the commands are catching the checkout up to
   * whatever is on the branch now, and the run in flight will have read it by the time it gets
   * there. */
  run(repoId: string): void {
    const repo = this.d.state.repo(repoId);
    const commands = repo?.config.afterLand ?? [];
    if (!repo || commands.length === 0 || this.running.has(repoId)) return;
    this.running.add(repoId);
    const done = this.exec(repo, commands).finally(() => this.running.delete(repoId));
    fireAndForget(repo.id, done, "afterLand");
  }

  private async exec(repo: RepoInfo, commands: string[]): Promise<void> {
    if (this.d.self.building(true)) this.d.hub.emit("selfChanged");
    let failure: string | undefined;
    for (const command of commands) {
      this.tellMain(repo, `afterLand: ${command}`);
      let last = "";
      const code = await runSetup(command, repo.path, (line) => {
        last = line;
        this.tellMain(repo, line);
      });
      if (code === 0) continue;
      // the last line is almost always the error the command printed; the rest is in the main
      // row's log, which is where someone who wants the whole run goes
      failure = last.trim() === "" ? `${command} (exit ${code})` : last.trim();
      this.tellMain(repo, `afterLand stopped: ${command} exited ${code}`);
      log.warn(repo.id, `afterLand stopped: ${command} exited ${code}`);
      break;
    }
    if (this.d.self.building(false, failure)) this.d.hub.emit("selfChanged");
  }

  /** a line in the main worktree's log pane, the one surface that belongs to the checkout itself */
  private tellMain(repo: RepoInfo, line: string): void {
    const main = this.d.state.worktrees.find((w) => w.repoId === repo.id && w.kind === "main");
    if (main) this.d.hub.emit("log", main.id, "land", line);
  }
}
