/**
 * Tool registry, schemas and dispatch: the single entry point between the
 * model's tool calls and their implementations.
 *
 * - REGISTRY maps name -> function; every tool stays registered at all times
 *   (execution self-protects via config at call time, not at import time), so
 *   a /cd to another project with a different config takes effect immediately.
 * - activeSchemas() is re-evaluated per turn and offers the model only the
 *   tools enabled in the CURRENT config / permission mode, in a stable
 *   name-sorted order (prompt-cache friendliness).
 * - dispatch() NEVER throws: every error becomes text the model consumes.
 *   Oversized outputs (> MAX_TOOL_OUTPUT) spill to .reagent/truncations
 *   (7-day retention) and return a head-tail preview plus the file path. On
 *   top of the per-call cap, an aggregate per-turn output budget
 *   (TURN_OUTPUT_BUDGET) aggressively truncates once a turn has already
 *   consumed too many chars of tool output.
 * - Modules that would create an import cycle with this one (subagent,
 *   parallel, skills, ...) register their tools late via registerTool();
 *   until they do, activeSchemas() does not offer the corresponding schemas
 *   (invariant: activeSchemas is a subset of REGISTRY).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config, MAX_TOOL_OUTPUT } from "../config.js";
import { mapLimit } from "../lib/pool.js";
import {
  runPostToolUse,
  runPostToolUseFailureHooks,
  runPreToolUse,
} from "../hooks/runner.js";
import { getLogger } from "../logs.js";
import { confirmHookAsk } from "../permissions.js";
import { BARE_MODE_TOOLS, COORDINATOR_MODE_TOOLS, modeAllowsTool, PLAN_MODE_TOOLS } from "../modes.js";
import { builtinAgents } from "../agents/builtin.js";
import { loadDiskAgents } from "../agents/load.js";
import {
  AGENT_TOOL_DELEGATION_POLICY,
  formatAgentTypesBlock,
  spawnModePolicy,
} from "../prompts/tools/agent-briefing.js";
import { currentTurn } from "../turn-context.js";
import type { ToolCall } from "../types.js";
import { remember } from "../user-profile.js";
import { APPLY_PATCH_SCHEMA, applyPatch } from "./apply-patch.js";
import { taskOutput, taskStop } from "./background-tasks.js";
import { ArgumentError, ToolError } from "./errors.js";
import { deleteFile, editFile, listDir, multiEdit, readFile, writeFile } from "./files.js";
import {
  EXEC_COMMAND_SCHEMA,
  WRITE_STDIN_SCHEMA,
  execCommand,
  writeStdin,
} from "./exec-sessions.js";
import { question } from "./question.js";
import { globFiles, grep } from "./search.js";
import { bash } from "./shell.js";
import { todoRead, todoWrite } from "./todo.js";
import { webfetch } from "./web.js";

// Traceability for successful tool outputs: query.ts already logs the tool
// name + redacted args on every call and the first 200 chars of FAILED
// results, but nothing about successful output, making post-hoc debugging
// from the log file alone impossible. Deliberately minimal: name + output
// LENGTH only, never the content itself (arbitrary file content can hold
// secrets the redact() pass does not catch).
const log = getLogger("tools");

function agentTypesDescription(): string {
  const map = new Map<string, { agentType: string; whenToUse: string }>();
  for (const a of builtinAgents()) map.set(a.agentType, a);
  for (const a of loadDiskAgents()) map.set(a.agentType, a);
  return formatAgentTypesBlock([...map.values()]);
}

function deferredUnlocked(name: string): boolean {
  if (!config.enableDeferredTools) return true;
  return Boolean(currentTurn()?.enabledDeferred.has(name));
}

export { ArgumentError, ToolError } from "./errors.js";

export type ToolFn = (args: Record<string, unknown>) => string | Promise<string>;

// Controlled error when a required argument is missing (replaces Python's kwargs
// TypeError; dispatch maps it to "Argument error: ...").
function reqStr(a: Record<string, unknown>, key: string): string {
  if (a[key] === undefined) throw new ArgumentError(`missing required argument: '${key}'`);
  return a[key] as string;
}

export const REGISTRY: Record<string, ToolFn> = {
  read_file: (a) =>
    readFile(reqStr(a, "path"), a["offset"] as number | undefined, a["limit"] as number | undefined),
  write_file: (a) => writeFile(reqStr(a, "path"), reqStr(a, "content")),
  edit_file: (a) =>
    editFile(
      reqStr(a, "path"),
      reqStr(a, "old_string"),
      reqStr(a, "new_string"),
      a["replace_all"] as boolean | undefined,
    ),
  multi_edit: (a) => multiEdit(reqStr(a, "path"), a["edits"] as Parameters<typeof multiEdit>[1]),
  delete_file: (a) => deleteFile(reqStr(a, "path")),
  list_dir: (a) => listDir(a["path"] as string | undefined),
  glob: (a) => globFiles(reqStr(a, "pattern")),
  grep: (a) =>
    grep(reqStr(a, "pattern"), a["path"] as string | undefined, a["include"] as string | null | undefined),
  bash: (a) =>
    bash(reqStr(a, "command"), a["timeout"] as number | undefined, {
      description: a["description"] as string | undefined,
      runInBackground: a["run_in_background"] as boolean | undefined,
    }),
  task_output: (a) =>
    taskOutput(a["task_id"] as string | undefined, a["filter"] as string | undefined),
  task_stop: (a) => taskStop(reqStr(a, "task_id")),
  todowrite: (a) => todoWrite(a["todos"] as Parameters<typeof todoWrite>[0]),
  todoread: () => todoRead(),
  question: (a) => question(reqStr(a, "question"), a["options"] as string[] | undefined),
  webfetch: (a) => webfetch(reqStr(a, "url"), a["max_chars"] as number | undefined),
  apply_patch: (a) => applyPatch(reqStr(a, "patch")),
  // Persistent shell sessions (PTY): long-running processes across rounds.
  exec_command: (a) =>
    execCommand(
      a["command"] as string,
      a["yield_time_ms"] as number | undefined,
      a["session_id"] as number | null | undefined,
    ),
  write_stdin: (a) =>
    writeStdin(a["session_id"] as number, reqStr(a, "chars"), a["yield_time_ms"] as number | undefined),
  // User profile (global USER.md): durable facts across projects.
  remember: (a) => remember(reqStr(a, "fact")),
};

/**
 * Late registration of a tool (phase 6: explore, parallel_agents).
 *
 * Prevents this module from importing subagent/parallel (which in turn import
 * REGISTRY/dispatch from here): the next phase calls registerTool when its
 * modules load and the schema starts being offered by active_schemas.
 */
