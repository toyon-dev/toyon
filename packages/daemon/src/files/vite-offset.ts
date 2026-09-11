import type { ProxyTarget } from "../runtime/proxy.ts";
import { resolveInside } from "../worktrees/paths.ts";

/** Some Vite/plugin-react pipelines compute JSX source lines AFTER prepending the refresh
 * preamble, so fiber lineNumbers = file line + constant K. Derive K by anchoring one distinctive
 * JSX text literal from disk against the `lineNumber:` in its served jsxDEV call. 0 when
 * underivable or when the preview server is not running. */
export async function viteLineOffset(worktreePath: string, path: string, target: ProxyTarget | null): Promise<number> {
  if (!target) return 0;
  try {
    const host = target.host.includes(":") ? `[${target.host}]` : target.host;
    const res = await fetch(`http://${host}:${target.port}/${path}`, {
      signal: AbortSignal.timeout(1500),
      headers: { accept: "*/*" },
    });
    if (!res.ok) return 0;
    const served = await res.text();
    const disk = (await Bun.file(resolveInside(worktreePath, path)).text()).split("\n");
    for (let i = 0; i < disk.length; i++) {
      const m = disk[i]!.match(/>([^<>{}\n]{6,60})</);
      const anchor = m?.[1]?.trim();
      if (!anchor || anchor.length < 6) continue;
      const at = served.indexOf(JSON.stringify(anchor).slice(1, -1));
      if (at < 0) continue;
      const ln = served.slice(at, at + 400).match(/lineNumber:\s*(\d+)/);
      if (!ln) continue;
      return Number(ln[1]) - (i + 1);
    }
    return 0;
  } catch {
    return 0;
  }
}
