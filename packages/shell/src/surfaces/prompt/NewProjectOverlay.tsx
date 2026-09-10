import { projectNameError } from "@toyon/shared";
import { useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { Overlay as OverlayState } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { FormRow } from "../../ui/FormRow.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { destination } from "../palettes/projectPicker.ts";

type NewProject = Extract<OverlayState, { kind: "new-project" }>;

/** The form behind a create or clone row. It appears exactly where something would otherwise be
 * guessed: a bare name has no location, and a clone has both name and location derived from a URL.
 * A typed path named its own destination, so that row creates without stopping here.
 *
 * Built from the same FormRow as the setup pane, because a project made here opens straight into
 * that pane asking how it runs, and the two are read one after the other. */
export function NewProjectOverlay({ overlay }: { overlay: NewProject }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const home = useStore((s) => s.home);
  const [name, setName] = useState(overlay.name);
  const [parent, setParent] = useState(overlay.parent);
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

      <FormRow label="name" hint={nameError ?? undefined}>
        <input
          className="field"
          autoFocus={!overlay.name}
          value={name}
          placeholder="my-app"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </FormRow>

      <FormRow label="in" hint={home && parent.startsWith("~") ? "where your other projects live" : undefined}>
        <input
          className="field"
          autoFocus={!!overlay.name}
          value={parent}
          placeholder="~/Projects"
          onChange={(e) => setParent(e.target.value)}
          onKeyDown={onKeyDown}
        />
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