export function registerTool(name: string, fn: ToolFn): void {
  REGISTRY[name] = fn;
}

// Tools safe to run in parallel within the same round: they only read, never ask
// for permission nor mutate shared state. The agent only parallelizes when the
// WHOLE round is of these (so a read never races against a write).
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "todoread",
  "webfetch",
  "task_output",
]);

export const TOOL_SCHEMAS: object[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Reads a project file with numbered lines. Use offset/limit for large files. " +
        "Always use this tool instead of cat/head/tail via bash.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project root" },
          offset: { type: "integer", description: "First line (1-indexed)", default: 1 },
          limit: { type: "integer", description: "Maximum number of lines", default: 2000 },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Creates or overwrites a file with the given content. ALWAYS prefer editing an " +
        "existing file (edit_file); only use this for new files or full rewrites. Never " +
        "proactively create documentation (*.md) or README files unless explicitly " +
        "requested. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replaces old_string with new_string in a file (exact match). Read the file before " +
        "editing. old_string must uniquely identify one spot — include enough surrounding " +
        "context (preserving exact indentation); the edit fails if it matches more than " +
        "once. Use replace_all to change every occurrence (e.g. renaming a variable). " +
        "Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean", default: false },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "multi_edit",
      description:
        "Applies several edits to ONE file in a single atomic call. Edits are applied in order, each operating on the result of the previous one; if any edit fails to match, none are applied. Use this instead of many edit_file calls when making multiple changes to the same file. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                old_string: { type: "string" },
                new_string: { type: "string" },
                replace_all: { type: "boolean", default: false },
              },
              required: ["old_string", "new_string"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description:
        "Deletes a file from the project (removes it entirely). Use this to delete a file; do NOT empty a file or remove its lines to 'delete' it. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "Lists the files and subdirectories of a project directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", default: "." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "Finds files by glob pattern, e.g. '*.py' or 'src/**/*.py'. " +
        "Use this instead of find via bash.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Searches file contents with a regex. Returns file:line: snippet. " +
        "Always use this tool instead of grep/rg via bash.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression" },
          path: { type: "string", default: "." },
          include: { type: "string", description: "Filename filter, e.g. '*.py'" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Runs a shell command at the project root and returns its output. Requires user approval.\n" +
        "Usage notes:\n" +
        "- Prefer the dedicated tools over shell equivalents: read_file instead of cat/head/tail, " +
        "edit_file instead of sed/awk, grep and glob tools instead of grep/find.\n" +
        "- Always quote file paths that contain spaces with double quotes " +
        '(e.g. ls "path with spaces").\n' +
        "- Avoid `cd`: use paths relative to the project root instead.\n" +
        "- NEVER use echo/printf to communicate with the user; output text directly in your response.\n" +
        "Git: only commit when the user explicitly asks. Never skip hooks (--no-verify), never " +
        "force-push to main/master, never amend commits you did not create; pass commit messages " +
        "via a HEREDOC.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "integer", description: "Timeout in seconds", default: 120 },
          description: {
            type: "string",
            description: "Clear, concise description of what this command does in 5-10 words",
          },
          run_in_background: {
            type: "boolean",
            default: false,
            description:
              "Run the command in the background and return immediately. Only use when you " +
              "don't need the result right away; check progress with task_output and kill " +
              "with task_stop. No trailing '&' needed.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_output",
      description:
        "Shows the status and recent output (log tail) of a background task started with " +
        "bash run_in_background. Without task_id, lists all background tasks.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task id; omit to list all tasks" },
          filter: {
            type: "string",
            description: "Optional regex; only log lines matching it are shown",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_stop",
      description:
        "Stops a running background task (SIGTERM to its process group, SIGKILL after 2s).",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todowrite",
      description:
        "Updates your task list for the current work (send the full list on every update). " +
        "Use it proactively for tasks with 3+ distinct steps or when the user lists multiple " +
        "tasks; skip it for single trivial tasks and purely conversational requests. Keep " +
        "exactly ONE item in_progress at a time (mark it BEFORE starting work) and mark items " +
        "completed IMMEDIATELY after finishing each one — never batch completions. Only mark " +
        "completed when fully done; if blocked or tests fail, keep it in_progress and add a " +
        "new item for what must be resolved.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todoread",
      description: "Reads your current task list.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Saves a durable fact about the USER (not the project) to their global profile " +
        "(~/.reagent/USER.md), which is shown to you in every future session across all " +
        "projects. Use it when the user states a lasting preference: their name, how they " +
        "like code written, tools or patterns they avoid, response style. Do not save " +
        "project-specific or one-off facts.",
      parameters: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description: "One distilled fact, e.g. 'prefers type hints everywhere'",
          },
        },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "question",
      description:
        "Ask the user only when blocked on a decision only they can make — one you cannot " +
        "resolve from the request, the code, or sensible defaults. If the answer would not " +
        "change what you do next, pick the conventional option and proceed. When offering " +
        "choices, provide 2–4 distinct options (never a single option); put the recommended " +
        "option first and suffix its label with (Recommended). " +
        "In plan mode use this to clarify requirements, then call exit_plan_mode for approval " +
        "(never ask 'should I proceed?' here).",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 4,
            description:
              "2–4 mutually exclusive choices; first item should be the recommended option",
          },
        },
        required: ["question"],
      },
    },
  },
];

