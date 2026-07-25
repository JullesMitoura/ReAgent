# CONTRACTS.md: contracts between modules of the TypeScript port

Normative document for all agents of the port. Each module lists the TS path
and the public exports with exact signature, derived from the public functions
of the corresponding Python (source of truth: `/Users/mitoura/Desktop/CodeAgent/src`).
Do not invent divergent APIs; deviations must be recorded in the task return.

## 0. Global rules

1. Pure ESM, TypeScript strict, `moduleResolution: NodeNext`: EVERY relative
   import carries the `.js` suffix (`import { config } from "../config.js"`).
2. kebab-case files. Tests in `test/*.test.ts` mirroring the Python test names
   1:1 (`it("test_name_same_as_python")`).
3. Allowed npm dependencies: `openai`, `hono`, `@hono/node-server`,
   `node-pty`. Nothing else. SQLite via `node:sqlite` (`DatabaseSync`), builtin
   of Node 22+.
4. Strings from Appendix B of MIGRATION_SPEC are byte-for-byte contract (status,
   stubs, error messages, JSON schemas of the tools). The write arguments stub
   contains the character U+2014 between "disk" and "use": this document cannot
   contain the character; write it in the TS source as the escape `\u2014`.
5. Layer rule (imports from lower to upper forbidden):
   - Layer 0: `types.ts`, `config.ts`, `logs.ts`, `turn-context.ts`, `lib/*`,
     `protocol/*`. They import nothing above; `types.ts` and `lib/*` do not
     even import `config.ts`.
   - Layer 1: `command-safety.ts`, `sandbox.ts`, `permissions.ts`,
     `session.ts`, `changes.ts`, `context.ts`, `llm/*`,
     `attachments.ts`, `user-profile.ts`, `custom-commands.ts`,
     `project-context.ts`, `hooks/*`, `skills/load.ts`, `prompts/*` (assets).
     May import layer 0.
   - Layer 2: `tools/*`, `agents/*` (except runners that need the loop),
     `skills/tool.ts`. May import layers 0 and 1. Tools must NOT import
     `agent/query-engine.ts` or `cli/*` / `server/*`. Nested agents may import
     `agent/tool-loop.ts` (shared non-streaming loop; not the QueryEngine).
   - Layer 3: `agent/*` (query-engine, stream, compact, tool-loop),
     `agent.ts` (shim), `system-prompt.ts`, `prompts/compose.ts`,
     `agent-render.ts`. May import everything above. Do NOT import
     `server/*` or `cli/*`.
   - Layer 4: `server/*` and `cli/*`. Surfaces; they import anything.
6. Per-turn state goes in `TurnContext` (see `turn-context.ts`); the Python
   module globals that run across concurrent turns (changes, ask handler,
   question handler, parallel emitter, denial message) are FORBIDDEN as globals
   in TS.
7. cwd adaptation: `config.setRoot` does NOT do `process.chdir`. All code that
   in Python depended on cwd (shell spawn, relative path resolution, file walk)
   must use `config.root` explicitly.
8. Tools that request permission are async (the handler is a Promise). `dispatch`
   always `await`s the result; purely synchronous functions may return
   `string` directly.

### Advanced architecture (post-port)

| Path | Role |
|------|------|
| `src/protocol/` | Op/Event façade shared by CLI and server (`user_input`, `interrupt`, `steer`, `compact`) |
| `src/agent/` | QueryEngine, stream, compact, shared `runToolLoop` |
| `src/agents/` | Typed `AgentDefinition` registry (explore, plan, verification, worker, general-purpose, coordinator-worker + disk); fork/background/worktree cwd |
| `src/modes.ts` | Permission modes: `default` \| `plan` \| `acceptEdits` \| `bypass` \| `bare`; plan exit via `exit_plan_mode` |
| `src/prompts/` | Modular assets: `core/`, `tools/`, `agents/`, `reminders/` + `compose.ts` |
| `src/tools/orchestration.ts` | `ToolMeta` (`isConcurrencySafe`, permissions) + batch partition / `runToolBatches` (main + nested loops) |
| `src/tools/streaming-executor.ts` | Mid-stream early starts for concurrency-safe tools |
| `src/tools/plan-mode.ts` | `exit_plan_mode` — plan approval distinct from `question` |
| `src/tools/tool-search.ts` | Deferred tool activation when `deferred_tools` is enabled |
| `src/tools/workflow.ts` | Opt-in `workflow` pipeline/parallel multi-agent fan-out |
| `src/agent/query.ts` | `queryLoop` async generator; system-reminders + background `<task-notification>` drain |
| `src/skills/` | SKILL.md discovery + `skill` tool (progressive disclosure) |
| `src/hooks/` | PreToolUse / PostToolUse / Stop / PreCompact command hooks (`.reagent/hooks.json`) |

