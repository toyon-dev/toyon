import { projectNameError } from "@toyon/shared";
import { useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { NewProjectForm } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { FormRow } from "../../ui/FormRow.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { defaultParent, destination } from "./projectPicker.ts";

/** The form behind a create or clone row, and behind the project list's standing "new project" row.
 * It appears exactly where something would otherwise be guessed: a bare name has no location, and a
 * clone has both name and location derived from a URL. A typed path named its own destination, so
 * that row creates without stopping here.
 *
 * The location is read, not typed: it starts where the other projects already live, which is
 * usually right, and `change` walks to another folder in the chooser. Nobody has to know how to
 * write a path to put a project somewhere.
 *
 * Built from the same FormRow as the setup pane, because a project made here opens straight into
 * that pane asking how it runs, and the two are read one after the other. */
export function NewProjectOverlay({ overlay }: { overlay: NewProjectForm }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const repos = useStore((s) => s.repos);
  const current = useStore((s) => s.activeRepoId);
  const home = useStore((s) => s.home);
  const [name, setName] = useState(overlay.name);
  const { parent } = overlay;
  const clone = overlay.mode === "clone";
  const nameError = projectNameError(name);
  const ready = !nameError && parent.trim().length > 0;

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
    dispatch({ a: "close" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && ready) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Overlay onClose={() => dispatch({ a: "close" })}>
      <div className="overlay-title">{clone ? "clone a project into a new folder" : "new project"}</div>

      {clone && (
        <FormRow label="from" hint="cloned with the credentials git already uses on this machine">
          <span className="new-project-url">{overlay.url}</span>
        </FormRow>
      )}

      {/* an empty name is where the form starts from the "new project" row, not a mistake to flag */}
      <FormRow label="name" hint={name.trim() ? (nameError ?? undefined) : undefined}>
        <Field
          size="md"
          autoFocus
          value={name}
          placeholder="my-app"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </FormRow>

      <FormRow
        label="in"
        hint={
          repos.length > 0 && parent === defaultParent(repos, current, home)
            ? "where your other projects live"
            : undefined
        }
      >
        <div className="new-project-where">
          <span className="new-project-parent">
            <bdi>{parent}</bdi>
          </span>
          {/* the chooser replaces this form while it is open, so the name typed so far rides along */}
          <Button
            className="new-project-change"
            onClick={() => dispatch({ a: "open", overlay: { kind: "choose-folder", form: { ...overlay, name } } })}
          >
            change
          </Button>
        </div>
      </FormRow>

      <div className="form-actions">
        <span className="form-dest">{ready ? destination(parent, name) : ""}</span>
        <Button onClick={() => dispatch({ a: "close" })}>cancel</Button>
        <Button variant="outline" size="lg" disabled={!ready} onClick={submit}>
          {clone ? "clone" : "create"}
        </Button>
      </div>
    </Overlay>
  );
}
