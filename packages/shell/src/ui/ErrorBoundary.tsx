import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button.tsx";
import { cx } from "./cx.ts";
import "./crash.css";

/** Vite could not load a chunk. A rebuilt shell rotates every hashed filename, so a tab that has
 * been open across a rebuild asks the daemon for code that no longer exists. React.lazy caches the
 * rejection, so only a reload gets that tab working again. */
let staleBuild = false;
export function markStaleBuild() {
  staleBuild = true;
}

/** The card for a thing that has stopped and the one move that brings it back: a render error, a
 * stale build, a stream that exited. `pane` fits it inside a Pane, from the head down, instead
 * of the whole window. */
export function CrashCard({
  title,
  body,
  action,
  pane,
}: {
  title: string;
  body?: string;
  action: ReactNode;
  pane?: boolean;
}) {
  return (
    <div className={cx("crash", pane && "in-pane")}>
      <div className="crash-title">{title}</div>
      {body && <div className="crash-body">{body}</div>}
      {action}
    </div>
  );
}

/** what a stale build says, wherever it is noticed: here, and the preview's protocol check */
export const STALE_BUILD = {
  title: "Toyon was updated",
  body: "This page is still running the old build. Reload to pick up the new one.",
} as const;

/** Catches a render throw so it can't unmount the root. Without one, any error anywhere leaves an
 * empty #root painted --surface0: a flat gray screen that says nothing about what happened or that a
 * reload fixes it. `pane` fits the boundary inside a Pane instead of the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; pane?: boolean }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[toyon] render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <CrashCard
        pane={this.props.pane}
        title={staleBuild ? STALE_BUILD.title : "Toyon hit an error"}
        body={staleBuild ? STALE_BUILD.body : error.message || String(error)}
        action={
          <Button variant="outline" onClick={() => window.location.reload()}>
            reload
          </Button>
        }
      />
    );
  }
}