Coordinator mode (`--coordinator` / `/coordinator`) injects the phased Research → Synthesis →
Implementation → Verification playbook. Opt-in: `deferred_tools`, `workflow`, `worktree_agents`.
Future: MCP client, plugin marketplace.

Public compatibility shims: `src/agent.ts` re-exports `Agent`, status strings,
`TurnCancelled`, helpers. `buildSystemPrompt` remains at `src/system-prompt.ts`.
HTTP/SSE `ServerEvent` contract is unchanged.

## 1. Layer 0: foundation

### src/types.ts

```ts
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem { content: string; status: TodoStatus }

export type PermissionKind = "bash" | "write" | "edit" | "delete";
export type PermissionAnswer = "once" | "always" | "deny";
export type AskOutcome = PermissionAnswer | "cancelled" | "timeout";

export type AgentBranchStatus = "running" | "done" | "error";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  last_prompt_tokens: number;
  cached_prompt_tokens?: number;
}

export interface ErrorInfo { kind: string; http_status: number | null }

export interface ToolCallFunction { name: string; arguments: string }
export interface ToolCall { id: string; type: "function"; function: ToolCallFunction }
export type ChatRole = "system" | "user" | "assistant" | "tool";
export interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  [key: string]: unknown; // persisted history may have extra fields
}

export type ServerEvent = /* discriminated union of 13 types, snake_case */
  | { type: "token"; text: string }
  | { type: "status"; text: string }
  | { type: "usage"; prompt_tokens: number; completion_tokens: number;
      last_prompt_tokens: number; cached_prompt_tokens?: number; context_window?: number }
  | { type: "tool_start"; id: string; name: string; args: string }
  | { type: "tool_end"; id: string; result: string }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "permission_request"; id: string; kind: PermissionKind;
      action: string; preview: string | null; suggestion: string }
  | { type: "question_request"; id: string; question: string; options: string[] }
  | { type: "agents_start"; agents: { id: string; title: string }[] }
  | { type: "agent_update"; id: string; status: AgentBranchStatus; detail?: string }
  | { type: "agents_end" }
  | { type: "error"; message: string; error_info?: ErrorInfo }
  | { type: "done"; content: string; aborted?: true };
export type ServerEventType = ServerEvent["type"];
export type EmitFn = (ev: ServerEvent) => void;
```

### src/config.ts

Mutable singleton (same model as the Python `config` module). Recomputes
everything in `setRoot` in the same order as Python (window BEFORE the derived threshold).

```ts
export const MAX_TOOL_OUTPUT: number;                 // 30000
export const IGNORED_DIRS: ReadonlySet<string>;
export const PROTECTED_FILES: ReadonlySet<string>;
export const KNOWN_KEYS: ReadonlySet<string>;         // 29 keys
export const APP_PROTECTED_DIRS: string[];
export function loadDotenv(dir?: string): void;       // own parser, no override
export function realpathSafe(p: string): string;      // realpath tolerant of nonexistent

export class Config {
  root: string; stateDir: string; sessionsDir: string;
  permissionsFile: string; configFile: string;
  readonly configErrors: string[];
  maxIterations: number; compactThreshold: number; contextWindowTokens: number;
  autoApprove: boolean; allowDangerous: boolean;
  enableWebfetch: boolean; enableSubagent: boolean; subagentMaxSteps: number;
  enableParallel: boolean; parallelMaxAgents: number; parallelMaxSteps: number;
  sandboxMode: string; sandboxNetwork: boolean;
  enableExecSessions: boolean; execSessionMax: number;
  notifyCommand: string[];
  contextFile: boolean; contextCooldownHours: number;
  protectAppSource: boolean;
  llmTimeout: number; permissionTimeout: number; maxCompletionTokens: number;
  packContext: boolean;
  toolOutputKeepTurns: number; toolOutputProtectTokens: number;
  toolOutputPruneMinimum: number; toolOutputStubThreshold: number;
  toolOutputStubHead: number; compactKeepLast: number;
  forceAutoApprove: boolean; forceAllowDangerous: boolean;
  userProfileFile: string;                       // mutable (test fixture)
  get azureOpenAIEndpoint(): string;             // reads process.env on the fly
  get azureOpenAIKey(): string;
  get azureOpenAILLM(): string;
  get azureOpenAIApiVersion(): string;           // default "2024-12-01-preview"
  setRoot(p: string): string;                    // throws Error("directory not found: ...")
  setYolo(): void;
  setAllowDangerous(): void;
  isAppSource(p: string): boolean;
  validate(): void;                              // throws Error("Missing variables in .env: ...")
}
export const config: Config;
export const CONFIG_ERRORS: string[];            // SAME instance as config.configErrors
```

