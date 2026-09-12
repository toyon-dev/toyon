import type { ModelChoice } from "@toyon/shared";
import { projectNameError } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { NewProject } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Field, TextArea } from "../../ui/Field.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { EffortChip, useNewWorktreeEffort } from "../chips/EffortChip.tsx";
import { AgentModelChip, ModelChip, rememberNewWorktreeModel, useNewWorktreeModel } from "../chips/ModelChip.tsx";
import { destination, expandHome, folderName, splitTypedPath } from "../palettes/projectPicker.ts";

/** how long the name sits still before the page asks whether a folder by that name is already there */
const ASK_AFTER_MS = 150;

/** enough of an email for git to label work with; git itself checks nothing */
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** the name is sized to what is in it, with room to start typing in: a title with its folder beside
 * it, rather than a field stretched across the page with the folder pushed to the far edge */
const NAME_MIN = 14;

const NO_CHOICES: ModelChoice[] = [];

/**
 * The new project, as one page in the centre: a title, where it goes, and the description that
 * starts it. Written rather than filled in, which is why there is no heading, no labels and no
 * boxes: the placeholder says what the title is for, the line under it says where the folder lands,
 * and create makes the project and sends the description as its first message.
 *
 * Nothing is made until create. Making one takes about a tenth of a second, so making it while the
 * name is still being typed would buy nothing anyone could feel and would leave a folder behind for
 * every name that was thought better of.
 *
 * The location is read as the folder's own name, with the path on hover and the folder button beside
 * it, so nobody has to know how to write a path. Where the daemon can open Finder in front of the
 * person, what comes back decides the rest: an ordinary folder is the location, an empty one becomes
 * the project itself, and one that is already a project is offered for opening. Git's name and email
 * sit above the title when git has none, since they are asked once ever and are not what this page
 * is about. The quiet line at the bottom is for someone who came here with a project already.
 */
