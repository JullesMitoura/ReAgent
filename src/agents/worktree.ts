/**
 * Git worktree helpers for isolated parallel workers.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { config } from "../config.js";
import { getLogger } from "../logs.js";

const log = getLogger("agents.worktree");

export interface WorktreeHandle {
  path: string;
  branch: string;
  cleanup: () => void;
}

/**
 * True when the worktree still holds work not integrated into the root repo:
 * uncommitted changes in the tree, or commits on its branch not reachable from
 * the root HEAD. Used to decide whether cleanup may destroy the worktree.
 */
export function worktreeHasPendingWork(handle: WorktreeHandle): boolean {
  if (!fs.existsSync(handle.path)) return false;
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: handle.path,
      encoding: "utf8",
    });
    if (status.trim()) return true;
  } catch {
    // cannot inspect: err on the side of preserving
    return true;
  }
  try {
    const count = execFileSync("git", ["rev-list", "--count", `HEAD..${handle.branch}`], {
      cwd: config.root,
      encoding: "utf8",
    });
    if (Number.parseInt(count.trim(), 10) > 0) return true;
  } catch {
    // branch missing or unreadable: nothing to preserve on that front
  }
  return false;
}

/** Create a disposable worktree under .reagent/worktrees/ when enabled. */
export function createAgentWorktree(label: string): WorktreeHandle | null {
  if (!config.worktreeAgents) return null;
  const root = config.root;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    return null;
  }
  const id = randomBytes(4).toString("hex");
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "agent";
  const branch = `reagent/${safe}-${id}`;
  const dir = path.join(config.stateDir, "worktrees", `${safe}-${id}`);
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync("git", ["worktree", "add", "-b", branch, dir, "HEAD"], {
      cwd: root,
      stdio: "ignore",
    });
    log.info("worktree created: %s (%s)", dir, branch);
    return {
      path: dir,
      branch,
      cleanup: () => {
        try {
          execFileSync("git", ["worktree", "remove", "--force", dir], {
            cwd: root,
            stdio: "ignore",
          });
        } catch {
          // ignore
        }
        try {
          execFileSync("git", ["branch", "-D", branch], { cwd: root, stdio: "ignore" });
        } catch {
          // ignore
        }
      },
    };
  } catch (e) {
    log.warning("worktree create failed: %s", String(e));
    return null;
  }
}