Tests `project` fixture (vitest equivalent of conftest):
`beforeEach`: `project = fs.mkdtempSync(...); config.setRoot(project);
config.autoApprove = true; config.contextFile = false;`
`afterEach`: `config.setRoot(originalRoot)` and tmp cleanup. Fixture
`_isolated_user_profile`: `config.userProfileFile = path.join(mkdtemp, "USER.md")`.

### src/logs.ts

```ts
export class Logger {
  readonly name: string;
  debug(msg: string, ...args: unknown[]): void;   // %s/%d/%f interpolation
  info(msg: string, ...args: unknown[]): void;
  warning(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
export class RootLogger extends Logger { level: number; readonly handlers: Handler[] }
export function getLogger(name: string): Logger;  // "" or "reagent" returns the root
export function redact(text: string): string;
```

Never writes to stdout/stderr. Rotation 1MB/3 backups in
`~/.reagent/logs/reagent.log`; level via `REAGENT_LOG_LEVEL`; IO failure
degrades to a null handler, never throws.

### src/turn-context.ts

```ts
export interface ChangeTracker {          // minimal type; implementation in changes.ts
  startTurn(): void;
  record(path: string, before: Buffer | null): void;
  undo(): string;
}
export type PermissionHandler = (kind: PermissionKind, action: string,
  preview: string | null, suggestion: string) => Promise<AskOutcome>;
export type QuestionHandler = (question: string, options: string[]) => Promise<string>;
export interface TurnContext {
  changes: ChangeTracker | null;
  permissionHandler: PermissionHandler | null;
  questionHandler: QuestionHandler | null;
  steerQueue: string[];
  cancel: { set: boolean };
  emit: EmitFn | null;
}
export function newTurnContext(partial?: Partial<TurnContext>): TurnContext;
export const turnStorage: AsyncLocalStorage<TurnContext>;
export function runWithTurn<T>(ctx: TurnContext, fn: () => T): T;
export function currentTurn(): TurnContext | undefined;
```

Usage: the turn owner (server worker, REPL, exec) creates the context, calls
`runWithTurn(ctx, () => agent.runEvents(...))` and keeps the reference to
`ctx.changes` for the post-turn `/undo`. Tools and permissions read via
`currentTurn()`. Parallel sub-agents create a DERIVED context per worker
(isolated denial message and handlers; `changes: null`).

### src/lib/similarity.ts

Ratcliff-Obershelp (gestalt matching), reproducing `difflib`:

```ts
export function ratio(a: string, b: string): number;              // SequenceMatcher.ratio()
export function getCloseMatches(word: string, possibilities: Iterable<string>,
  n?: number, cutoff?: number): string[];                          // defaults n=3, cutoff=0.6
```

Serves edit-cascade (threshold 0.7), file-name suggestion in `file not found`
and similar. Do NOT use Levenshtein here (it would change the thresholds); the
small Levenshtein for config-key suggestion is private to config.ts.

### src/lib/env-scrub.ts

```ts
export function scrubbedEnv(): NodeJS.ProcessEnv;
```

Copy of `process.env` without: the exact keys `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_KEY`, `AZURE_OPENAI_LLM`, `AZURE_OPENAI_API_VERSION` and any key
whose uppercase name contains `KEY`, `SECRET`, `TOKEN`, `PASSWORD` or
`CREDENTIAL`. Fail-closed. Used by shell and exec-sessions.

### src/lib/shell-tokenizer.ts

