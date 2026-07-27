// Cross-platform replacement for `rm -rf static && cp -R ui/dist static`
// (those are POSIX-only and fail on Windows, where npm scripts run under
// cmd.exe by default). fs.rmSync/fs.cpSync are built into Node >=16.7, no
// new dependency needed.
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const staticDir = path.join(root, "static");
const uiDist = path.join(root, "ui", "dist");

rmSync(staticDir, { recursive: true, force: true });
cpSync(uiDist, staticDir, { recursive: true });
