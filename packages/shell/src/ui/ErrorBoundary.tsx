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

/** Catches a render throw so it can't unmount the root. Without one, any error anywhere leaves an
 * empty #root painted --bg0: a flat gray screen that says nothing about what happened or that a
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
      <div className={cx("crash", this.props.pane && "in-pane")}>
        <div className="crash-title">{staleBuild ? "toyon was updated" : "toyon hit an error"}</div>
        <div className="crash-body">
          {staleBuild
            ? "This page is still running the old build. Reload to pick up the new one."
            : error.message || String(error)}
        </div>
        <Button variant="outline" onClick={() => window.location.reload()}>
          reload
        </Button>
      </div>
    );
  }
}
