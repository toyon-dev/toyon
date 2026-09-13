import { spawn } from "node:child_process";

/** the platform's URL opener; the URL is printed first, so a machine with no opener loses nothing */
export function openUrl(url: string): void {
  const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
  child.on("error", () => {}); // the URL is on the terminal; a headless box has nothing to open it with
  child.unref();
}
