import { projectNameError } from "@toyon/shared";
import { useRef, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { NewProjectForm } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { FormRow } from "../../ui/FormRow.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { destination, expandHome, splitTypedPath } from "./projectPicker.ts";

/** The form behind a create or clone row, and behind the project list's standing "new project" row.
 * It appears exactly where something would otherwise be guessed: a bare name has no location, and a
 * clone has both name and location derived from a URL. A typed path named its own destination, so
 * that row creates without stopping here.
 *
 * The location is read, not typed: it starts where the other projects already live, which is
 * usually right, and the folder button beside it picks another. Nobody has to know how to write a
 * path to put a project somewhere.
 *
 * Where the daemon can open the OS folder dialog in front of the person, that button is Finder, and
 * what comes back decides the rest. An ordinary folder is the location. An empty one, most likely
 * made right there with New Folder, becomes the project itself. One that is already a project is
 * offered for opening, since nesting a new one inside it is never the intent. Anywhere else the
 * button walks to a folder in the chooser.
 *
 * Built from the same FormRow as the setup pane, because a project made here opens straight into
 * that pane asking how it runs, and the two are read one after the other. */
export function NewProjectOverlay({ overlay }: { overlay: NewProjectForm }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const repos = useStore((s) => s.repos);
  const home = useStore((s) => s.home);
  const canAskFinder = useStore((s) => s.folderDialog);
  const asking = useStore((s) => s.choosingFolder);
  const chosen = useStore((s) => s.chosenFolder);
  const [name, setName] = useState(overlay.name);
  /** a folder picked in Finder that is already a project */
  const [existing, setExisting] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { parent } = overlay;
  const clone = overlay.mode === "clone";
  const inPlace = overlay.mode === "init";
  // a folder made the project where it stands keeps the name it already has, spaces and all
  const nameError = inPlace ? null : projectNameError(name);
  const ready = !nameError && parent.trim().length > 0;

  // leaving the form while the dialog is up takes the dialog with it
  const close = () => {
    if (asking) sock?.send({ t: "cancel-folder" });
    dispatch({ a: "close" });
  };

  const submit = () => {
    if (!ready) return;
    // the daemon adds the repo and broadcasts it; pendingOpen is what makes this tab, and only this
    // tab, adopt it. The same path register-repo already takes.
    dispatch({ a: "open-repo" });
    sock?.send({
      t: "create-repo",
      mode: overlay.mode,
      parent: parent.trim(),
      name: name.trim(),
      ...(clone ? { url: overlay.url } : {}),
    });
    close();
  };

  const openExisting = () => {
    if (!existing) return;
    // registering a project the daemon already has adds nothing, so nothing would switch to it
    const known = repos.find((r) => r.path === expandHome(existing, home));
    if (known) {
      dispatch({ a: "activate-repo", id: known.id });
    } else {
      dispatch({ a: "open-repo" });
      sock?.send({ t: "register-repo", path: existing });
    }
    close();
  };

  const chooseFolder = () => {
    if (canAskFinder) {
      dispatch({ a: "choosing-folder", v: true });
      sock?.send({ t: "choose-folder", start: parent });
    } else {
      // the chooser replaces this form while it is open, so the name typed so far rides along
      dispatch({ a: "open", overlay: { kind: "choose-folder", form: { ...overlay, name } } });
    }
  };

  // The answer arrives as a store change, and only the form that asked acts on it. The flag is
  // cleared here rather than by the answer: cleared first, this would read it as not asked.
  useOnChange([chosen?.seq], () => {
    if (!asking || !chosen) return;
    dispatch({ a: "choosing-folder", v: false });
    const picked = chosen.folder;
    // the dialog had the keyboard, and the name field is where it goes back to
    if (!picked) {
      nameRef.current?.focus();
      return;
    }
    setExisting(picked.kind === "project" ? picked.path : null);
    if (picked.kind === "project") return;
    // a clone needs a folder that is not there yet, so for one an empty folder is only a location
    if (picked.kind === "empty" && !clone) {
      const at = splitTypedPath(picked.path);
      setName(at.name);
      dispatch({ a: "open", overlay: { ...overlay, mode: "init", parent: at.parent, name: at.name } });
      return;
    }
    dispatch({ a: "open", overlay: { ...overlay, mode: clone ? "clone" : "create", parent: picked.path, name } });
    nameRef.current?.focus();
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && ready) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Overlay onClose={close}>
      <div className="overlay-title">{clone ? "clone a project into a new folder" : "new project"}</div>

      {clone && (
        <FormRow label="from" hint="cloned with the credentials git already uses on this machine">
          <span className="new-project-url">{overlay.url}</span>
        </FormRow>
      )}

      {/* an empty name is where the form starts from the "new project" row, not a mistake to flag */}
      <FormRow
        label="name"
        hint={
          inPlace
            ? "the empty folder you chose becomes the project"
            : name.trim()
              ? (nameError ?? undefined)
              : undefined
        }
      >
        {inPlace ? (
          <span className="new-project-name">{name}</span>
        ) : (
          <Field
            ref={nameRef}
            size="md"
            autoFocus
            value={name}
            placeholder="my-app"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
      </FormRow>

      <FormRow
        label="in"
        hint={existing ? "the folder you chose is already a project: open it, or choose another" : undefined}
      >
        <div className="new-project-where">
          <span className="new-project-parent">
            <bdi>{parent}</bdi>
          </span>
          <IconButton
            icon="folder"
            label={canAskFinder ? "Choose in Finder" : "Choose a folder"}
            className="new-project-folder"
            on={asking}
            onClick={chooseFolder}
          />
        </div>
      </FormRow>

      <div className="form-actions">
        <span className="form-dest">{existing ?? (ready ? destination(parent, name) : "")}</span>
        <Button onClick={close}>cancel</Button>
        {existing ? (
          <Button variant="outline" size="lg" autoFocus onClick={openExisting}>
            open it
          </Button>
        ) : (
          // With no name field to press enter in, the button is where the keyboard lands. Keyed on the
          // mode because autoFocus only acts on mount, and this button was already up when the field went.
          <Button
            key={inPlace ? "create-in-place" : "create"}
            variant="outline"
            size="lg"
            autoFocus={inPlace}
            disabled={!ready}
            onClick={submit}
          >
            {clone ? "clone" : "create"}
          </Button>
        )}
      </div>
    </Overlay>
  );
}