```ts
export class UnbalancedQuotesError extends Error {}
export function tokenize(cmd: string): string[];
```

POSIX single/double quotes; operators `( ) ; < > | &` become their own tokens
(runs like `&&`, `||`, `2>&1` grouped as in shlex with punctuation_chars);
unbalanced quotes throw `UnbalancedQuotesError`. Consumers:
command-safety (unsafe/non-dangerous token per the classifier) and
permissions (`hasShellOperators` counts unbalanced quotes as an operator).

### src/lib/head-tail-buffer.ts

Mirror of `_HeadTailBuffer` from exec_sessions.py (also used by the shell
pipes):

```ts
export class HeadTailBuffer {
  constructor(cap: number);            // freezes the first cap/2 + rolling window
  append(text: string): void;
  take(): string;                      // increment since the last take; resets the cursor
}
export function capHeadTail(text: string, cap: number): string;
// cuts keeping start and end with marker "\n... [{omitted} chars omitted] ...\n"
```

### src/lib/doom-loop.ts

```ts
export const DOOM_LOOP_THRESHOLD: number;   // 3
export function doomLoopMessage(name: string): string;  // literal text from Appendix B
export class DoomLoopDetector {
  constructor(threshold?: number);
  record(name: string, argumentsJson: string): boolean;
  // true when the SAME call (name + identical arguments) repeated
  // `threshold` times in a row; any different call resets the count
}
```

## 2. Layer 1: pure core, persistence and permissions

### src/llm/errors.ts

```ts
export class StreamTruncatedError extends Error {}
export class ContentFilterError extends Error {}
export class ContextWindowExceededError extends Error {}
export interface Classification { kind: string; http_status: number | null; retryable: boolean }
export function classify(err: unknown): Classification;
// kinds: quota | content_filter | context_length | rate_limit | overloaded | connection | unknown
export function isContextLengthError(err: unknown): boolean;
export function isRetryable(err: unknown): boolean;
export function userMessage(err: unknown): string;      // prefix by type, cap 2000 on the detail
export function retryDelay(err: unknown, attempt: number): number;  // SECONDS (float)
```

`retryDelay`: precedence header retry-after-ms > header retry-after (s) >
regex on the text/body > backoff `0.5 * 2^attempt` with cap 30s (local); server
cap 120s; jitter 0.9..1.1 applied AFTER the cap. openai-node SDK errors:
`APIError`/`APIConnectionError` from the `openai` package play the role of
APIStatusError/httpx.

### src/llm/client.ts

```ts
export function getClient(): AzureOpenAI;   // from the openai package; timeout config.llmTimeout*1000, maxRetries 5
export function chat(messages: ChatMessage[], tools?: object[] | null,
  stream?: boolean): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>>;
```

`chat`: `model: config.azureOpenAILLM`; `max_completion_tokens` only when
`config.maxCompletionTokens > 0`; with `stream: true` it includes
`stream_options: { include_usage: true }`. config's `validate()` is called by
the surfaces, not here.

### src/context.ts

```ts
export const SUMMARY_MARKER: string;
export function packMessages(messages: ChatMessage[], keepTurns?: number | null): ChatMessage[];
// returns the SAME array reference when nothing was trimmed (prefix cache)
export function truncateToolOutputs(messages: ChatMessage[], maxChars: number): ChatMessage[];
export function estimateTokens(messages: ChatMessage[]): number;
// JSON.stringify(m).length >> 2 per message (documented: close, not identical to the Python repr)
export function protectBoundary(messages: ChatMessage[], keepTurns: number): number;
```

### src/command-safety.ts

```ts
export function isSafeCommand(command: string): boolean;      // known read-only
export function isDangerousCommand(command: string): boolean; // destructive
```

Fail-closed in both; tables identical to Python; internal `_MAX_DEPTH = 8`.

### src/sandbox.ts

```ts
export function available(): boolean;   // darwin + /usr/bin/sandbox-exec + config.sandboxMode "auto"
export function buildProfile(): string; // SBPL string by string, allow order before deny
export function shellArgv(command: string): string[];
export function wrap(command: string): string[];
export function looksLikeDenial(exitCode: number | null, output: string): boolean;
```

### src/permissions.ts

