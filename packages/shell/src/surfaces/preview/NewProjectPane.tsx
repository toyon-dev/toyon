import { projectNameError } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { NewProject } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { destination, expandHome, folderName, splitTypedPath } from "../palettes/projectPicker.ts";

/** how long the name sits still before the page asks whether a folder by that name is already there */
const ASK_AFTER_MS = 150;

/** enough of an email for git to label work with; git itself checks nothing */
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** The new-project page, in the preview slot where the project's first-run screen is about to be.
 * It asks for as little as a project needs: a name, where it goes, and git's name and email when git
 * has none. No heading and no form rows: the placeholder says what the one field is for, and Enter
 * or create puts "what should it become?" in the same place a moment later.
 *
 * The location is read as the folder's own name, with the path on hover and the folder button beside
 * it, so nobody has to know how to write a path. Where the daemon can open Finder in front of the
 * person, what comes back decides the rest: an ordinary folder is the location, an empty one becomes
 * the project itself, and one that is already a project is offered for opening. The quiet line at the
 * bottom is for someone who came here with a project already. */
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
  const [identity, setIdentity] = useState({ name: "", email: "" });
  /** a folder picked as the location that is already a project */
  const [existing, setExisting] = useState<string | null>(null);
  /** why a folder picked to open was not opened */
  const [refusal, setRefusal] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const { mode, name, parent } = page;
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
    // pendingOpen is what makes this tab, and only this tab, adopt the project the daemon adds
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submit();
  };

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
          onChange={(e) => dispatch({ a: "new-project-set", v: { name: e.target.value } })}
          onKeyDown={onKeyDown}
        />
      )}
      <div className="new-project-where">
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
        {existing ? (
          <Button variant="outline" size="lg" className="new-project-go" autoFocus onClick={() => openFolder(existing)}>
            open it
          </Button>
        ) : (
          // shown once there is something to make, so a person who never presses Enter has a way on
          (ready || page.phase === "creating") && (
            <Button
              // With no name field to press enter in, the button is where the keyboard lands. Keyed on
              // the mode because autoFocus acts on mount, and this button is already up when the
              // field goes.
              key={inPlace ? "create-in-place" : "create"}
              variant="outline"
              size="lg"
              className="new-project-go"
              autoFocus={inPlace}
              busy={page.phase === "creating"}
              onClick={submit}
              {...tip(clone ? "Clone the project" : "Make the project", "⏎")}
            >
              {clone ? "clone" : "create"}
            </Button>
          )
        )}
      </div>
      {hint && <p className="hint new-project-hint">{hint}</p>}
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
              onKeyDown={onKeyDown}
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
              onKeyDown={onKeyDown}
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
