import type { RepoInfo } from "@toyon/shared";
import { useEffect, useState } from "react";
import { useSock } from "../../state/context.tsx";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Field, TextArea } from "../../ui/Field.tsx";
import { FormRow } from "../../ui/FormRow.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { tip } from "../../ui/Tooltip.tsx";

type Proc = { id: number; name: string; cmd: string };

/** rows are added and removed while the form is open, so each carries an identity of its own */
let nextProcId = 1;
const proc = (name: string, cmd: string): Proc => ({ id: nextProcId++, name, cmd });

/** shown in place of the preview while a repo's detected config is unconfirmed: nothing is
 * spawned for its worktrees until the person says how the project installs and starts */
export function SetupPane({ repo, onClose }: { repo: RepoInfo; onClose?: () => void }) {
  const sock = useSock();
  // reopened for a configured repo: esc leaves it, the way every other overlay does
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const [procs, setProcs] = useState<Proc[]>(() => {
    const detected = Object.entries(repo.config.procs).map(([name, cmd]) => proc(name, cmd));
    return detected.length > 0 ? detected : [proc("web", "")];
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
        // keys the pane does not edit (preview, profiles) survive a hand-written file
        ...repo.config,
        procs: Object.fromEntries(
          procs.filter((p) => p.name.trim() && p.cmd.trim()).map((p) => [p.name.trim(), p.cmd.trim()]),
        ),
        setup: install
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      },
    });
    onClose?.();
  };

  return (
    <div className="setup-pane">
      <h2>set up {repo.name}</h2>
      <p className="setup-lead">
        toyon runs every worktree of this repo side by side, each on its own port. Tell it how the project installs and
        starts; the answer is saved as <code>toyon.json</code>.
      </p>
      <p className="setup-lead setup-aside">
        {onClose
          ? "Saving restarts every worktree of this repo. Profiles and other keys in the file are kept."
          : "You can already edit, chat and commit here; this only powers the live preview."}
      </p>

      <FormRow label="install" hint="runs once in each new worktree; one command per line">
        <TextArea
          size="md"
          rows={Math.max(1, install.split("\n").length)}
          value={install}
          placeholder="bun install"
          onChange={(e) => setInstall(e.target.value)}
        />
      </FormRow>

      {procs.map((p, i) => (
        <div className="form-row" key={p.id}>
          <span className="form-label">{i === 0 ? "start" : ""}</span>
          <div className="form-control">
            <div className="setup-proc">
              {multi && (
                <Field
                  size="md"
                  className="setup-name"
                  value={p.name}
                  placeholder="name"
                  {...tip("Process name, shown in the status bar")}
                  onChange={(e) => edit(i, { name: e.target.value })}
                />
              )}
              <Field
                size="md"
                className="setup-cmd"
                value={p.cmd}
                placeholder="npm run dev"
                onChange={(e) => edit(i, { cmd: e.target.value })}
              />
              {multi && (
                <IconButton icon="close" label="Remove" onClick={() => setProcs(procs.filter((_, j) => j !== i))} />
              )}
            </div>
            {i === 0 && (
              <span className="hint">
                the server must listen on <code>$PORT</code>; toyon sets it differently for each worktree
              </span>
            )}
          </div>
        </div>
      ))}

      <div className="form-row">
        <span className="form-label" />
        <Button className="setup-add" onClick={() => setProcs([...procs, proc("", "")])}>
          + another process (an api, a worker…)
        </Button>
      </div>

      <div className="setup-actions">
        {onClose && <Button onClick={onClose}>cancel</Button>}
        <Button variant="outline" size="lg" disabled={!canStart} onClick={start}>
          {onClose ? "save + restart" : "start"} <Icon name="forward" className="icon-inline" />
        </Button>
      </div>
    </div>
  );
}