```ts
export const BANNED_SUGGESTIONS: ReadonlySet<string>;
export function denialMessage(defaultMsg: string): string;  // consumes (2nd read = default)
export function hasShellOperators(cmd: string): boolean;
export function bashRuleSuggestion(command: string): string;
export function loadRules(): { bash: string[]; write: string[]; edit: string[]; delete: string[] };
export function saveRule(kind: string, pattern: string): void;  // refuses banned
export function migrateBannedRules(): void;  // one-shot with marker .reagent/permissions_migrated
export function confirmBash(command: string): Promise<boolean>;
export function confirmFile(kind: "write" | "edit" | "delete", action: string,
  relPath: string, preview?: string | null): Promise<boolean>;
```

The Python global `ask_handler` becomes `currentTurn()?.permissionHandler`;
without a turn or with a null handler, it falls back to the tty prompt (CLI) or
denies on non-tty stdin. The per-thread denial message becomes an internal
field kept in the TurnContext (never a module global). A single async mutex
serializes rule checking + prompting (the "always" of the first request
auto-approves the concurrent one that was waiting). File matching: fnmatch port
with semantics documented in section 4.5 of MIGRATION_SPEC (suggestions
generated as `dir/**`).

### src/session.ts

```ts
export class SessionNotFoundError extends Error {}  // mapped to 404 in the server
export class Session {
  id: string; title: string;
  messages: ChatMessage[]; todos: TodoItem[]; usage: Usage;
  createdAt: number; updatedAt: number;             // epoch in SECONDS (float)
  constructor(fields: { id: string; title?: string; messages?: ChatMessage[];
    todos?: TodoItem[]; usage?: Usage; createdAt?: number; updatedAt?: number });
  static new(): Session;                            // id YYYYMMDD-HHMMSS-4hex
  save(): void;
  static load(sid: string): Session;                // throws SessionNotFoundError
  static fork(sid: string): Session;                // title "<original> (fork)"
  static list(): { id: string; title: string; messages: number; updated_at: number }[];
  static search(query: string, limit?: number):     // limit default 20
    { id: string; title: string; messages: number; updated_at: number; snippet: string }[];
  static delete(sid: string): boolean;
  static deleteAll(): number;
  static latestId(): string | null;
}
```

Implementation: one JSONL file per session under `.reagent/sessions/<id>.jsonl`
(line 1 envelope `{v, id, title, created_at, updated_at, message_count, todos,
usage}`, then one raw chat message per line). Each save rewrites the file
atomically (tmp + rename), preserving the original `created_at`. `list` reads
only the first line of each file; `search` scans the files (no FTS index; fast at
single-user scale). Legacy pre-SQLite `<id>.json` files are converted in place to
`<id>.jsonl` on first use. A prior SQLite `reagent.db` is migrated by
`scripts/migrate-sessions.mjs` (the only place `node:sqlite` is used), not by the
app.

### src/changes.ts

```ts
export class ChangeTracker {          // implements the interface from turn-context.ts
  startTurn(): void;
  record(path: string, before: Buffer | null): void;  // oldest snapshot per file
  undo(): string;                     // literal messages from Appendix B
}
```

No global instance: the turn owner creates and injects it via
`TurnContext.changes`; write tools record via
`currentTurn()?.changes?.record(...)`. The REPL keeps the instance across turns
for `/undo`.

### src/attachments.ts

```ts
export const ATTACHMENT_RE: RegExp;         // /(?<!\w)@([^\s@]+)/g
export const MAX_ATTACHMENT_BYTES: number;  // 262144
export function attachReference(target: string): string;
export function expand(text: string): string;
```

### src/user-profile.ts

```ts
export function ensure(): void;             // creates template; never throws
export function load(): string;
export function remember(fact: string): string;  // caps 6000/300, dedup per line
```

Path: `config.userProfileFile` (tests swap the field).

### src/custom-commands.ts

```ts
export interface CustomCommand { description: string; body: string }
export function loadCommands(): Record<string, CustomCommand>;
// global ~/.reagent/commands/*.md overridden by .reagent/commands/*.md; name ^[a-zA-Z0-9_-]+$
export function expandArguments(body: string, args: string): string;  // $ARGUMENTS/$1..$9, no shell
```

### src/project-context.ts

