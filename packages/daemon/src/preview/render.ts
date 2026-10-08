// Toyon's `preview` tool: the agent asks whether a page of its worktree's preview renders without
// throwing, and a browser the person has open answers. The daemon has no browser of its own and
// starts none: the tab that shows the worktree loads the page in a hidden frame beside the one
// on screen, through the same proxy and with the same bridge, waits out the moment after load, and
// reports what the page threw. The call waits on that tab for a few seconds at most, which sits
// under the agent's own ceiling on a tool call; it never waits on a person, and with no tab to ask
// it answers at once with what the page has thrown since it last loaded, which it can also be
// asked for on its own.

import { randomUUID } from "node:crypto";
import type { ServerMsg } from "@toyon/shared";
import { PREVIEW_TOOL } from "@toyon/shared";
import type { McpTool, McpToolResult, ToolProvider } from "../agent/mcp.ts";
import { previewContext } from "../agent/prompt.ts";
import { log } from "../core/log.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import type { PageErrorService } from "./errors.ts";

export interface RenderDeps {
  runtime: Pick<RuntimeRegistry, "previewStanding">;
  pageErrors: Pick<PageErrorService, "recent">;
  /** how long a tab has to load the page and report before the call answers without it */
  waitMs?: number;
}

/** a tab's answer to a `render`, as the client message carries it */
export interface Rendered {
  worktreeId: string;
  id: string;
  ok: boolean;
  reason?: string;
  url?: string;
  title?: string;
  errors: string[];
}

export type RenderRequest = Extract<ServerMsg, { t: "render" }>;

/** the wait on the tab: a page load, the settle after it, and the socket both ways */
const WAIT_MS = 10_000;
const PATH_MAX = 2048;

const refused = (text: string): McpToolResult => ({ text, isError: true });

export class RenderService implements ToolProvider {
  /** How a request reaches a tab showing the worktree: the socket layer sets it once it listens,
   * picking the tab that shows the worktree, else one that has it open; false when no tab does. */
  courier: (worktreeId: string, msg: RenderRequest) => boolean = () => false;
  private pending = new Map<string, { worktreeId: string; settle: (r: Rendered) => void }>();
  /** one render per worktree at a time: a second would race the first for the same hidden frame */
  private out = new Set<string>();

  constructor(private d: RenderDeps) {}

  tool(): McpTool {
    return {
      name: PREVIEW_TOOL,
      description:
        "See whether a page of this worktree's preview renders without throwing. Pass `path` (for example `/about`): a browser the user has open loads it beside what they are looking at and reports the uncaught errors and unhandled rejections it threw in the moment after load. With no path, reports what the preview has thrown since it last loaded, without rendering. It does not describe what the page looks like, and it is not a substitute for the user's own checks.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "the route to render, starting with `/`; absent to report without rendering",
          },
        },
        additionalProperties: false,
      },
    };
  }

  async call(worktreeId: string, args: unknown): Promise<McpToolResult> {
    const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    if (a.path !== undefined && typeof a.path !== "string")
      return refused("`path` is a string: a route, like `/about`.");
    const path = a.path?.trim();
    // a route of the preview and nothing else: `//host` and `/\host` resolve to another origin
    if (path !== undefined && (!/^(?:\/(?![/\\])|[?#])/.test(path) || path.length > PATH_MAX)) {
      return refused("`path` is a route of the preview, starting with `/`, like `/about`.");
    }
    const standing = this.d.runtime.previewStanding(worktreeId);
    if (!standing) return refused("This project has nothing to run, so there is no page to render.");
    if (standing.status !== "running") return refused(previewContext(standing) ?? "The preview is not running.");
    if (path === undefined) return { text: this.held(worktreeId) };
    if (this.out.has(worktreeId)) return refused("A render is already under way; call again when it has returned.");
    const result = await this.render(worktreeId, path);
    if (!result)
      return refused(`No browser has this worktree open right now, so nothing can render it. ${this.held(worktreeId)}`);
    if (!result.ok) return refused(`Could not render ${path}: ${result.reason ?? "the page did not report"}.`);
    return { text: this.report(path, result) };
  }

  /** the tab's answer, or null when no tab could be asked */
  private render(worktreeId: string, path: string): Promise<Rendered | null> {
    const id = randomUUID();
    return new Promise<Rendered | null>((resolve) => {
      const wait = this.d.waitMs ?? WAIT_MS;
      const timer = setTimeout(
        () =>
          settle({
            worktreeId,
            id,
            ok: false,
            reason: `the page did not report within ${Math.round(wait / 1000)}s`,
            errors: [],
          }),
        wait,
      );
      const settle = (r: Rendered | null) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        this.out.delete(worktreeId);
        resolve(r);
      };
      this.pending.set(id, { worktreeId, settle });
      this.out.add(worktreeId);
      if (!this.courier(worktreeId, { t: "render", worktreeId, id, path })) settle(null);
    });
  }

  /** a tab's answer; one for no render out (a tab answering after the wait) is dropped */
  rendered(msg: Rendered): void {
    const p = this.pending.get(msg.id);
    if (!p || p.worktreeId !== msg.worktreeId) {
      log.debug("render", `an answer for no render out on ${msg.worktreeId} was dropped`);
      return;
    }
    p.settle(msg);
  }

  private held(worktreeId: string): string {
    const errors = this.d.pageErrors.recent(worktreeId);
    if (errors.length === 0) return "The preview has thrown nothing since it last loaded.";
    return `The preview has thrown since it last loaded:\n${errors.map((e) => `- ${e}`).join("\n")}`;
  }

  private report(path: string, r: Rendered): string {
    const title = r.title ? ` (title "${r.title}")` : "";
    const landed = r.url ? pathOf(r.url) : null;
    const elsewhere = landed && landed !== path ? ` It landed on ${landed}.` : "";
    const head = `Rendered ${path} in the user's browser${title}.${elsewhere}`;
    if (r.errors.length === 0) return `${head} No errors in the moment after load.`;
    const n = r.errors.length;
    return `${head} ${n} ${n === 1 ? "error" : "errors"} in the moment after load:\n${r.errors.map((e) => `- ${e}`).join("\n")}`;
  }
}

/** a page's address as its route: the path with its query, the origin dropped */
function pathOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}
