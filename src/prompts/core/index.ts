/** Core prompt assets (stable prefix). Re-exports versioned modules. */
export {
  PROMPT_VERSION,
  RULES_HEAD,
  RULES_TAIL,
  PARALLEL_RULE,
  EXEC_SESSIONS_RULE,
  APP_SOURCE_PROTECTED_LINE,
  APP_SOURCE_UNPROTECTED_LINE,
} from "../rules.js";
export { BEST_PRACTICE_RULES } from "../best-practices.js";
export { GIT_SAFETY } from "../git-safety.js";
export {
  SANDBOX_HEADER,
  SANDBOX_OS_LINE,
  SANDBOX_NETWORK_LINE,
  SANDBOX_READONLY_LINE,
  SANDBOX_AUTO_APPROVE_LINE,
  SANDBOX_APPROVAL_REQUIRED_LINE,
} from "../sandbox.js";
export { USER_PROFILE_LABEL, CONTEXT_LABEL, projectInstructionsLabel } from "../sections.js";
