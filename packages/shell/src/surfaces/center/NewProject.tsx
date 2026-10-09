import { projectNameError } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { NEW_PROJECT_BOX, type NewProjectState } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { View } from "../../ui/View.tsx";
import { Composer } from "../chat/Composer.tsx";
import { destination, expandHome, folderName, splitTypedPath } from "../overlays/projectPicker.ts";

/** how long the name sits still before the project asks whether a folder by that name is already there */
const ASK_AFTER_MS = 150;

/** enough of an email for git to label work with; git itself checks nothing */
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** the name is sized to what is in it, with room to start typing in: a title with its folder beside
 * it, rather than a field stretched across the project with the folder pushed to the far edge */
const NAME_MIN = 14;

/**
 * The new project: a title, where it goes, and at the foot the box its first message is written
 * in. Written rather than filled in, so no heading, labels or boxes above the title; the box is
 * the composer itself, so the agent, model and effort are its chips, and return makes the project
 * and sends what was written as its first message.
 *
 * Nothing is made until return: making one takes a tenth of a second, and making it earlier would
 * leave a folder behind for every name thought better of. A folder picked in Finder decides the
 * rest: an ordinary folder is the location, an empty one becomes the project, and one that is
 * already a project is offered for opening. Git's name and email sit under the title when git has
 * none, since they are asked once ever and are not what this project is about.
 */
export function NewProject({ project }: { project: NewProjectState }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const repos = useStore((s) => s.repos);
  const home = useStore((s) => s.home);
  const canAskFinder = useStore((s) => s.folderDialog);
  const knowsIdentity = useStore((s) => s.gitIdentity);
  const asking = useStore((s) => s.choosingFolder);
  const chosen = useStore((s) => s.chosenFolder);
  const paths = useStore((s) => s.paths);
  const [identity, setIdentity] = useState({ name: "", email: "" });
  /** a folder picked as the location that is already a project */
  const [existing, setExisting] = useState<string | null>(null);
  /** why a folder picked to open was not opened */
  const [refusal, setRefusal] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const { mode, name, parent } = project;
  const clone = mode === "clone";
  const inPlace = mode === "init";
  const editing = project.phase === "editing";
  const typed = name.trim();
  // a folder made the project where it stands keeps the name it already has, spaces and all; an empty
  // field is where the project starts, not a mistake to flag
  const nameError = inPlace || !typed ? null : projectNameError(name);
  const dest = !inPlace && typed && !nameError ? destination(parent, typed) : null;
  const where = folderName(parent, home);
  const taken = dest !== null && paths.query === dest && paths.target?.exists === true;
  // a clone brings its own commits, so only a create or an init needs git to know who is making it
  const askIdentity = !knowsIdentity && !clone;
  const identityOk = !askIdentity || (identity.name.trim() !== "" && EMAIL.test(identity.email.trim()));
  // why return cannot make it yet, said under the box on the press
  const why = !editing
    ? null
    : existing
      ? "the folder you chose is already a project: open it, or choose another"
      : !inPlace && !typed
        ? "name the project first"
        : (nameError ??
          (taken
            ? `${where} already has a folder called ${typed}`
            : !identityOk
              ? "git needs your name and email first"
              : null));

  // whether a folder by that name is already there, asked once the name stops changing
  useEffect(() => {
    if (!dest) return;
    const timer = setTimeout(() => sock?.send({ t: "browse-path", path: dest }), ASK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [dest, sock]);

  // back from a refused create, or from the first-run screen: the keyboard goes back to the name
  useOnChange([project.phase], () => {
    if (project.phase === "editing") nameRef.current?.focus();
  });

  // a refusal is about the folder that was picked, so anything that changes what the project holds ends it
  useOnChange([mode, name, parent], () => setRefusal(null));

  // the daemon's refusal of the last create, under the box that asked; the next keystroke answers it
  useOnChange([project.error], () => {
    if (project.error) dispatch({ a: "notice", id: NEW_PROJECT_BOX, text: project.error });
  });

  const submit = () => {
    if (why || !editing) return;
    // pendingOpen is what makes this tab, and only this tab, adopt the project the daemon adds; what
    // is in the box rides on it and goes from the new project's own box (see settleView)
    dispatch({ a: "open-repo" });
    dispatch({ a: "new-project-set", v: { phase: "creating" } });
    sock?.send({
      t: "create-repo",
      mode,
      parent: parent.trim(),
      name: typed,
      ...(clone && project.url ? { url: project.url } : {}),
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

  // the refusal leads: it answers a pick that has just happened, while the rest describe a state.
  // A folder that is already a project carries the way in; the rest are words.
  const hint =
    refusal ??
    (inPlace
      ? "the empty folder you chose becomes the project"
      : existing
        ? null
        : taken
          ? `${where} already has a folder called ${typed}`
          : nameError);

  return (
    <View
      anchor="line"
      // the box at the foot is the composer itself, so what is chosen under it (the agent, its model,
      // the effort) is chosen where every other first message chooses it, and what is typed and
      // attached waits in the view's own box until the project exists
      foot={
        <div className="composer view-foot">
          <Composer active={null} project={{ name: typed, why, busy: !editing, create: submit }} />
        </div>
      }
    >
      {clone && <p className="new-project-url">{project.url}</p>}

      <div className="form-head">
        {inPlace ? (
          <p className="form-title">{name}</p>
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
            // being pushed to the far edge of a field stretched across the project
            style={{ width: `${Math.max(name.length + 1, NAME_MIN)}ch` }}
            onChange={(e) => dispatch({ a: "new-project-set", v: { name: e.target.value } })}
            // enter in a title goes to the body, the way it does in anything else with a title
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              dispatch({ a: "focus-chat" });
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

      {hint && <p className="hint">{hint}</p>}
      {existing && !refusal && (
        <p className="hint">
          the folder you chose is already a project:{" "}
          <Button variant="inline" autoFocus onClick={() => openFolder(existing)}>
            open it
          </Button>
          , or choose another
        </p>
      )}

      {/* under the title rather than in the box: this is asked once ever, and it is about git
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
          <p className="hint">git labels the work you save with these, and asks only once</p>
        </>
      )}

      {!clone && editing && (
        <Button tone="quiet" className="new-project-open" onClick={() => choose("open")}>
          or open a folder you already have
        </Button>
      )}
    </View>
  );
}