```ts
export const GENERATOR_VERSION: number;     // 2; bump to 3 if the body format changes
export function isStale(): boolean;
export function markStale(): void;
export function noteChange(path: string, structural: boolean): void;
export function generate(emit?: EmitFn | null): Promise<string | null>;  // never throws
export function ensure(emit?: EmitFn | null): Promise<void>;
export function load(): string;
```

## 3. Layer 2: tools

### src/tools/errors.ts

```ts
export class ToolError extends Error {}      // dispatch maps to "Error: {msg}"
export class ArgumentError extends Error {}  // dispatch maps to "Argument error: {msg}"
```

`ArgumentError` replaces the Python kwargs TypeError: each tool validates its
own required arguments/types and throws `ArgumentError` with a clear message.
Re-exported by `tools/index.ts` and importable from any tool.

### src/tools/index.ts

```ts
export { ToolError, ArgumentError } from "./errors.js";
export type ToolFn = (args: Record<string, unknown>) => string | Promise<string>;
export const REGISTRY: Record<string, ToolFn>;   // 17 tools, names identical to Python
export const READ_ONLY_TOOLS: ReadonlySet<string>;
// {"read_file","list_dir","glob","grep","todoread","webfetch"}
export const TOOL_SCHEMAS: object[];             // JSON schemas copied verbatim
export function activeSchemas(): object[];       // re-evaluated per call (gating by config)
export function headTail(output: string, limit: number): string;  // 2/3 head + 1/3 tail
export function dispatch(name: string, argumentsJson: string): Promise<string>;  // never throws
```

`dispatch`: invalid JSON returns `"Error: arguments are not valid JSON"`;
unknown name tries `name.toLowerCase()` before
`"Error: unknown tool '{name}'"`; `ToolError` becomes `"Error: {msg}"`,
`ArgumentError` becomes `"Argument error: {msg}"`, the rest becomes
`"Unexpected error: {Type}: {msg}"` (Type = `err.constructor.name`). Output
above `MAX_TOOL_OUTPUT` goes through the spill to `.reagent/truncations/`
(7-day retention) with the literal text from Appendix B.

### src/tools/files.ts

```ts
export function resolvePath(path: string): string;     // realpath before the containment check
export function assertWritable(p: string): void;       // throws ToolError (texts from Appendix B)
export function readFile(path: string, offset?: number, limit?: number): string;  // 1, 2000
export function writeFile(path: string, content: string): Promise<string>;
export function editFile(path: string, oldString: string, newString: string,
  replaceAll?: boolean): Promise<string>;
export function multiEdit(path: string, edits: { old_string: string;
  new_string: string; replace_all?: boolean }[]): Promise<string>;
export function deleteFile(path: string): Promise<string>;
export function listDir(path?: string): string;        // default "."
```

Dominant newline detection (CRLF re-emitted on write), post-edit diagnostics
(`python3 -m py_compile` if python is on PATH, `node --check`), undo snapshot
via `currentTurn()?.changes`.

### src/tools/edit-cascade.ts

```ts
export function findReplacement(text: string, old: string, replacement: string,
  replaceAll?: boolean): [string, number];   // throws ToolError (ambiguous / not found)
```

5 strategies in the Python order; uses `lib/similarity.ratio` (threshold 0.7 of
the block anchor).

### src/tools/search.ts

```ts
export const MAX_RESULTS: number;            // 100
export const MAX_GREP_FILE_BYTES: number;    // 2000000
export function globFiles(pattern: string): string;   // matches rel path OR basename
export function grep(pattern: string, path?: string, include?: string | null): string;
```

### src/tools/shell.ts

```ts
export const MAX_OUTPUT: number;             // 2000000
export function bash(command: string, timeout?: number): Promise<string>;  // default 120
export function killActive(): number;        // kills active groups; returns how many
```

`spawn` detached (own group), `stdio: ["ignore", "pipe", "pipe"]`, env from
`scrubbedEnv()`, HeadTailBuffer per pipe, UTF-8 carry, SIGKILL timeout on the
group with 2s drain, exit by signal `128+sig (NAME)`, sandbox-first flow.

### src/tools/exec-sessions.ts

```ts
export const BUFFER_CAP: number;             // 1000000
export const POLL_CAP: number;               // 30000
export function execCommand(command: string, yieldTimeMs?: number,
  sessionId?: number | null): Promise<string>;         // default 10000
export function writeStdin(sessionId: number, chars: string,
  yieldTimeMs?: number): Promise<string>;              // default 3000
export function listSessions(): string;
export function cleanup(): void;             // registered on exit/SIGTERM/SIGINT
export const EXEC_COMMAND_SCHEMA: object;
export const WRITE_STDIN_SCHEMA: object;
```

