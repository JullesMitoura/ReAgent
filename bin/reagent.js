#!/usr/bin/env node
// Thin CLI shim: import the build and propagate the exit code.
try {
  const mod = await import(new URL("../dist/cli/main.js", import.meta.url));
  const code = await mod.main(process.argv.slice(2));
  if (typeof code === "number") process.exitCode = code;
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
}
