/**
 * ANSI-colored unified-diff preview for CLI permission prompts.
 * Same line classifier as ui/PermissionModal DiffPreview: headers/hunks/
 * additions/removals/context get distinct colors; non-diff text stays dim.
 */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const GRAY = "\x1b[90m";

type DiffLineKind = "header" | "hunk" | "add" | "remove" | "context" | "other";

function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  if (line.startsWith(" ")) return "context";
  return "other";
}

function colorLine(line: string, useColor: boolean): string {
  if (!useColor) return line;
  switch (classifyDiffLine(line)) {
    case "header":
      return `${GRAY}${line}${RESET}`;
    case "hunk":
      return `${CYAN}${line}${RESET}`;
    case "add":
      return `${GREEN}${line}${RESET}`;
    case "remove":
      return `${RED}${line}${RESET}`;
    case "context":
      return `${DIM}${line}${RESET}`;
    default:
      return `${DIM}${line}${RESET}`;
  }
}

/**
 * Formats a preview string for the terminal. When `preview` looks like a
 * unified diff, colors each line; otherwise returns the text dimmed as before.
 */
export function formatPreviewForTerminal(
  preview: string,
  useColor: boolean = Boolean(process.stdout.isTTY),
): string {
  if (!preview) return preview;
  const looksLikeDiff =
    preview.includes("\n@@") ||
    preview.startsWith("--- ") ||
    preview.startsWith("@@") ||
    /^[+-](?![+-])/m.test(preview);
  if (!looksLikeDiff) {
    return useColor ? `${DIM}${preview}${RESET}` : preview;
  }
  return preview
    .split(/\r\n|\r|\n/)
    .map((line) => colorLine(line, useColor))
    .join("\n");
}
