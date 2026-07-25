/**
 * SIMULATED agent for the front-end demo.
 *
 * Emits the same event sequence the FastAPI backend emits via SSE:
 * tool start/end → todos → permission request → streamed tokens → usage.
 * Swapping this file for the real SSE client is the only integration step.
 */

import type { AgentBranchStatus, PermissionAnswer, PermissionRequest, Todo } from "../types";

export interface TurnHandlers {
  onToolStart: (id: string, name: string, args: string) => void;
  onToolEnd: (id: string, result: string) => void;
  onTodos: (todos: Todo[]) => void;
  askPermission: (req: PermissionRequest) => Promise<PermissionAnswer>;
  onToken: (chunk: string) => void;
  onUsage: (promptTokens: number, completionTokens: number) => void;
  // fan-out de sub-agents paralelos (opcionais: testes antigos nao os definem)
  onAgentsStart?: (agents: { id: string; title: string }[]) => void;
  onAgentUpdate?: (id: string, status: AgentBranchStatus, detail?: string) => void;
  onAgentsEnd?: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function streamText(text: string, onToken: (chunk: string) => void) {
  const words = text.split(/(?<= )/);
  for (const word of words) {
    onToken(word);
    await sleep(18);
  }
}

async function runTool(h: TurnHandlers, id: string, name: string, args: string, result: string, ms: number) {
  h.onToolStart(id, name, args);
  await sleep(ms);
  h.onToolEnd(id, result);
}

const EDIT_PREVIEW = `--- remove ---
def main():
    print("Reagent started.")

--- insert ---
def main():
    parser = argparse.ArgumentParser(prog="reagent")
    parser.add_argument("-p", "--prompt")
    args = parser.parse_args()
    run(args)`;

const FULL_REPLY = `I analyzed the project and applied the change to \`src/main.py\`.

**What was done:**

1. Read the project structure with \`list_dir\` and \`read_file\`
2. Added the argument parser to the entry point:

\`\`\`python
parser = argparse.ArgumentParser(prog="reagent")
parser.add_argument("-p", "--prompt")
\`\`\`

3. Verified nothing else depends on the old signature

If you want, I can run the tests to confirm everything passes.`;

const DENIED_REPLY = `No problem, **I didn't change any files**.

The change I was proposing for \`src/main.py\` is described above; if you change your mind, just ask and I'll apply it. I can also show a more detailed diff first.`;

export async function runMockTurn(userText: string, h: TurnHandlers): Promise<void> {
  await sleep(700);

  await runTool(h, "t1", "list_dir", '{"path": "."}', ".env.example\n.gitignore\nREADME.md\nrequirements.txt\nsrc/", 900);
  await sleep(300);

  await runTool(
    h,
    "t2",
    "read_file",
    '{"path": "src/main.py"}',
    '    1\timport argparse\n    2\t\n    3\tdef main():\n    4\t    print("Reagent started.")',
    800,
  );
  await sleep(300);

  const todos: Todo[] = [
    { content: "Explore the project structure", status: "completed" },
    { content: `Handle: "${userText.slice(0, 40)}${userText.length > 40 ? "…" : ""}"`, status: "in_progress" },
    { content: "Validate the result", status: "pending" },
  ];
  h.onTodos(todos);
  await runTool(h, "t3", "todowrite", '{"todos": [...]}', "Todo list updated (1/3 completed)", 400);
  await sleep(400);

  const answer = await h.askPermission({
    kind: "edit",
    action: "edit file src/main.py",
    preview: EDIT_PREVIEW,
    suggestion: "src/**",
  });

  if (answer === "deny") {
    await runTool(h, "t4", "edit_file", '{"path": "src/main.py", ...}', "User denied edit permission.", 300);
    h.onTodos(todos.map((t) => (t.status === "in_progress" ? { ...t, status: "pending" as const } : t)));
    await sleep(400);
    await streamText(DENIED_REPLY, h.onToken);
    h.onUsage(2840 + userText.length, 210);
    return;
  }

  await runTool(h, "t4", "edit_file", '{"path": "src/main.py", ...}', "Edited src/main.py: 1 replacement(s)", 900);
  await sleep(400);

  // fase de agents paralelos: fan-out de 2 sub-agents, o grafo mostra o fork
  h.onAgentsStart?.([
    { id: "a1", title: "Wire up the CLI flags" },
    { id: "a2", title: "Update the README" },
  ]);
  await sleep(500);
  h.onAgentUpdate?.("a1", "running", "edit_file src/main.py");
  await sleep(400);
  h.onAgentUpdate?.("a2", "running", "read_file README.md");
  await sleep(700);
  h.onAgentUpdate?.("a1", "done", "parser wired into main()");
  await sleep(600);
  h.onAgentUpdate?.("a2", "done", "usage section rewritten");
  h.onAgentsEnd?.();
  await sleep(300);

  h.onTodos(todos.map((t) => ({ ...t, status: "completed" as const })));
  await sleep(300);

  await streamText(FULL_REPLY, h.onToken);
  h.onUsage(3420 + userText.length, 480);
}
