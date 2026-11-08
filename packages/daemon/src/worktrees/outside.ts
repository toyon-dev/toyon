// A message from outside the shell: `toyon send` in a terminal, by the person or by the agent
// they are running there. The directory decides which row the message is for, the way the box
// the person types into does in the shell: the project's main checkout starts a worktree, a
// worktree git made that Toyon does not run is taken over with it as its first message, and a
// worktree Toyon runs gets it in its chat. A project not opened yet is registered first, as
// `toyon <path>` registers one. The text is the person's message; one paragraph behind it says
// where it was sent from, and who was at the keyboard when the terminal says so.

import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { SendReply, SendRequest, WorktreeInfo } from "@toyon/shared";
import { canonical } from "../agent/bounds.ts";
import { sentFromLine } from "../agent/prompt.ts";
import { UserError } from "../core/errors.ts";
import type { StateStore } from "../core/state.ts";
import type { OpenRow } from "../files/open.ts";
import { git, isGitRepo, repoRoot } from "../git/exec.ts";
import { statusFiles } from "../git/status.ts";
import { expandTilde } from "../repos/browse.ts";
import { discoveredId } from "./discover.ts";
import type { CreateOpts, RestoreMessage } from "./service.ts";

export class OutsideSend {
  constructor(
    private d: {
      state: Pick<StateStore, "worktrees" | "requireRepo">;
      /** a directory that is a git repo, as `/register` takes one: the repo it already is, or one made */
      register: (path: string) => Promise<{ id: string }>;
      worktrees: {
        create: (repoId: string, prompt: string, opts: CreateOpts) => Promise<WorktreeInfo>;
        adopt: (worktreeId: string, createdBy?: string, message?: RestoreMessage) => Promise<WorktreeInfo>;
        send: (worktreeId: string, msg: { text: string; context?: string[] }) => Promise<void>;
        discovered: () => Promise<{ id: string }[]>;
        invalidateDiscovered: () => void;
      };
      /** tell the shells a row is the one to look at; whether one did */
      tell: (opened: OpenRow) => boolean;
    },
  ) {}

  async send(req: SendRequest): Promise<SendReply> {
    const text = req.text.trim();
    if (!text) throw new UserError("the message is empty");
    const { path, top, mainPath } = await this.locate(req.path);
    // the directory the person was standing in, not the checkout's root: which package they were
    // in is the one thing the root does not say
    const context = [sentFromLine(path, req.by)];
    const known = this.d.state.worktrees.find((w) => canonical(w.path) === top);
    if (known) {
      if (known.kind === "main") return this.start(known.repoId, text, context, req.carry === true);
      // a spare has no chat: it is the row the person's next message in the shell becomes
      if (known.kind === "spare") throw new UserError("nothing is working in that directory yet");
      await this.d.worktrees.send(known.id, { text, context });
      return this.reply("sent", known);
    }
    const repo = await this.d.register(mainPath);
    if (top === mainPath) return this.start(repo.id, text, context, req.carry === true);
    // registered a moment ago, or listed before this directory was made: read git's list again
    this.d.worktrees.invalidateDiscovered();
    const found = (await this.d.worktrees.discovered()).find((r) => r.id === discoveredId(top));
    if (!found) throw new UserError(`${req.path} is not a worktree of ${mainPath} that Toyon can take over`);
    const wt = await this.d.worktrees.adopt(found.id, undefined, { text, context });
    return this.reply("worktree", wt);
  }

  /** The directory itself, its working tree's root, and its repository's main checkout: the same
   * as the root for the checkout itself, and for a linked worktree the directory its `.git`
   * points back to. A bare repository has no tree to send to, and a submodule's tree belongs to
   * its superproject, which is the project to open. */
  private async locate(raw: string): Promise<{ path: string; top: string; mainPath: string }> {
    const path = canonical(resolve(expandTilde(raw)));
    const st = await stat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!st?.isDirectory()) throw new UserError(`${raw} is not a directory`);
    const bare = await git(path, "rev-parse", "--is-bare-repository");
    if (bare.ok && bare.out === "true")
      throw new UserError(`${raw} is a bare repository, which has no working tree to send to`);
    if (!(await isGitRepo(path))) throw new UserError(`${raw} is not inside a git repository`);
    const over = await git(path, "rev-parse", "--show-superproject-working-tree");
    if (over.ok && over.out) throw new UserError(`${raw} is a submodule of ${over.out}: send from there`);
    const top = canonical(await repoRoot(path));
    const common = await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const gitDir = common.ok && common.out ? canonical(common.out) : null;
    // a repository kept apart from its checkout (GIT_DIR) has no main checkout to find beside it
    if (!gitDir || basename(gitDir) !== ".git")
      throw new UserError(`${raw} keeps its repository apart from its checkout`);
    return { path, top, mainPath: dirname(gitDir) };
  }

  /** A worktree started for the project, as the box on main starts one: the namer titles it from
   * the text, and no spare is claimed, since that row is the one a draft in the shell sits on. A
   * carry that would not apply leaves the row started and the message queued, with the changes
   * back on main; the terminal reads that beside the row's line rather than as a failed send. */
  private async start(repoId: string, text: string, context: string[], carry: boolean): Promise<SendReply> {
    const repo = this.d.state.requireRepo(repoId);
    const stayed = carry ? 0 : (await statusFiles(repo.path)).length;
    const before = new Set(this.d.state.worktrees.map((w) => w.id));
    let wt: WorktreeInfo;
    let notice: string | undefined;
    try {
      wt = await this.d.worktrees.create(repoId, text, { context, cold: true, ...(carry ? { carry } : {}) });
    } catch (e) {
      if (!(e instanceof UserError && e.delivered)) throw e;
      // the row is listed and its message sent before the create says what became of the carry
      const made = this.d.state.worktrees.find(
        (w) => w.repoId === repoId && w.kind === "worktree" && !before.has(w.id),
      );
      if (!made) throw e;
      wt = made;
      notice = e.message;
    }
    return { ...this.reply("worktree", wt), ...(stayed > 0 ? { stayed } : {}), ...(notice ? { notice } : {}) };
  }

  private reply(kind: SendReply["kind"], wt: WorktreeInfo): SendReply {
    return {
      kind,
      worktreeId: wt.id,
      title: wt.title,
      delivered: this.d.tell({ kind: "worktree", worktreeId: wt.id }),
    };
  }
}
