import type { RepoInfo } from "@orchardist/shared";
import { useState } from "react";
import { useSock } from "../../state/context.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { tip } from "../../ui/Tooltip.tsx";

/** first run for a repo: confirm the detected processes and setup before anything is spawned */
export function ConfigCard({ repo }: { repo: RepoInfo }) {
  const sock = useSock();
  const [procs, setProcs] = useState<Array<{ name: string; cmd: string }>>(() =>
    Object.entries(repo.config.procs).map(([name, cmd]) => ({ name, cmd })),
  );
  const [setup, setSetup] = useState(() => (repo.config.setup ?? []).join("\n"));
  const [exclusive, setExclusive] = useState(repo.config.exclusive ?? false);

  const start = () => {
    const config = {
      procs: Object.fromEntries(
        procs.filter((p) => p.name.trim() && p.cmd.trim()).map((p) => [p.name.trim(), p.cmd.trim()]),
      ),
      setup: setup
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      ...(exclusive ? { exclusive: true } : {}),
    };
    sock?.send({ t: "confirm-config", repoId: repo.id, config });
  };

  return (
    <Overlay boxClass="config-card">
      <div className="title">
        first run for <b>{repo.name}</b> — confirm how it runs. Each command must listen on <code>$PORT</code>.
      </div>
      <div className="cfg-section">processes</div>
      {procs.map((p, i) => (
        <div className="cfg-proc" key={i}>
          <input
            className="field cfg-name"
            value={p.name}
            placeholder="name"
            onChange={(e) => setProcs(procs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
          />
          <input
            className="field cfg-cmd"
            value={p.cmd}
            placeholder="bun run dev · uvicorn main:app --reload --port $PORT · ./start.sh"
            onChange={(e) => setProcs(procs.map((x, j) => (j === i ? { ...x, cmd: e.target.value } : x)))}
          />
          <button {...tip("Remove")} onClick={() => setProcs(procs.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="new-wt" onClick={() => setProcs([...procs, { name: "", cmd: "" }])}>
        + add process
      </button>
      <div className="cfg-section">setup (run once per new worktree)</div>
      <textarea
        className="field cfg-setup"
        value={setup}
        onChange={(e) => setSetup(e.target.value)}
        placeholder={"bun install\ncp ../../.env .env"}
      />
      <label
        className="cfg-exclusive"
        data-tip="For apps that can't take $PORT: only the focused worktree's processes run"
      >
        <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} />
        <span>exclusive — commands can't honor $PORT, run only the focused worktree</span>
      </label>
      <div className="cfg-actions">
        <span className="cfg-note">saved to orchardist.json in the repo</span>
        <button
          className="btn btn-outline ship-btn"
          disabled={procs.every((p) => !p.name.trim() || !p.cmd.trim())}
          onClick={start}
        >
          start ▸
        </button>
      </div>
    </Overlay>
  );
}
