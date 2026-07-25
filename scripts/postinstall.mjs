// node-pty ships prebuilt binaries. On macOS the bundled `spawn-helper` can
// arrive without the execute bit, which makes `pty.spawn` fail at runtime with
// "posix_spawnp failed". Restore the bit here so a clean `npm install` just
// works. node-pty is an optional dependency, so this must never fail the install.
import { createRequire } from "node:module";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

try {
  const require = createRequire(import.meta.url);
  const prebuilds = join(dirname(require.resolve("node-pty/package.json")), "prebuilds");
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) {
      const helper = join(prebuilds, dir, "spawn-helper");
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  }
} catch {
  // node-pty not installed (optional dependency skipped) or no spawn-helper on
  // this platform (e.g. Windows uses conpty): nothing to fix.
}