// webfetch schema kept apart: offered dynamically by active_schemas() based on
// config.enableWebfetch of the CURRENT config (not the one at import time).
const _WEBFETCH_SCHEMA = {
  type: "function",
  function: {
    name: "webfetch",
    description: "Fetches the content of a URL (converted to text).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_chars: { type: "integer", default: 20000 },
      },
      required: ["url"],
    },
  },
};

// explore schema kept apart: offered dynamically by active_schemas() based on
// config.enableSubagent, not at import. The description contains the U+2014
// character (em dash) as in Python; reproduced byte for byte via —.
const _EXPLORE_SCHEMA = {
  type: "function",
  function: {
    name: "explore",
    description:
      "Delegates a read-only investigation to a sub-agent that runs with its OWN context " +
      "and returns a concise summary. Use for open-ended exploration needing roughly 3+ " +
      "independent searches (e.g. 'understand how auth works') to keep your own context lean. " +
      "For a single-fact lookup where you already know the path, search directly instead. " +
      "Prefer agent(subagent_type=explore). The sub-agent can read, list, glob and grep, " +
      "but cannot modify anything, run commands, or ask questions.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short label for the investigation" },
        prompt: {
          type: "string",
          description:
            "Detailed instructions: what to investigate and exactly what to report back",
        },
      },
      required: ["description", "prompt"],
    },
  },
};

