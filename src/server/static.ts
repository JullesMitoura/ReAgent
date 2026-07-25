/**
 * Resolves the built front-end directory.
 *
 * Prefers the `static/` bundled in the npm package (resolved relative to
 * import.meta.url), which works after installing the package and running
 * `reagent serve` in any project. Falls back to the `ui/` workspace build
 * (`ui/dist`) as a development fallback when `static/` was not built yet.
 *
 * Layering rule: surface (layer 4); does not import server/app.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Built front-end directory, or null when none exists. */
export function staticDir(): string | null {
  // 1) static/ bundled in the npm package. From src/server/ (or dist/server/),
  //    `../../static` resolves to the reagent package root + /static.
  try {
    const packaged = fileURLToPath(new URL("../../static", import.meta.url));
    if (fs.statSync(packaged).isDirectory()) return packaged;
  } catch {
    // absent: falls back to the development fallback
  }
  // 2) dev fallback: <package>/ui/dist (the front workspace build output).
  try {
    const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
    const dev = path.join(pkgRoot, "ui", "dist");
    if (fs.statSync(dev).isDirectory()) return dev;
  } catch {
    // absent
  }
  return null;
}
