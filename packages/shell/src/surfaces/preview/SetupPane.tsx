import type { RepoInfo } from "@toyon/shared";
import { useState } from "react";
import { useSock } from "../../state/context.tsx";
import { tip } from "../../ui/Tooltip.tsx";

type Proc = { name: string; cmd: string };

/** shown in place of the preview while a repo's detected config is unconfirmed: nothing is
 * spawned for its worktrees until the person says how the project installs and starts */
export function SetupPane({ repo }: { repo: RepoInfo }) {
  const sock = useSock();
  const [procs, setProcs] = useState<Proc[]>(() => {
    const detected = Object.entries(repo.config.procs).map(([name, cmd]) => ({ name, cmd }));
    return detected.length > 0 ? detected : [{ name: "web", cmd: "" }];
  });
  const [install, setInstall] = useState(() => (repo.config.setup ?? []).join("\n"));
  const multi = procs.length > 1;
  const canStart = procs.some((p) => p.name.trim() && p.cmd.trim());

  const edit = (i: number, patch: Partial<Proc>) => setProcs(procs.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const start = () => {
    sock?.send({
      t: "confirm-config",
      repoId: repo.id,
      config: {
        procs: Object.fromEntries(
          procs.filter((p) => p.name.trim() && p.cmd.trim()).map((p) => [p.name.trim(), p.cmd.trim()]),
        ),
        setup: install
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      },
    });
  };

  return (
    <div className="setup-pane">
      <h2>set up {repo.name}</h2>
      <p className="setup-lead">
        toyon runs every worktree of this repo side by side, each on its own port. Tell it how the project installs and
        starts; the answer is saved as <code>toyon.json</code>.
      </p>

      <label className="setup-row">
        <span className="setup-label">install</span>
        <div className="setup-control">
          <textarea
            className="field"
            rows={Math.max(1, install.split("\n").length)}
            value={install}
            placeholder="bun install"
            onChange={(e) => setInstall(e.target.value)}
          />
          <span className="setup-hint">runs once in each new worktree; one command per line</span>
        </div>
      </label>

      {procs.map((p, i) => (
        <div className="setup-row" key={i}>
          <span className="setup-label">{i === 0 ? "start" : ""}</span>
          <div className="setup-control">
            <div className="setup-proc">
              {multi && (
                <input
                  className="field setup-name"
                  value={p.name}
                  placeholder="name"
                  {...tip("Process name, shown in the status bar")}
                  onChange={(e) => edit(i, { name: e.target.value })}
                />
              )}
              <input
                className="field setup-cmd"
                value={p.cmd}
                placeholder="npm run dev"
                onChange={(e) => edit(i, { cmd: e.target.value })}
              />
              {multi && (
                <button
                  className="btn btn-icon"
                  {...tip("Remove")}
                  onClick={() => setProcs(procs.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </div>
            {i === 0 && (
              <span className="setup-hint">
                the server must listen on <code>$PORT</code>; toyon sets it differently for each worktree
              </span>
            )}
          </div>
        </div>
      ))}

      <div className="setup-row">
        <span className="setup-label" />
        <button className="btn setup-add" onClick={() => setProcs([...procs, { name: "", cmd: "" }])}>
          + another process (an api, a worker…)
        </button>
      </div>

      <div className="setup-actions">
        <button className="btn btn-outline setup-start" disabled={!canStart} onClick={start}>
          start ▸
        </button>
      </div>
    </div>
  );
}