// parallel_agents schema kept apart: offered dynamically by active_schemas()
// based on config.enableParallel (enabled by default).
const _PARALLEL_SCHEMA = {
  type: "function",
  function: {
    name: "parallel_agents",
    description:
      "Runs 2 or more worker sub-agents IN PARALLEL, each executing one independent task with its own " +
      "context, and returns their reports. Use this ON YOUR OWN INITIATIVE whenever your plan contains " +
      "independent tasks that touch DISJOINT sets of files (for example 'improve the game mechanics' and " +
      "'create a separate sound module'); the user does not need to ask for parallelism. Each worker can " +
      "read, search, create, edit and delete files and run shell commands, under the usual permission " +
      "rules. Do NOT use it for tasks that must change the same file or depend on each other's results; " +
      "do those yourself, in order. Write each prompt as a complete standalone brief.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Short label shown to the user in the execution graph (3-6 words)",
              },
              prompt: {
                type: "string",
                description:
                  "Complete standalone instructions for this worker: the goal, the relevant " +
                  "files, constraints, and what to report back",
              },
            },
            required: ["title", "prompt"],
          },
        },
      },
      required: ["tasks"],
    },
  },
};

/**
 * Tools offered to the model IN THIS turn, from the current config.
 *
 * webfetch, explore, parallel_agents and the exec sessions are only offered when
 * enabled in the CURRENT project config (re-evaluated each turn; /cd swaps the set
 * on the spot). explore/parallel_agents only appear when already registered
 * (phase 6): the invariant activeSchemas subset of REGISTRY is kept.
 */
/** Tools allowed in --plan / plan_mode (read-only + orientation). */
// PLAN_MODE_TOOLS imported from modes.ts

function schemaName(s: object): string {
  return (s as { function?: { name?: string } }).function?.name ?? "";
}

