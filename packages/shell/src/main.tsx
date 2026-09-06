import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./theme.css";
import { applyTheme, cachedTheme } from "./theme.ts";

// paint the last-used theme before React mounts: the daemon's hello replaces it moments later
applyTheme(cachedTheme());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
