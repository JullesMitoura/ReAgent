# ReAgent Code (TypeScript)

*The agent that reacts to your code.*

A terminal and web coding agent, focused on **total privacy**: no data leaves your
machine except the calls to **your own LLM endpoint** (Azure OpenAI). No telemetry,
no intermediary services.

This is the TypeScript port of the original Python backend, built for Node with an
emphasis on the CLI. It keeps the exact same HTTP/SSE contract, so the existing React
front-end runs unchanged. Sessions are stored as one JSONL file per conversation
under `.reagent/sessions/` (the style of Codex): human-readable
and git-diffable, with no native or experimental dependency.

> Language: the interface and default responses are in **English**; the agent answers
> in the language of your question.

## How it works

An agentic loop: your message goes to the LLM together with a set of tools; the LLM
decides which to call (read/edit files, search, run commands, plan tasks); the results
go back to the LLM until it produces a final answer, shown in **streaming**. After each
edit to Python (`py_compile`) or JavaScript (`node --check`) files, a syntax check runs
automatically and returns errors to the LLM for self-correction. Three identical tool
calls in a row are blocked (doom-loop breaker) and the model is told to change approach.

## Requirements

- Node.js >= 22 (no native build step; sessions are plain JSONL files)
- An Azure OpenAI deployment
- Windows: the `bash` tool and `exec_command` require Git for Windows
  (https://git-scm.com/download/win) for its bundled `bash.exe` and coreutils
  (`ls`, `cat`, `grep`, `sed`, ...), which ReAgent auto-detects via common
  install locations and PATH. Shell and PTY execution now resolve Git Bash on
  Windows, and a `windows-latest` job in CI typechecks and builds the project
  on every push (the full test suite still runs on Linux only).

## Install and use

```bash
npm install            # install dependencies (root + ui workspace)
npm run build          # compile to dist/ and enable the `reagent` command

reagent                      # interactive REPL (the CLI)
reagent serve                # web UI: starts the server and opens the browser
reagent serve --port 9000    # web UI on another port
reagent serve --no-open      # start the server without opening the browser
reagent serve --host 0.0.0.0 # bind to all interfaces (containers)
reagent -p "do X"            # single non-interactive prompt
reagent -p "do X" --json     # NDJSON events on stdout (CI/scripts)
reagent --plan               # shorthand for --mode plan
reagent --mode acceptEdits   # default|plan|acceptEdits|bypass|bare
reagent --coordinator        # lead orchestrates via sub-agents
reagent exec "do X"          # non-interactive runner (JSON/scripts)
reagent exec "do X" --output-last-message out.txt   # also write just the final message to a file
reagent --dir <path>         # act on another project
reagent --continue           # resume the most recent session
reagent --sessions           # list saved sessions
reagent --yolo               # skip permission confirmations (mode=bypass)
```

A single command runs the CLI (`reagent`); a single command opens the web UI already
talking to the backend (`reagent serve`). `bin/reagent.js` only imports the compiled
`dist/` output, so it requires `npm run build` first.

During development, before building, use `npm run dev` instead:

```bash
npm run dev -- --help          # same as: reagent --help
npm run dev:server             # same as: reagent serve
```

The `.env` is loaded from the current working directory (same semantics as the Python
`load_dotenv()`), so run `reagent` from inside the project that holds your `.env`.

REPL commands: `/help`, `/new`, `/cd <path>`, `/sessions`, `/resume <n|id>`,
`/fork` (duplicate the current session and switch to the copy),
`/search <text>` (full-text history search), `/undo`, `/init`, `/compact`, `/todos`,
`/usage`, `/tools`, `/doctor`, `/mode [name]`, `/plan [on|off]`, `/coordinator [on|off]`,
`/spawn [proactive|explicit]` (sub-agent spawn policy),
`/verbosity [quiet|normal|verbose|debug]`, `/context`, `/exit`.
Attach files with `@path/to/file`.

**Permission modes:** `default` (ask), `plan` (read-only tools), `acceptEdits` (auto-approve
file mutations; still ask for bash), `bypass` (no prompts), `bare` (minimal tool surface).

Permission prompts offer **Allow once**, **Allow for session** (until the process
exits; not written to disk), **Always allow** (persisted in `.reagent/permissions.json`),
and **Deny**. Known-safe read-only commands run without any prompt on any OS; on
macOS they additionally run inside a Seatbelt sandbox. Other commands always ask first.

### Installing from npm

`reagent` is published on the public npm registry, no authentication required:

```bash
npm install -g reagent-code
```

The package is `reagent-code`; it installs a `reagent` command.

`node-pty` is an optional native dependency (used for persistent shell sessions); if a
machine has no C++ build toolchain it can fail to compile, `npm install` still succeeds,
just without that feature.

### Custom commands

A `.reagent/commands/<name>.md` file (per project) or `~/.reagent/commands/<name>.md`
(global; the project one wins) becomes the `/<name>` command in the REPL. The body is
the prompt sent to the agent, with `$ARGUMENTS` (the whole argument line), `$1`..`$9`
(positionals) and `@file` attachments. Optional frontmatter with `description:` shows
up in `/help`. Built-in commands take precedence.

## Tools

| Tool | Description | Permission |
|---|---|---|
| `read_file`, `list_dir`, `glob`, `grep` | read and search the project | free |
| `write_file`, `edit_file` | create/edit (with automatic diagnostics on .py/.js) | asks approval |
| `multi_edit` | several edits to the SAME file in one atomic call | asks approval |
| `apply_patch` | applies a unified diff patch to a file | asks approval |
| `delete_file` | removes a file from the project | asks approval |
| `bash` | shell commands, sandbox-first on macOS | asks approval |
| `exec_command`, `write_stdin` | persistent shell sessions across turns | asks approval; gated by `exec_sessions` |
| `task_output`, `task_stop` | manage background bash tasks | free |
| `todowrite`, `todoread` | the agent's task list (multi-step) | free |
| `question` | asks the user something mid-work | interactive |
| `exit_plan_mode` | submits a plan for approval | interactive |
| `remember` | appends a fact to the global user profile | free |
| `webfetch` | fetches URL content | **off by default** |
| `explore`, `plan`, `agent`, `parallel_agents` | delegate to typed sub-agents | **explore/plan/agent on by default**; parallel on by default |
| `skill` | load a SKILL.md playbook on demand | free |
| `workflow`, `tool_search`, `structured_output`, `send_message`, `list_agents` | opt-in orchestration tools | **off by default**, gated by `deferred_tools`/`workflow` |

`edit_file` locates the target through a cascade of strategies (exact match, trailing
whitespace, indentation, literal escapes, block anchor with similarity), so fewer edits
fail. `read_file` truncates lines over 2000 chars and suggests similar names when a file
does not exist.

## Sessions, history and context

- Conversations are stored as **one JSONL file per session** under
  `.reagent/sessions/` (first line is the envelope with title/timestamps, then one
  message per line). `/search` in the CLI and the search box in the front scan the
  files (fast at single-user scale). A prior SQLite `reagent.db` is migrated with
  `node scripts/migrate-sessions.mjs`; legacy per-session JSON files are converted
  automatically on first use.
- Sessions can be resumed (`--continue`, `/resume`) and deleted.
- When context passes the threshold, history is summarized automatically (or with
  `/compact`), using incremental compaction: the recent tail stays verbatim, only the
  old head becomes a structured briefing.
- `/usage` shows tokens spent, the percentage of the context window in use and the
  tokens served by the provider prefix cache.
- If an `AGENTS.md` exists at the root, it is injected into the agent
  instructions; generate one with `/init`.
- On first run in a directory, ReAgent generates a `.reagent/CONTEXT.md` project map
  (purpose, stack, commands, entry points), injected into the prompt and lazily
  regenerated when it goes stale.

## Server and web front

`reagent serve` starts the local API (bound to `127.0.0.1:8787` only), serves the built
front, and opens the browser at it, so the front-end comes up already talking to the
backend. The React front-end is a workspace under `reagent/ui/` (source); its build is
shipped inside the package as `reagent/static/` and rebuilt with `npm run build:web`.
The front connects in LIVE mode: streaming, tool chips, permission modal with diff,
interactive question modal, turn stop button, task panel, search and history deletion.

## Security

- **Directory sandbox**: file tools operate only inside the working directory.
- **Protected secrets**: `.env`, `.env.local`, `.env.production`, `.npmrc`, `.netrc`, SSH
  private keys (`id_rsa`, `id_ed25519`) and `credentials.json` are blocked for file tools,
  and `bash`/exec sessions run with a scrubbed environment (any variable whose name
  contains KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL/APIKEY/PRIVATE or an `AUTH` segment,
  plus `AZURE_OPENAI_*`, `DATABASE_URL` and `CONNECTION_STRING`, removed).
- **Protected state**: `.reagent/` is out of reach of file tools.
- **App source protection**: ReAgent's own source is read-only for the agent.
- **bash with approval**: known-safe read-only commands run without any prompt (any OS);
  other commands ask for approval, and a saved rule only covers the exact prefix and never
  authorizes a compound command (shell metacharacters force a new confirmation). On macOS,
  non-dangerous commands additionally run inside a Seatbelt sandbox.
- **Network**: the only egress is your Azure endpoint. `webfetch` is opt-in and, when on,
  blocks internal targets (loopback, private ranges, link-local, cloud metadata) against
  SSRF, revalidating each redirect.
- **Local server**: listens only on `127.0.0.1`, validates the `Host` header (against DNS
  rebinding), rejects `/api/*` requests from disallowed origins and runs one turn at a
  time per session.

## Configuration

Variables in `.env`: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_LLM` and
optionally `AZURE_OPENAI_API_VERSION`.

Optional config in `.reagent/config.json` (per project, re-read on `/cd`): `max_iterations`,
`context_window_tokens`, `compact_threshold_tokens`, `auto_approve`, `allow_dangerous`,
`webfetch`, `subagent`, `parallel_agents`, `sandbox_mode`, `sandbox_network`,
`exec_sessions`, `pack_context`, `protect_app_source`, `llm_timeout_seconds`,
`permission_timeout_seconds`, `max_completion_tokens`, `context_file`, and the
`tool_output_*` context-packing knobs. Autonomy/orchestration knobs: `permission_mode`
(default|plan|acceptEdits|bypass|bare), `plan_mode` (boot straight into plan mode),
`situational_git` (capped git status in the prompt, on by default), `coordinator`
(lead orchestrates via sub-agents), `worktree_agents` (parallel workers may use git
worktrees), `deferred_tools` (hide niche tools until unlocked via `tool_search`),
`workflow` (opt-in deterministic pipeline/parallel multi-agent tool),
`max_agent_concurrency` (sub-agents running at once) and `max_tool_concurrency`
(concurrency-safe tools dispatched at once).

## Development

```bash
npm test               # vitest suite (tools, permissions, sessions, sanitize, undo, ...)
npm run typecheck      # tsc --noEmit
npm run build          # compile to dist/
```

## Switching LLM

All model communication is isolated in [src/llm/client.ts](src/llm/client.ts). Any
OpenAI-compatible endpoint works by swapping the client there; the rest of the agent
does not change.

## Architecture

```
reagent/
├── src/
│   ├── cli/            # CLI + REPL (arg parsing, slash commands, @file attachments)
│   ├── server/         # HTTP API: SSE, permissions, stop, delete, search (Hono)
│   ├── protocol/       # Op/Event façade (CLI and server → core)
│   ├── agent/          # QueryEngine, stream, compact, shared tool-loop
│   ├── agents/         # Typed sub-agents (explore, plan, verification, worker, general-purpose, coordinator-worker, disk)
│   ├── modes.ts        # permission modes (plan / acceptEdits / bypass / bare)
│   ├── tools/          # registry, orchestration, StreamingToolExecutor
│   ├── prompts/        # modular prompt assets (core / tools / agents / reminders)
│   ├── skills/         # SKILL.md loader + skill tool
│   ├── hooks/          # Pre/Post tool, Stop, PreCompact command hooks
│   ├── lib/            # similarity, fnmatch, shell tokenizer, head-tail buffer, ...
│   ├── llm/            # model client (single network point) + error/retry classification
│   ├── agent.ts        # compatibility shim → agent/
│   ├── session.ts      # one-JSONL-file-per-session store + scan search
│   ├── context.ts      # context packing (stubs old tool outputs to save tokens)
│   ├── permissions.ts  # approvals with persistent rules
│   ├── sandbox.ts      # macOS Seatbelt profile for bash
│   └── config.ts       # env, config.json, working directory
├── static/             # built front served by the server (self-contained package)
├── ui/                 # React front-end source (Vite + React + Tailwind)
└── test/               # vitest suite (mirrors the Python test names 1:1)
```

The port mirrors the original Python backend module by module, then was refined
toward Codex-style patterns: thin surfaces over a protocol façade,
cache-aware prompt composition, typed agents with tool allowlists, and
concurrency-gated tool batches. Design decisions worth noting: Python
module-level globals become per-turn `TurnContext` scoped through
`AsyncLocalStorage`; the working directory is passed explicitly (never
`process.chdir`); persistence uses one JSONL file per session under
`.reagent/sessions/`, rewritten atomically (tmp + rename) on each save.
HTTP/SSE events stay stable so the React front is unchanged.