export function activeSchemas(): object[] {
  const schemas: object[] = [...TOOL_SCHEMAS];
  // remember is in TOOL_SCHEMAS — strip when deferred and not unlocked
  if (config.enableDeferredTools && !deferredUnlocked("remember")) {
    const idx = schemas.findIndex((s) => schemaName(s) === "remember");
    if (idx >= 0) schemas.splice(idx, 1);
  }
  schemas.push(APPLY_PATCH_SCHEMA); // core tool, always offered
  if (config.enableWebfetch && deferredUnlocked("webfetch")) schemas.push(_WEBFETCH_SCHEMA);
  const bare = config.permissionMode === "bare";
  const plan = config.permissionMode === "plan";
  // Compat aliases: explore/plan remain as thin wrappers; prefer agent(subagent_type).
  if (!bare && config.enableSubagent && "explore" in REGISTRY) schemas.push(_EXPLORE_SCHEMA);
  if (!bare && !plan && config.enableParallel && "parallel_agents" in REGISTRY) {
    schemas.push(_PARALLEL_SCHEMA);
  }
  if (!bare && !plan && config.enableExecSessions && deferredUnlocked("exec_command")) {
    schemas.push(EXEC_COMMAND_SCHEMA);
    if (deferredUnlocked("write_stdin")) schemas.push(WRITE_STDIN_SCHEMA);
  }
  if (!bare && config.enableDeferredTools && "tool_search" in REGISTRY) {
    schemas.push({
      type: "function",
      function: {
        name: "tool_search",
        description:
          "Discover and activate deferred tools for this turn (webfetch, exec_command, " +
          "write_stdin, remember, workflow). Call when you need a niche capability not " +
          "currently in your tool list.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Tool name or capability keywords" },
          },
          required: ["query"],
        },
      },
    });
  }
  if (!bare && !plan && config.enableWorkflow && "workflow" in REGISTRY && deferredUnlocked("workflow")) {
    schemas.push({
      type: "function",
      function: {
        name: "workflow",
        description:
          "Opt-in multi-agent workflow. mode=pipeline runs steps sequentially (later steps " +
          "see prior reports); mode=parallel runs steps concurrently. Only use when the user " +
          "asked for a workflow or multi-agent orchestration, or when config has workflow enabled " +
          "and the task clearly needs structured fan-out.",
        parameters: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["pipeline", "parallel"] },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  agent_type: { type: "string" },
                  prompt: { type: "string" },
                  title: { type: "string" },
                },
                required: ["agent_type", "prompt"],
              },
            },
          },
          required: ["mode", "steps"],
        },
      },
    });
  }
  // Late-registered optional schemas (skill, agent, plan, exit_plan_mode).
  if (!bare && "skill" in REGISTRY) {
    schemas.push({
      type: "function",
      function: {
        name: "skill",
        description:
          "Load the full body of a named skill (playbook). Use when a skill from the " +
          "system catalog matches the task; do not load skills you do not need.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill name from the catalog" },
          },
          required: ["name"],
        },
      },
    });
  }
  if (!bare && "plan" in REGISTRY && config.enableSubagent) {
    schemas.push({
      type: "function",
      function: {
        name: "plan",
        description:
          "Alias for agent(subagent_type=plan). Delegate planning to a read-only plan sub-agent. " +
          "Returns an ordered plan and Critical Files for Implementation.",
        parameters: {
          type: "object",
          properties: {
            description: { type: "string", description: "Short label for the plan task" },
            prompt: {
              type: "string",
              description: "Self-contained briefing for the planner (goal, constraints, context)",
            },
          },
          required: ["prompt"],
        },
      },
    });
  }
  if (!bare && "agent" in REGISTRY && config.enableSubagent) {
    const typesBlock = agentTypesDescription();
    schemas.push({
      type: "function",
      function: {
        name: "agent",
        description:
          `${spawnModePolicy(config.spawnMode)}\n\n${AGENT_TOOL_DELEGATION_POLICY}\n\n${typesBlock}\n\n` +
          "Prefer this unified tool. Launch multiple agent calls in one message for independent research. " +
          "Use parallel_agents only for write-capable workers on disjoint files. " +
          "To continue a finished agent, use send_message with its agent-id (do not spawn a duplicate).",
        parameters: {
          type: "object",
          properties: {
            subagent_type: {
              type: "string",
              description:
                "explore | plan | verification | general-purpose | coordinator-worker | disk agents",
            },
            description: { type: "string", description: "Short 3–6 word label" },
            prompt: { type: "string", description: "Self-contained briefing" },
            fork: {
              type: "boolean",
              description: "If true, inherit the parent's system prompt prefix (cache-friendly)",
            },
            background: {
              type: "boolean",
              description:
                "If true, return immediately; completion arrives as a <task-notification> message",
            },
          },
          required: ["subagent_type", "prompt"],
        },
      },
    });
  }
  if (!bare && "send_message" in REGISTRY && config.enableSubagent) {
    schemas.push({
      type: "function",
      function: {
        name: "send_message",
        description:
          "Continue a previously spawned agent by agent-id with a follow-up that keeps its full " +
          "transcript. Prefer this over a fresh agent spawn when correcting a failure, extending " +
          "recent work, or turning research into an implementation on the same files. " +
          "Never write 'based on your findings' — synthesize the exact change in the message. " +
          "Spawn a fresh agent instead when you need independent verification eyes or a clean slate.",
        parameters: {
          type: "object",
          properties: {
            to: {
              type: "string",
              description: "agent-id from a prior agent result footer or <task-notification>",
            },
            message: {
              type: "string",
              description: "Self-contained follow-up directive (paths, lines, done criteria)",
            },
            summary: {
              type: "string",
              description: "Optional short label for the continuation",
            },
          },
          required: ["to", "message"],
        },
      },
    });
  }
  if (!bare && "list_agents" in REGISTRY && config.enableSubagent) {
    schemas.push({
      type: "function",
      function: {
        name: "list_agents",
        description:
          "List continuable nested agents in this process (id, type, status, title). " +
          "Use before send_message when you need to recall an agent-id.",
        parameters: { type: "object", properties: {} },
      },
    });
  }
  if (plan && "exit_plan_mode" in REGISTRY) {
    schemas.push({
      type: "function",
      function: {
        name: "exit_plan_mode",
        description:
          "Present the final plan for approval and leave plan mode so implementation can begin. " +
          "Do NOT use question to ask if the plan is OK — that is what this tool does.",
        parameters: {
          type: "object",
          properties: {
            plan: {
              type: "string",
              description: "Full plan markdown (steps, critical files, risks)",
            },
            summary: {
              type: "string",
              description: "Optional one-line summary shown above the plan",
            },
          },
          required: ["plan"],
        },
      },
    });
  }
  let out = schemas;
  if (plan) {
    out = out.filter((s) => PLAN_MODE_TOOLS.has(schemaName(s)));
  } else if (bare) {
    out = out.filter((s) => BARE_MODE_TOOLS.has(schemaName(s)));
  } else if (config.coordinatorMode) {
    out = out.filter((s) => COORDINATOR_MODE_TOOLS.has(schemaName(s)));
  }
  // Stable order for prompt-cache friendliness (Claude Code assembleToolPool).
  return out.sort((a, b) => schemaName(a).localeCompare(schemaName(b)));
}

