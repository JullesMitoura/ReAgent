/**
 * Cross-platform equivalent of shutil.which for a single program name.
 * On win32, tries each PATHEXT extension (default .COM;.EXE;.BAT;.CMD) when
 * `program` has no extension of its own; on POSIX, checks the X_OK bit.
 */
import fs from "node:fs";
import path from "node:path";

function candidateNames(program: string): string[] {
  if (process.platform !== "win32") return [program];
  if (path.extname(program)) return [program];
  const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [program, ...pathext.map((ext) => program + ext)];
}

export function which(program: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of candidateNames(program)) {
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}
