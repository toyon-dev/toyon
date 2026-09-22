// The repo's `afterLand` commands: what the main checkout needs doing to it once work has arrived
// on the default branch. A build, a migration, an install. They run there rather than in the
// worktree that landed, because the worktree's copy is not the one anybody looks at afterwards.
//
// Nothing waits on these. Landing is meant to feel finished the moment it is, and a build that
// takes minutes would otherwise hold the rail and the composer behind it. What a person gets
// instead is a line in the main row's log while it runs, and the reason where they are looking
// if it stops: on the self notice for the checkout toyon runs from, on the chat for any other.

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
  /** resolves once no worktree is queued to wake. A restart brings back the previews tabs
   * showed, one boot at a time; a build started beside them fights every one of those boots for
   * the core, and the person pressed restart for the tabs, not the build. */
  settled?: () => Promise<void>;
}

export class AfterLand {
  private running = new Set<string>();
  /** repos whose branch moved again while their run was going: one more run when it ends */
  private again = new Set<string>();

  constructor(private d: AfterLandDeps) {}

  busy(repoId: string): boolean {
    return this.running.has(repoId);
  }

  /** Start the repo's `afterLand`, unless it has none. A land that arrives while a run is going
   * neither starts a second run beside it (two builds writing one dist at once) nor is dropped:
   * the run in flight may have read the checkout before the new commit reached it, so the repo is
   * marked for one more run when this one ends. One more, however many lands arrive meanwhile,
   * since that run reads the branch as it is then. */
  run(repoId: string): void {
    const repo = this.d.state.repo(repoId);
    const commands = repo?.config.afterLand ?? [];
    if (!repo || commands.length === 0) return;
    if (this.running.has(repoId)) {
      this.again.add(repoId);
      return;
    }
    this.running.add(repoId);
    const done = this.exec(repo, commands).finally(() => {
      this.running.delete(repoId);
      if (this.again.delete(repoId)) this.run(repoId);
    });
    fireAndForget(repo.id, done, "afterLand");
  }

  private async exec(repo: RepoInfo, commands: string[]): Promise<void> {
    await this.d.settled?.();
    if (this.d.self.building(true)) this.d.hub.emit("selfChanged");
    let failure: string | undefined;
    let notice: string | undefined;
    for (const command of commands) {
      this.tellMain(repo, `afterLand: ${command}`);
      let last = "";
      const code = await runSetup(command, repo.path, (line, retract) => {
        if (line) last = line;
        this.tellMain(repo, line, retract);
      });
      if (code === 0) continue;
      // the last line is almost always the error the command printed; the rest is in the main
      // row's log, which is where someone who wants the whole run goes
      const why = last.trim();
      failure = why === "" ? `${command} (exit ${code})` : why;
      notice = why === "" ? `After landing, ${command} exited ${code}` : `After landing, ${command} stopped: ${why}`;
      this.tellMain(repo, `afterLand stopped: ${command} exited ${code}`);
      log.warn(repo.id, `afterLand stopped: ${command} exited ${code}`);
      break;
    }
    // read before the self state settles: a clean finish clears it, and nothing more is owed
    const onNotice = this.d.self.reports(repo);
    if (this.d.self.building(false, failure)) this.d.hub.emit("selfChanged");
    if (notice !== undefined && !onNotice) {
      const main = this.mainOf(repo);
      if (main) this.d.hub.emit("failed", main.id, notice);
    }
  }

  /** a line in the main worktree's log pane, the one surface that belongs to the checkout itself */
  private tellMain(repo: RepoInfo, line: string, retract?: number): void {
    const main = this.mainOf(repo);
    if (main) this.d.hub.emit("log", main.id, "land", line, retract);
  }

  private mainOf(repo: RepoInfo) {
    return this.d.state.worktrees.find((w) => w.repoId === repo.id && w.kind === "main");
  }
}