// Spill of oversized outputs: the excess goes to a file in .reagent/truncations
// (7-day retention) instead of being lost; the model gets the preview plus the
// path and can grep/read_file only the slice it cares about.
const _SPILL_KEEP_SECONDS = 7 * 24 * 3600;

// Test escape hatch (mirrors shell._setMaxOutput): lets the spill tests lower the
// cap without touching config.MAX_TOOL_OUTPUT (a module const).
let _maxToolOutputOverride: number | null = null;
export function _setMaxToolOutput(value: number | null): void {
  _maxToolOutputOverride = value;
}
function effectiveMaxToolOutput(): number {
  return _maxToolOutputOverride ?? MAX_TOOL_OUTPUT;
}

// Aggregate tool-output budget per TURN (Claude Code pattern): even when every
// individual output stays under MAX_TOOL_OUTPUT, a turn full of near-cap
// outputs would flood the history. Once the turn's accumulated chars
// (TurnContext.toolOutputChars) would exceed the budget, further large outputs
// get an aggressive head-tail cut, with the full text spilled as usual.
export const TURN_OUTPUT_BUDGET = 300_000;
// Preview kept when the budget is exceeded; outputs at or below this size pass
// through untouched (the note would be pure noise on small results).
const BUDGET_PREVIEW_CAP = 2_000;

