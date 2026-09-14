import {
  type ConfigFileKind,
  configFileKind,
  configSibling,
  DEFAULT_LAND_ROUTE,
  DEFAULT_MERGE_METHOD,
  isOwned,
  LAND_ROUTES,
  type LandRoute,
  landPolicy,
  MERGE_METHODS,
  type MergeMethod,
  PR_MERGERS,
  type RepoInfo,
} from "@toyon/shared";
import { useEffect, useState } from "react";
import { useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { openSource } from "../../state/openSource.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import { Field, TextArea } from "../../ui/Field.tsx";
import { FormRow } from "../../ui/FormRow.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { View } from "../../ui/View.tsx";
import { setupFixPrompt } from "./fixPrompt.ts";

type Proc = { id: number; name: string; cmd: string };

/** rows are added and removed while the form is open, so each carries an identity of its own */
let nextProcId = 1;
const proc = (name: string, cmd: string): Proc => ({ id: nextProcId++, name, cmd });

/** committed or kept local: the one setup answer that is about the file rather than the project.
 * Said as the outcome, since the file names alone (settings.json, settings.local.json) do not say
 * which of them git will list. */
const FILE_KINDS: { id: ConfigFileKind; label: string; description: string }[] = [
  { id: "shared", label: "committed", description: "in the repo; everyone who opens it gets these settings" },
  { id: "local", label: "kept local", description: "in a file git never sees; for when only you use Toyon here" },
];

/** shown in place of the preview while a repo's detected config is unconfirmed: nothing is
 * spawned for its worktrees until the person says how the project installs and starts.
 *
 * One line and a card, the shape the greenfield pane before it and the settings card after it
 * both take. The detector has usually filled the form already, so the pane's job is to show the
 * guess and make the next move the only thing drawn as a button: `start` when there is something
 * to start, and the agent when the detector found nothing and nothing has been typed yet. */
export function Setup({ repo, onClose }: { repo: RepoInfo; onClose?: () => void }) {
  const sock = useSock();
  const store = useStoreInstance();
  // the repo's main worktree is where the agent writes the settings: the daemon watches that copy
  const main = useStore(
    (s) => s.rows.find((r) => isOwned(r) && r.repoId === repo.id && r.worktree.kind === "main") ?? null,
  );
  // reopened for a configured repo: esc leaves it, the way every other overlay does
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // read once: the form remounts on a fresh guess (see Center), so mount is the guess
  const [guessed] = useState(() => Object.keys(repo.config.run).length > 0);
  const [procs, setProcs] = useState<Proc[]>(() => {
    const detected = Object.entries(repo.config.run).map(([name, cmd]) => proc(name, cmd));
    return detected.length > 0 ? detected : [proc("web", "")];
  });
  const [install, setInstall] = useState(() => (repo.config.setup ?? []).join("\n"));
  const [check, setCheck] = useState(() => repo.config.check ?? "");
  // how work lands: the route only matters with somewhere to push, the method always
  const [land, setLand] = useState<LandRoute>(() => landPolicy(repo.config).land);
  const [automerge, setAutomerge] = useState(() => landPolicy(repo.config).automerge);
  const [merge, setMerge] = useState<MergeMethod | "default">(() => landPolicy(repo.config).merge ?? "default");
  // which file of the pair the save writes. The daemon's default is already in `configFile`:
  // the file that is there, else committed in a project toyon made and local in one that was
  // opened, where a team that does not use toyon should never find a file it did not ask for.
  const [kind, setKind] = useState<ConfigFileKind>(() => configFileKind(repo.configFile));
  const file = configSibling(repo.configFile, kind);
  // the route row is only drawn with an origin, so without one the PR route is never in force
  const onPr = !!repo.remote && land === "pr";
  const multi = procs.length > 1;
  const canStart = procs.some((p) => p.name.trim() && p.cmd.trim());
  // the agent's button exists for a repo the detector could not read; it leads while the form is
  // still empty, and steps back to a ghost the moment there is something to start
  const askable = !!main && !onClose && !guessed;
  const agentLeads = askable && !canStart;

  const edit = (i: number, patch: Partial<Proc>) => setProcs(procs.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const setupLines = () =>
    install
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  // keys the pane does not edit (preview, profiles) survive a hand-written file; a value at its
  // default leaves the file rather than being written out, so the file stays as short as it was
  const edited = (): typeof repo.config => {
    const { check: _check, land: _land, ...rest } = repo.config;
    const route = repo.remote ? land : DEFAULT_LAND_ROUTE;
    // a merge commit is what a local route does unset, so picking it writes nothing; on the PR
    // route unset means the repo's allowed methods, so any pick there is written
    const method = merge === "default" || (route !== "pr" && merge === DEFAULT_MERGE_METHOD) ? undefined : merge;
    const landing = {
      ...(route !== DEFAULT_LAND_ROUTE ? { route } : {}),
      ...(route === "pr" && automerge ? { automerge: true } : {}),
      ...(method ? { method } : {}),
    };
    return {
      ...rest,
      setup: setupLines(),
      ...(check.trim() ? { check: check.trim() } : {}),
      ...(Object.keys(landing).length > 0 ? { land: landing } : {}),
    };
  };
  const start = () => {
    sock?.send({
      t: "confirm-config",
      repoId: repo.id,
      config: {
        ...edited(),
        run: Object.fromEntries(
          procs.filter((p) => p.name.trim() && p.cmd.trim()).map((p) => [p.name.trim(), p.cmd.trim()]),
        ),
      },
      kind,
    });
    onClose?.();
  };
  // a library, a CLI, a backend with no HTTP server: nothing to preview, everything else works.
  // Confirmed with no procs so the pane stops asking and the worktrees get their agents.
  const nothingToRun = () => {
    sock?.send({ t: "confirm-config", repoId: repo.id, config: { ...edited(), run: {} }, kind });
    onClose?.();
  };
  const askAgent = () => main && sock?.send({ t: "chat", worktreeId: main.id, text: setupFixPrompt(repo, file) });

  const procRow = (p: Proc, i: number) => (
    <div className="setup-proc" key={p.id}>
      {multi && (
        <Field
          size="md"
          rule
          className="setup-name"
          value={p.name}
          placeholder="name"
          {...tip("Process name, shown in the status bar")}
          onChange={(e) => edit(i, { name: e.target.value })}
        />
      )}
      <Field
        size="md"
        rule
        className="setup-cmd"
        value={p.cmd}
        placeholder="npm run dev"
        onChange={(e) => edit(i, { cmd: e.target.value })}
      />
      {multi && <IconButton icon="close" label="Remove" onClick={() => setProcs(procs.filter((_, j) => j !== i))} />}
    </div>
  );

  return (
    <View>
      <p className="form-title">how does {repo.name} start?</p>
      <FormRow label="install" hint="once per new worktree; one command per line">
        <TextArea
          size="md"
          rule
          rows={Math.max(1, install.split("\n").length)}
          value={install}
          placeholder="bun install"
          onChange={(e) => setInstall(e.target.value)}
        />
      </FormRow>

      <FormRow label="check" hint="runs after each of the agent's turns; the work lands only when it passes">
        <Field size="md" rule value={check} placeholder="bun run check" onChange={(e) => setCheck(e.target.value)} />
      </FormRow>

      {/* one route per repo: the land word everywhere does this. Without an origin there is only
          landing here, so the row would be a choice of one. On the PR route a second chip says who
          presses merge: a value with two states, so a chip like its neighbours and not a switch. */}
      {repo.remote && (
        <FormRow label="land" hint="where a worktree's finished work goes; one way per repo">
          <div className="setup-land">
            <ChipPicker<LandRoute>
              value={land}
              options={LAND_ROUTES.map((r) => ({ id: r.id, label: r.name, description: r.description }))}
              onChange={setLand}
              hint="where the work goes"
              placeholder="where work lands"
            />
            {onPr && (
              <ChipPicker<"you" | "github">
                value={automerge ? "github" : "you"}
                options={PR_MERGERS.map((m) => ({ id: m.id, label: m.name, description: m.description }))}
                onChange={(id) => setAutomerge(id === "github")}
                hint="who merges the pull request"
                placeholder="who merges it"
              />
            )}
          </div>
        </FormRow>
      )}

      {/* unset shows as what it does: a merge commit here. On GitHub unset follows the repo's own
          allowed methods, which is none of the three, so there it is a row of its own. */}
      <FormRow
        label="merge"
        hint={onPr ? "how GitHub merges the pull request; only what the repo allows" : "how the commits arrive on main"}
      >
        <ChipPicker<MergeMethod | "default">
          value={merge === "default" && !onPr ? DEFAULT_MERGE_METHOD : merge}
          options={[
            ...(onPr
              ? [
                  {
                    id: "default" as const,
                    label: "what the repo allows",
                    description: "the repo's allowed methods on GitHub: squash, else a merge commit, else rebase",
                  },
                ]
              : []),
            ...MERGE_METHODS.map((m) => ({ id: m.id, label: m.name, description: m.description })),
          ]}
          onChange={setMerge}
          hint="how the commits arrive on main"
          placeholder="how the commits arrive"
        />
      </FormRow>

      <FormRow
        label="start"
        hint={
          <>
            must listen on <code {...tip("Toyon sets a different port for each worktree")}>$PORT</code>
            {/* where the guess came from, and the way to it: the file opens in the editor pane
                  under this card, so the script the person meant is a copy and a paste away */}
            {repo.guess && main && (
              <>
                {" · from "}
                <Button
                  mono
                  tone="quiet"
                  {...tip(`open ${repo.guess} in the editor pane`)}
                  onClick={() => openSource(store, sock, main.id, repo.guess ?? "", 1)}
                >
                  {repo.guess}
                </Button>
              </>
            )}
          </>
        }
      >
        {/* never empty: a row is only removable while there are two, so the guard is for the type */}
        {procs[0] && procRow(procs[0], 0)}
      </FormRow>
      {procs.slice(1).map((p, i) => (
        <div className="form-row" key={p.id}>
          <span className="form-label" />
          <div className="form-control">{procRow(p, i + 1)}</div>
        </div>
      ))}
      <div className="form-row">
        <span className="form-label" />
        <Button tone="quiet" onClick={() => setProcs([...procs, proc("", "")])}>
          <Icon name="plus" className="icon-inline" /> another process
        </Button>
      </div>

      <div className="form-knobs">
        {/* the file the button writes, the way the new-project form shows the folder it makes;
              the repo is named in the lead, so the path is only the file. The chip before it is
              the one choice about that file, and the name after it is what the choice comes to,
              so the two read as one phrase: "kept local, .toyon/settings.local.json" */}
        <ChipPicker<ConfigFileKind>
          value={kind}
          options={FILE_KINDS}
          onChange={setKind}
          hint="whether the settings file is committed with the repo or kept out of git"
          placeholder="committed or kept local"
        />
        <span className="form-sign">{file}</span>
        {onClose && <Button onClick={onClose}>cancel</Button>}
        {/* the third answer, only where it is one: beside a guessed start command it read as a
              verdict on the repo. A repo the detector could not read gets it, and so does the
              reopened pane, which is where a preview is turned off. */}
        {(!guessed || onClose) && (
          <Button
            {...tip("This project has no dev server: chat, changes and the terminal work, the preview stays empty")}
            onClick={nothingToRun}
          >
            no dev server
          </Button>
        )}
        {/* one primary, and it is the one that fits the form: the agent while the form is blank,
              start once there is a command in it. A swap rather than a third ghost, since a
              disabled start beside the agent was a button with nothing to say. */}
        {agentLeads && main ? (
          <Button
            variant="outline"
            size="lg"
            disabled={main.agent !== "idle"}
            {...tip(
              "The agent reads the repo and writes the settings file; the daemon picks it up as soon as it lands",
            )}
            onClick={askAgent}
          >
            let the agent work it out
          </Button>
        ) : (
          <Button
            variant="outline"
            size="lg"
            disabled={!canStart}
            {...(onClose
              ? tip("Restarts every worktree of this repo. Profiles and other keys in the file are kept.")
              : {})}
            onClick={start}
          >
            {onClose ? "save + restart" : "start"} <Icon name="forward" className="icon-inline" />
          </Button>
        )}
      </div>
    </View>
  );
}