node-pty with gate: unsupported platform/config returns
`"Error: exec sessions are disabled on this platform/config"`.

### src/tools/apply-patch.ts

```ts
export function applyPatch(patch: string): Promise<string>;
export const APPLY_PATCH_SCHEMA: object;
```

### src/tools/subagent.ts

```ts
export function explore(description: string, prompt: string): Promise<string>;
```

### src/tools/parallel.ts

```ts
export function parallelAgents(tasks: { title: string; prompt: string }[]): Promise<string>;
```

Emitter via `currentTurn()?.emit` (NEVER a module global); the Python
`set_emitter`/`clear_emitter` do not exist in the port.

### src/tools/todo.ts

```ts
export function setTodos(todos: TodoItem[]): void;
export function getTodos(): TodoItem[];
export function render(todos?: TodoItem[]): string;    // icons ○ ◐ ●
export function todoWrite(todos: TodoItem[]): string;  // "Todo list updated (d/N completed):"
export function todoRead(): string;
```

Module state as in Python (the Agent calls `setTodos(session.todos)` in the
constructor). Known race risk between concurrent sessions, accepted for parity;
see notes.

### src/tools/question.ts

```ts
export function question(question: string, options?: string[] | null): Promise<string>;
```

Handler via `currentTurn()?.questionHandler`; without a handler it returns
`"(user unavailable in non-interactive mode; choose the best option and proceed)"`.

### src/tools/web.ts

```ts
export const MAX_REDIRECTS: number;          // 5
export const MAX_RESPONSE_BYTES: number;     // 5242880
export function isBlockedIp(ip: string): boolean;      // exported for the SSRF tests
export function webfetch(url: string, maxChars?: number): Promise<string>;  // default 20000
```

## 4. Layer 3: agent

### src/system-prompt.ts

```ts
export function buildSystemPrompt(): string;  // conditional sections by config/sandbox
```

### src/agent.ts

```ts
export const STATUS_COMPACTING = "compacting context...";
export const STATUS_CTX_EXCEEDED = "context window exceeded; compacting and retrying...";
export const STATUS_CTX_EXHAUSTED = "context window exceeded even after compaction; try /compact or /clear";
export const STATUS_STREAM_RETRY = (n: number, i: number) =>
  `stream error; retrying in ${n}s (attempt ${i}/3)`;
export const STATUS_STREAM_PARTIAL = "stream interrupted; partial response kept";
export const STATUS_TRUNCATED = "response truncated by token limit";
export const STATUS_CONTENT_FILTER = "response blocked by content filter";
export const STATUS_STEERED = "user message received mid-turn";

export function resultSummary(result: string, limit?: number): string;   // default 120
export function isFailureResult(summary: string): boolean;
export class TurnCancelled extends Error {}   // raised by the server emit under cancel

export class Agent {
  session: Session;
  constructor(session?: Session);
  get messages(): ChatMessage[];
  reset(): void;
  runEvents(userInput: string, emit: EmitFn): Promise<string>;
  sanitize(): void;                          // repairs orphan tool_call/tool pairs
  compact(emit?: EmitFn | null): Promise<void>;
  hardTruncate(keep?: number, budget?: number | null): void;   // keep default 20
  trackUsage(usage: UsageLike | null): void;
  dispatchParallel(toolCalls: StreamToolCall[]): Promise<Record<string, string>>;  // id -> result
  drainSteering(emit: EmitFn): number;       // reads currentTurn()?.steerQueue
  streamCompletion(onToken: (text: string) => void): Promise<StreamResult>;
  notifyTurnComplete(): void;                // spawn detached unref, never throws
}
```

`StreamResult` and `StreamToolCall` are internal interfaces of `agent.ts` (not
exported), a faithful mirror of the Python `_stream_completion` tuple:
`StreamResult = { content: string; toolCalls: StreamToolCall[]; usage: UsageLike | null; finishReason: string | null }`
and `StreamToolCall = { id: string; name: string; arguments: string }`. `UsageLike`
is the raw usage format from the SDK (prompt/completion tokens + cache details).