let _turnOutputBudgetOverride: number | null = null;
export function _setTurnOutputBudget(value: number | null): void {
  _turnOutputBudgetOverride = value;
}
function effectiveTurnOutputBudget(): number {
  return _turnOutputBudgetOverride ?? TURN_OUTPUT_BUDGET;
}

/**
 * Truncates through the MIDDLE, preserving start and end (Codex style): 2/3 head,
 * 1/3 tail, with a marker of what was omitted. The end is where the errors of a
 * long test run live.
 */
export function headTail(output: string, limit: number): string {
  if (output.length <= limit) return output;
  const head = Math.floor((limit * 2) / 3);
  const tail = limit - head;
  const omitted = output.length - head - tail;
  return (
    output.slice(0, head) +
    `\n... [${omitted} chars omitted] ...\n` +
    output.slice(output.length - tail)
  );
}

/**
 * Saves the full output to .reagent/truncations (running the retention sweep)
 * and returns the spill path relative to the root, or null when it cannot be
 * saved (disk/permission).
 */
function spillToFile(name: string, output: string): string | null {
  const spillDir = path.join(config.stateDir, "truncations");
  let spillPath: string;
  try {
    fs.mkdirSync(spillDir, { recursive: true });
    const now = Date.now() / 1000;
    for (const entry of fs.readdirSync(spillDir)) {
      // retention: deletes spills older than 7 days
      if (!entry.endsWith(".txt")) continue;
      const old = path.join(spillDir, entry);
      try {
        const st = fs.statSync(old);
        if (now - st.mtimeMs / 1000 > _SPILL_KEEP_SECONDS) fs.unlinkSync(old);
      } catch {
        // ignore failure on an individual spill
      }
    }
    spillPath = path.join(spillDir, `${name}-${randomBytes(4).toString("hex")}.txt`);
    fs.writeFileSync(spillPath, output, "utf8");
  } catch {
    return null;
  }
  return path.relative(config.root, spillPath);
}

/** Saves the full output to .reagent/truncations and returns preview plus hint. */
function spillOversized(name: string, output: string): string {
  const cap = effectiveMaxToolOutput();
  const rel = spillToFile(name, output);
  if (rel === null) {
    // nowhere to save (disk/permission): degrade to the simple truncation
    return headTail(output, cap) + "\n... (output truncated)";
  }
  return (
    headTail(output, cap) +
    `\n... (output truncated: ${output.length} chars total; full output saved to ${rel}; ` +
    "grep it or read_file with offset/limit if you need the rest)"
  );
}

/** Aggressive cut used once the turn's aggregate output budget is exceeded. */
function spillOverBudget(name: string, output: string): string {
  const rel = spillToFile(name, output);
  const where = rel === null ? "" : `; full output saved to ${rel}`;
  return (
    headTail(output, BUDGET_PREVIEW_CAP) +
    `\n(output aggressively truncated: turn output budget exceeded${where})`
  );
}

