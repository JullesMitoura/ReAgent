/**
 * Built-in agent definitions: explore, plan, worker, general-purpose, verification.
 */

import { config } from "../config.js";
import { EXPLORE_SYSTEM, EXPLORE_WHEN_TO_USE } from "../prompts/agents/explore.js";
import {
  GENERAL_PURPOSE_FORCE_SUMMARY,
  GENERAL_PURPOSE_SYSTEM,
  GENERAL_PURPOSE_WHEN_TO_USE,
} from "../prompts/agents/general-purpose.js";
import { PLAN_FORCE_SUMMARY, PLAN_SYSTEM, PLAN_WHEN_TO_USE } from "../prompts/agents/plan.js";
import {
  VERIFICATION_FORCE_SUMMARY,
  VERIFICATION_SYSTEM,
  VERIFICATION_WHEN_TO_USE,
} from "../prompts/agents/verification.js";
import {
  WORKER_FORCE_SUMMARY,
  WORKER_SYSTEM,
  WORKER_WHEN_TO_USE,
} from "../prompts/agents/worker.js";
import type { AgentDefinition } from "./types.js";

const READ_TOOLS = ["read_file", "list_dir", "glob", "grep"] as const;

const VERIFY_TOOLS = [...READ_TOOLS, "bash"] as const;

const WORKER_TOOLS = [
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "multi_edit",
  "delete_file",
  "apply_patch",
  "bash",
  "structured_output",
] as const;

const GENERAL_TOOLS = [...WORKER_TOOLS, "todoread", "skill"] as const;

export function builtinAgents(): AgentDefinition[] {
  return [
    {
      agentType: "explore",
      whenToUse: EXPLORE_WHEN_TO_USE,
      tools: READ_TOOLS,
      maxSteps: config.subagentMaxSteps,
      getSystemPrompt: () => EXPLORE_SYSTEM,
      forceSummary:
        "Step budget reached. Stop exploring and give your final dense summary now, " +
        "with concrete findings, file paths and line numbers.",
      emptyResult: "(no findings)",
      // Read-only agents can still spin on identical grep/read; block repeats.
      doomStyle: "worker",
      source: "built-in",
      supportsFork: true,
      supportsBackground: true,
    },
    {
      agentType: "plan",
      whenToUse: PLAN_WHEN_TO_USE,
      tools: READ_TOOLS,
      maxSteps: config.subagentMaxSteps,
      getSystemPrompt: () => PLAN_SYSTEM,
      forceSummary: PLAN_FORCE_SUMMARY,
      emptyResult: "(empty plan)",
      doomStyle: "worker",
      source: "built-in",
      supportsFork: true,
    },
    {
      agentType: "verification",
      whenToUse: VERIFICATION_WHEN_TO_USE,
      tools: VERIFY_TOOLS,
      maxSteps: config.subagentMaxSteps,
      getSystemPrompt: () => VERIFICATION_SYSTEM,
      forceSummary: VERIFICATION_FORCE_SUMMARY,
      emptyResult: "(inconclusive)",
      doomStyle: "worker",
      source: "built-in",
      supportsFork: true,
      supportsBackground: true,
    },
    {
      agentType: "worker",
      whenToUse: WORKER_WHEN_TO_USE,
      tools: WORKER_TOOLS,
      maxSteps: config.parallelMaxSteps,
      getSystemPrompt: (vars) => WORKER_SYSTEM.split("{title}").join(vars?.title ?? "worker"),
      forceSummary: WORKER_FORCE_SUMMARY,
      emptyResult: "(no report)",
      doomStyle: "worker",
      source: "built-in",
      isolation: "worktree",
      supportsBackground: true,
    },
    {
      agentType: "general-purpose",
      whenToUse: GENERAL_PURPOSE_WHEN_TO_USE,
      tools: GENERAL_TOOLS,
      maxSteps: config.subagentMaxSteps,
      getSystemPrompt: () => GENERAL_PURPOSE_SYSTEM,
      forceSummary: GENERAL_PURPOSE_FORCE_SUMMARY,
      emptyResult: "(no report)",
      doomStyle: "main",
      source: "built-in",
      supportsFork: true,
      supportsBackground: true,
    },
    {
      agentType: "coordinator-worker",
      whenToUse:
        "Implementation or verification task under coordinator mode; receives a self-contained brief from the lead.",
      tools: GENERAL_TOOLS,
      maxSteps: config.subagentMaxSteps,
      getSystemPrompt: () =>
        GENERAL_PURPOSE_SYSTEM +
        "\nYou are a coordinator-worker: execute the assigned slice only; report facts and paths.",
      forceSummary: GENERAL_PURPOSE_FORCE_SUMMARY,
      emptyResult: "(no report)",
      doomStyle: "main",
      source: "built-in",
      supportsBackground: true,
      isolation: "worktree",
    },
  ];
}
