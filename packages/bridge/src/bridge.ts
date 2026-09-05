// Injected into preview pages by the per-worktree proxy.
// v0.1: reports navigation + runtime errors to the shell via postMessage.
// M4 adds the element picker on top of this channel.

const post = (msg: Record<string, unknown>) => {
  try {
    window.parent.postMessage({ __orchardist: true, ...msg }, "*");
  } catch {
    // not framed; nothing to do
  }
};

post({ type: "loaded", url: location.href, title: document.title });

window.addEventListener("error", (e) => {
  post({ type: "page-error", message: String(e.message), source: e.filename, line: e.lineno });
});

window.addEventListener("unhandledrejection", (e) => {
  post({ type: "page-error", message: `unhandled rejection: ${String(e.reason)}` });
});

// SPA navigation reporting
const origPush = history.pushState.bind(history);
history.pushState = (...args) => {
  origPush(...args);
  post({ type: "navigated", url: location.href });
};
window.addEventListener("popstate", () => post({ type: "navigated", url: location.href }));
