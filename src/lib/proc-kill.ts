/**
 * Cross-platform "kill the whole process tree" helper.
 *
 * POSIX: the child is spawned detached (its own process group), so
 * process.kill(-pid, signal) reaches every descendant in one call.
 * Windows has no equivalent of a POSIX process group for signal delivery;
 * `taskkill /T /F` walks the tree by parent-child relationship instead.
 * Windows also has no graceful-then-forceful signal distinction the way
 * SIGTERM->SIGKILL does on POSIX, so any signal there just force-terminates.
 */
import { spawnSync } from "node:child_process";

export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already dead, or no permission: ignore
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // group already dead or without permission: ignore
  }
}