The methods that were `_private` in Python become public without the underscore
(the tests exercise them directly). Three result caps: 30000 history
(dispatch), 3000 `tool_end` event, 2000 rollout (copy, without mutating the event).

### src/agent-render.ts

```ts
export function runTurn(agent: Agent, userInput: string): Promise<string>;
// terminal streaming render (own log-update-like + picocolors not available:
// use direct ANSI codes); spinner "thinking...", dim tool line, todos panel
```

## 5. Layer 4: surfaces

### src/server/main.ts

```ts
export function createApp(): Hono;           // all routes from section 3.1 of MIGRATION_SPEC
export function main(argv?: string[]): Promise<number | void>;  // --dir, --port (default 8787)
```

Bind ONLY 127.0.0.1. Errors `{"detail": "..."}`; invalid body 422. Anti
DNS-rebinding host check BEFORE any route; origin guard only on `/api/*`
(403 `{"detail": "origin not allowed"}`); CORS for the Vite origins (5173).
Route `/api/sessions/search` registered BEFORE `/api/sessions/:sid`.

### src/server/sse.ts

```ts
export function sseLine(ev: ServerEvent): string;   // `data: ${JSON.stringify(ev)}\n\n`
export interface RunningTurn { cancel: { set: boolean }; steer: string[] }
export class TurnRegistry {                  // atomic check-and-register (async mutex)
  tryStart(sid: string): RunningTurn | null; // null = 409 (turn already running)
  get(sid: string): RunningTurn | undefined;
  finish(sid: string): void;
}
```

### src/server/static.ts

```ts
export function staticDir(): string | null;
// static/ of the package (relative to import.meta.url) with code-front/dist fallback
```

### src/cli/main.ts

```ts
export function main(argv?: string[]): Promise<number | void>;
// native parseArgs; flags: --dir, -p/--prompt, --yolo, --allow-dangerous,
// --resume/--continue, exec as subcommand ("reagent exec")
```

The single shim `bin/reagent.js` does `await import("../dist/cli/main.js")`, calls
`main(process.argv.slice(2))` and propagates the numeric exit code; an exception prints
the stack to stderr and exits 1. Subcommands (`serve`, `exec`) are routed inside
`cli/main.ts`; `serve` dynamically imports `server/main.js` (`startServer`).

### src/cli/repl.ts

```ts
export function runRepl(agent: Agent): Promise<void>;
export function promptHistoryPath(): string;   // ~/.reagent/prompt_history (memory fallback)
export function makePromptSession(): PromptSessionLike;  // node:readline with @ completer
```

### src/cli/slash-commands.ts

```ts
export function handleCommand(cmd: string, agent: Agent, ui: ReplUI): Agent | null;
// null = command ended the REPL; Agent (same or new) = continue
export interface ReplUI { print(text: string): void; /* minimal render surface */ }
```

### src/cli/exec.ts

```ts
export function execMain(argv: string[]): Promise<number>;  // exit codes 0/1/130
// --json (NDJSON events), --output-last-message <file>,
// tokens aggregated in {type:"message"}
```

## 6. Binding implementation notes

1. `estimateTokens` uses `JSON.stringify` (not the Python repr): close values,
   not identical; the thresholds absorb it. Do NOT "fix" tests by copying
   numbers from Python that depend on the repr; recompute with the TS formula.
2. Attachment order of parallel tool results: ALWAYS the original order of the
   tool_calls, never the completion order.
3. `permission_request`/`question_request` are emitted DIRECTLY on the server's
   SSE queue (without going through the emit that raises TurnCancelled).
4. Rollout records BEFORE forwarding the emit; `usage` only the last of the turn.
5. The emit can THROW (TurnCancelled) at any time: runEvents' finally drains
   steering with an emit that swallows errors, saves the session, records the
   last usage in the rollout and fires the notify.
6. All file paths compared with the ROOT go through `realpathSafe` BEFORE the
   containment check (symlink escape).
7. Sessions are one JSONL file per conversation under `.reagent/sessions/`; no
   SQLite. The session file is rewritten atomically (tmp + rename) on save.
8. `tools/todo.ts` keeps module state (Python parity); the other per-turn
   dependencies must use TurnContext.
9. Texts in Appendix B of MIGRATION_SPEC prevail over any paraphrase of this
   document.
</content>
</invoke>