export function NewProjectPane({ page }: { page: NewProject }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const repos = useStore((s) => s.repos);
  const home = useStore((s) => s.home);
  const canAskFinder = useStore((s) => s.folderDialog);
  const knowsIdentity = useStore((s) => s.gitIdentity);
  const asking = useStore((s) => s.choosingFolder);
  const chosen = useStore((s) => s.chosenFolder);
  const paths = useStore((s) => s.paths);
  const agents = useStore((s) => s.agents);
  const defaultAgent = useStore((s) => s.defaultAgent);
  const [identity, setIdentity] = useState({ name: "", email: "" });
  /** a folder picked as the location that is already a project */
  const [existing, setExisting] = useState<string | null>(null);
  /** why a folder picked to open was not opened */
  const [refusal, setRefusal] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const describeRef = useRef<HTMLTextAreaElement>(null);

  const { mode, name, parent, prompt } = page;
  const clone = mode === "clone";
  const inPlace = mode === "init";
  const editing = page.phase === "editing";
  const typed = name.trim();
  // a folder made the project where it stands keeps the name it already has, spaces and all; an empty
  // field is where the page starts, not a mistake to flag
  const nameError = inPlace || !typed ? null : projectNameError(name);
  const dest = !inPlace && typed && !nameError ? destination(parent, typed) : null;
  const where = folderName(parent, home);
  const taken = dest !== null && paths.query === dest && paths.target?.exists === true;
  // a clone brings its own commits, so only a create or an init needs git to know who is making it
  const askIdentity = !knowsIdentity && !clone;
  const identityOk = !askIdentity || (identity.name.trim() !== "" && EMAIL.test(identity.email.trim()));
  const ready = editing && !existing && (inPlace || (typed !== "" && !nameError && !taken)) && identityOk;

  // the chips choose for a project that does not exist yet, so they write where a new worktree's
  // choices are remembered; the composer of the project this makes reads the same memory back
  const agentInfo = agents.find((a) => a.id === defaultAgent);
  const [model, setModel] = useNewWorktreeModel(defaultAgent);
  const [effort, setEffort] = useNewWorktreeEffort(defaultAgent);
  const pickAgentModel = (agent: string, picked: string) => {
    if (agent === defaultAgent) {
      setModel(picked);
      return;
    }
    // the same fast path main's composer takes: the agent picked here is the daemon's default, and
    // the project made in a moment starts on it
    rememberNewWorktreeModel(agent, picked);
    sock?.send({ t: "set-default-agent", agent });
  };

  // whether a folder by that name is already there, asked once the name stops changing
  useEffect(() => {
    if (!dest) return;
    const timer = setTimeout(() => sock?.send({ t: "browse-path", path: dest }), ASK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [dest, sock]);

  // back from a refused create, or from the first-run screen: the keyboard goes back to the name
  useOnChange([page.phase], () => {
    if (page.phase === "editing") nameRef.current?.focus();
  });

  // a refusal is about the folder that was picked, so anything that changes what the page holds ends it
  useOnChange([mode, name, parent], () => setRefusal(null));

  const submit = () => {
    if (!ready) return;
    // pendingOpen is what makes this tab, and only this tab, adopt the project the daemon adds; the
    // description rides on the page and goes from the new project's own box (see settlePage)
    dispatch({ a: "open-repo" });
    dispatch({ a: "new-project-set", v: { phase: "creating" } });
    sock?.send({
      t: "create-repo",
      mode,
      parent: parent.trim(),
      name: typed,
      ...(clone && page.url ? { url: page.url } : {}),
      ...(askIdentity ? { identity: { name: identity.name.trim(), email: identity.email.trim() } } : {}),
    });
  };

  const openFolder = (path: string) => {
    // registering a project the daemon already has adds nothing, so nothing would switch to it
    const known = repos.find((r) => r.path === expandHome(path, home));
    if (known) {
      dispatch({ a: "activate-repo", id: known.id });
      return;
    }
    dispatch({ a: "open-repo" });
    sock?.send({ t: "register-repo", path });
  };

  const choose = (purpose: "location" | "open") => {
    setRefusal(null);
    if (canAskFinder) {
      dispatch({ a: "choosing-folder", v: purpose });
      sock?.send({ t: "choose-folder", start: parent, purpose });
    } else if (purpose === "location") {
      dispatch({ a: "open", overlay: { kind: "choose-folder" } });
    } else {
      dispatch({ a: "open", overlay: { kind: "projects", form: "disk" } });
    }
  };

  // The answer arrives as a store change, and only the control that asked acts on it. The flag is
  // cleared here rather than by the answer: cleared first, this would read it as not asked.
  useOnChange([chosen?.seq], () => {
    if (!asking || !chosen) return;
    dispatch({ a: "choosing-folder", v: false });
    const picked = chosen.folder;
    // the dialog had the keyboard, and the name is where it goes back to
    if (!picked) {
      nameRef.current?.focus();
      return;
    }
    if (asking === "open" && picked.kind === "project") {
      openFolder(picked.path);
      return;
    }
    if (asking === "open" && picked.kind === "folder") {
      setRefusal("that folder has files but is not a project yet; choose a project, or an empty folder to start one");
      return;
    }
    setExisting(picked.kind === "project" ? picked.path : null);
    if (picked.kind === "project") return;
    // an empty folder becomes the project itself, except for a clone, which needs one not there yet
    if (picked.kind === "empty" && !clone) {
      const at = splitTypedPath(picked.path);
      dispatch({ a: "new-project-set", v: { mode: "init", parent: at.parent, name: at.name } });
      return;
    }
    dispatch({ a: "new-project-set", v: { mode: clone ? "clone" : "create", parent: picked.path } });
    nameRef.current?.focus();
  });

  // the refusal leads: it answers a pick that has just happened, while the rest describe a state
  const hint =
    refusal ??
    (inPlace
      ? "the empty folder you chose becomes the project"
      : existing
        ? "the folder you chose is already a project: open it, or choose another"
        : taken
          ? `${where} already has a folder called ${typed}`
          : nameError);

  return (
    <div className="new-project-pane">
      {clone && <p className="new-project-url">{page.url}</p>}

      <div className="new-project-head">
        {inPlace ? (
          <p className="new-project-name">{name}</p>
        ) : (
          <Field
            ref={nameRef}
            bare
            font="lead"
            className="new-project-field"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={name}
            placeholder="Project name"
            disabled={!editing}
            // the box follows what is in it, so the folder beside it stays beside it rather than
            // being pushed to the far edge of a field stretched across the page
            style={{ width: `${Math.max(name.length + 1, NAME_MIN)}ch` }}
            onChange={(e) => dispatch({ a: "new-project-set", v: { name: e.target.value } })}
            // enter in a title goes to the body, the way it does in anything else with a title
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              describeRef.current?.focus();
            }}
          />
        )}
        <span className="new-project-where">
          <span className="hint">in</span>
          <span className="new-project-parent" {...tip(parent)}>
            {where}
          </span>
          <IconButton
            icon="folder"
            label={canAskFinder ? "Choose in Finder" : "Choose a folder"}
            className="new-project-folder"
            on={asking === "location"}
            disabled={!editing}
            onClick={() => choose("location")}
          />
        </span>
      </div>

      {hint && <p className="hint new-project-hint">{hint}</p>}

      <div className="new-project-body">
        <TextArea
          ref={describeRef}
          bare
          font="ui"
          value={prompt}
          placeholder={`describe ${typed || "the app"}…`}
          disabled={!editing}
          onChange={(e) => dispatch({ a: "new-project-set", v: { prompt: e.target.value } })}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            e.preventDefault();
            submit();
          }}
        />
      </div>

      <div className="hint new-project-knobs">
        {agents.length > 1 ? (
          <AgentModelChip agents={agents} agent={defaultAgent} model={model} onChange={pickAgentModel} />
        ) : (
          <ModelChip models={agentInfo?.models ?? NO_CHOICES} value={model} onChange={setModel} />
        )}
        <EffortChip efforts={agentInfo?.efforts ?? NO_CHOICES} value={effort} onChange={setEffort} />
        {existing ? (
          <Button variant="outline" size="lg" className="new-project-go" autoFocus onClick={() => openFolder(existing)}>
            open it
          </Button>
        ) : (
          <Button
            variant="outline"
            size="lg"
            className="new-project-go"
            busy={page.phase === "creating"}
            disabled={!ready}
            onClick={submit}
            {...tip(
              clone ? "Clone the project" : prompt.trim() ? "Make it and start on this" : "Make the project",
              "⏎",
            )}
          >
            {clone ? "clone" : "create"}
          </Button>
        )}
      </div>

      {/* under the action rather than over the title: this is asked once ever, and it is about git
          rather than about the project being written here */}
      {askIdentity && (
        <>
          <div className="new-project-identity">
            <Field
              size="md"
              font="ui"
              rule
              value={identity.name}
              placeholder="Your name"
              autoComplete="name"
              disabled={!editing}
              onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
            />
            <Field
              size="md"
              font="ui"
              rule
              type="email"
              value={identity.email}
              placeholder="Email"
              autoComplete="email"
              disabled={!editing}
              onChange={(e) => setIdentity({ ...identity, email: e.target.value })}
            />
          </div>
          <p className="hint new-project-hint">git labels the work you save with these, and asks only once</p>
        </>
      )}

      {!clone && editing && (
        <Button tone="quiet" className="new-project-open" onClick={() => choose("open")}>
          or open a folder you already have
        </Button>
      )}
    </div>
  );
}
