/**
 * Tool type surface (Layer 2). Schemas stay JSON objects (no Zod) to honor
 * CONTRACTS dependency allowlist.
 */

export type { ToolFn } from "./index.js";
export type { ToolMeta } from "./orchestration.js";
export {
  getToolMeta,
  isConcurrencySafe,
  partitionToolBatches,
  registerToolMeta,
  runToolBatches,
} from "./orchestration.js";