/** Runs a tool and returns the result as text (never raises). */
export async function dispatch(name: string, argumentsJson: string): Promise<string> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argumentsJson || "{}");
    args = (parsed ?? {}) as Record<string, unknown>;
  } catch {
    return "Error: arguments are not valid JSON";
  }
  let fn = REGISTRY[name];
  if (fn === undefined && typeof name === "string") {
    // Malformed call repair (opencode's experimental_repairToolCall): models
    // sometimes get the name case wrong ("Read_File"); map it to the real tool
    // instead of wasting the round with "unknown tool".
    fn = REGISTRY[name.toLowerCase()];
  }
  if (fn === undefined) return `Error: unknown tool '${name}'`;

  // Plan / bare / coordinator defense in depth: refuse tools outside the allowlist.
  if (!modeAllowsTool(config.permissionMode, name)) {
    return `Error: permission mode '${config.permissionMode}' does not allow tool '${name}'`;
  }
  if (
    config.coordinatorMode &&
    config.permissionMode !== "plan" &&
    config.permissionMode !== "bare" &&
    !COORDINATOR_MODE_TOOLS.has(name.toLowerCase()) &&
    !COORDINATOR_MODE_TOOLS.has(name)
  ) {
    return (
      `Error: coordinator mode does not allow tool '${name}' on the lead agent — ` +
      "delegate writes/bash to a worker via agent or parallel_agents"
    );
  }

  const pre = runPreToolUse(name, argumentsJson);
  if (pre.decision === "deny") {
    return `Error: ${pre.message || "PreToolUse hook denied this call"}`;
  }
  if (pre.decision === "ask") {
    const approved = await confirmHookAsk(name, pre.message ?? null);
    if (!approved) {
      return `Error: ${pre.message || "PreToolUse hook required confirmation"} — the user declined`;
    }
  }

  // A tool failure (thrown or error-prefixed result) routes to the
  // PostToolUseFailure hooks instead of PostToolUse.
  const failed = (error: string): string => {
    try {
      const r = runPostToolUseFailureHooks(name, argumentsJson, error);
      return withHookContext(error, pre.additionalContext, r.additionalContext);
    } catch {
      return error;
    }
  };

  let output: string;
  try {
    output = await fn(args);
  } catch (e) {
    if (e instanceof ToolError) return failed(`Error: ${e.message}`);
    if (e instanceof ArgumentError) return failed(`Argument error: ${e.message}`);
    const typ = e instanceof Error ? e.constructor.name : typeof e;
    const msg = e instanceof Error ? e.message : String(e);
    return failed(`Unexpected error: ${typ}: ${msg}`);
  }
  const ctx = currentTurn();
  // Projected size in history after the normal per-call cap: the budget must
  // compare against what would actually be returned, not the raw output.
  const projected = Math.min(output.length, effectiveMaxToolOutput());
  if (
    ctx !== undefined &&
    ctx.toolOutputChars + projected > effectiveTurnOutputBudget() &&
    output.length > BUDGET_PREVIEW_CAP
  ) {
    output = spillOverBudget(name, output);
  } else if (output.length > effectiveMaxToolOutput()) {
    output = spillOversized(name, output);
  }
  if (ctx !== undefined) ctx.toolOutputChars += output.length;
  if (output.startsWith("Error:") || output.startsWith("Argument error:")) {
    return failed(output);
  }
  log.info("tool result: %s -> %d chars", name, output.length);
  try {
    const post = runPostToolUse(name, argumentsJson, output);
    return withHookContext(output, pre.additionalContext, post.additionalContext);
  } catch {
    // hooks must never break the turn
  }
  return output;
}

/** Appends hook-provided context to a tool result as a system reminder. */
function withHookContext(
  output: string,
  ...contexts: Array<string | undefined>
): string {
  const extra = contexts.filter(Boolean).join("\n");
  if (!extra) return output;
  return `${output}\n\n<system-reminder>Hook context:\n${extra}</system-reminder>`;
}

/**
 * Runs read-only tools concurrently; returns {id: result}.
 *
 * Should only be called when the whole round is read-only (see agent), so there
 * is no read/write race. Promise.all preserves the calls' original order; the
 * caller appends the tool messages in the original order.
 */
export async function dispatchParallel(toolCalls: ToolCall[]): Promise<Record<string, string>> {
  // The model's own multi-agent fan-out pattern (several "agent" calls in one
  // round, explicitly encouraged by that tool's description) lands here, not
  // in parallel.ts/workflow.ts, so it must also respect maxAgentConcurrency:
  // otherwise a batch of "agent" calls bypasses that cap via the (usually
  // larger) maxToolConcurrency instead.
  const hasAgentCalls = toolCalls.some((tc) => tc.function.name === "agent");
  const limit = hasAgentCalls
    ? Math.min(config.maxToolConcurrency, config.maxAgentConcurrency)
    : config.maxToolConcurrency;
  const results = await mapLimit(toolCalls, limit, (tc) =>
    dispatch(tc.function.name, tc.function.arguments),
  );
  const out: Record<string, string> = {};
  toolCalls.forEach((tc, i) => {
    out[tc.id] = results[i]!;
  });
  return out;
}
