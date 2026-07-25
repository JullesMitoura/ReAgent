// 1:1 mirror of tests/test_apply_patch.py: parser and atomic application.
//
// The conftest `project` fixture becomes beforeEach: config.setRoot(tmp) with
// autoApprove on and the original root restored at the end. The monkeypatch of
// permissions.confirm_file in the denial tests becomes a TurnContext with an
// injected permissionHandler (autoApprove off), the real production path of
// the port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChangeTracker } from "../src/changes.js";
import { config } from "../src/config.js";
import { APPLY_PATCH_SCHEMA, applyPatch } from "../src/tools/apply-patch.js";
import { ToolError } from "../src/tools/errors.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";
import type { PermissionHandler } from "../src/turn-context.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-apply-patch-"));
  config.setRoot(tmp);
  project = config.root; // realpath of tmp (macOS: /var -> /private/var)
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

function _patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") + "\n";
}

function write(rel: string, content: string): void {
  const p = path.join(project, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(project, rel), "utf8");
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(project, rel));
}

/** Expects ToolError and returns the message (equivalent of pytest.raises). */
async function toolErrorMessage(p: Promise<string>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return (err as Error).message;
  }
  throw new Error("expected ToolError, got success");
}

/** Runs applyPatch with an injected permissionHandler (denials). */
function applyWithHandler(patch: string, handler: PermissionHandler): Promise<string> {
  config.autoApprove = false;
  const ctx = newTurnContext({ permissionHandler: handler });
  return runWithTurn(ctx, () => applyPatch(patch));
}

describe("apply_patch", () => {
  // --- application ------------------------------------------------------------

  it("test_add_update_delete_num_patch_so", async () => {
    write("calc.py", "def soma(a, b):\n    return a + b\n");
    write("velho.txt", "tchau\n");
    const result = await applyPatch(_patch(
      "*** Add File: novo/ola.py",
      "+print('ola')",
      "*** Update File: calc.py",
      "@@ def soma(a, b):",
      "-    return a + b",
      "+    return a * b",
      "*** Delete File: velho.txt",
    ));
    expect(result.startsWith("applied patch: 1 added, 1 updated, 1 deleted")).toBe(true);
    expect(result).toContain("A novo/ola.py");
    expect(result).toContain("U calc.py");
    expect(result).toContain("D velho.txt");
    expect(read("novo/ola.py")).toBe("print('ola')\n");
    expect(read("calc.py")).toBe("def soma(a, b):\n    return a * b\n");
    expect(exists("velho.txt")).toBe(false);
  });

  it("test_move_renomeia_e_aplica_hunk", async () => {
    write("m.txt", "a\nb\nc\n");
    const result = await applyPatch(_patch(
      "*** Update File: m.txt",
      "*** Move to: dir/n.txt",
      " a",
      "-b",
      "+B",
      " c",
    ));
    expect(result).toContain("U m.txt (renamed to dir/n.txt)");
    expect(exists("m.txt")).toBe(false);
    expect(read("dir/n.txt")).toBe("a\nB\nc\n");
  });

  it("test_contexto_ambiguo_usa_primeira_ocorrencia", async () => {
    write("amb.txt", "x = 1\nmeio\nx = 1\n");
    await applyPatch(_patch(
      "*** Update File: amb.txt",
      "-x = 1",
      "+x = 2",
    ));
    expect(read("amb.txt")).toBe("x = 2\nmeio\nx = 1\n");
  });

  it("test_hunks_sequenciais_avancam_a_posicao", async () => {
    // the second hunk searches from the end of the first: equal occurrences in order
    write("seq.txt", "x = 1\nx = 1\n");
    await applyPatch(_patch(
      "*** Update File: seq.txt",
      "-x = 1",
      "+x = 2",
      "@@",
      "-x = 1",
      "+x = 3",
    ));
    expect(read("seq.txt")).toBe("x = 2\nx = 3\n");
  });

  it("test_cabecalho_arroba_ancora_a_busca", async () => {
    write("h.py", "def a():\n    return 1\n\ndef b():\n    return 1\n");
    await applyPatch(_patch(
      "*** Update File: h.py",
      "@@ def b():",
      "-    return 1",
      "+    return 2",
    ));
    expect(read("h.py")).toBe("def a():\n    return 1\n\ndef b():\n    return 2\n");
  });

  it("test_end_of_file_ancora_no_fim", async () => {
    write("f.txt", "a\nb\na\n");
    await applyPatch(_patch(
      "*** Update File: f.txt",
      "-a",
      "+z",
      "*** End of File",
    ));
    expect(read("f.txt")).toBe("a\nb\nz\n");
  });

  it("test_tolerancia_a_whitespace_a_direita", async () => {
    write("w.txt", "linha1   \nlinha2\n");
    await applyPatch(_patch(
      "*** Update File: w.txt",
      " linha1",
      "-linha2",
      "+linha3",
    ));
    // the context matches ignoring trailing ws and keeps the file's version
    expect(read("w.txt")).toBe("linha1   \nlinha3\n");
  });

  it("test_crlf_preservado", async () => {
    fs.writeFileSync(path.join(project, "c.txt"), Buffer.from("a\r\nb\r\n"));
    await applyPatch(_patch(
      "*** Update File: c.txt",
      "-b",
      "+B",
    ));
    expect(fs.readFileSync(path.join(project, "c.txt"))).toEqual(Buffer.from("a\r\nB\r\n"));
  });

  it("test_diagnostics_em_python_quebrado", async () => {
    const result = await applyPatch(_patch(
      "*** Add File: quebrado.py",
      "+def quebrado(:",
    ));
    expect(result).toContain("[diagnostics]");
  });

  it("test_undo_reverte_o_patch", async () => {
    write("u.txt", "original\n");
    const tracker = new ChangeTracker();
    tracker.startTurn();
    await runWithTurn(newTurnContext({ changes: tracker }), () =>
      applyPatch(_patch(
        "*** Add File: extra.txt",
        "+novo",
        "*** Update File: u.txt",
        "-original",
        "+alterado",
      )),
    );
    tracker.undo();
    expect(exists("extra.txt")).toBe(false);
    expect(read("u.txt")).toBe("original\n");
  });

  // --- tolerance ladder -------------------------------------------------------

  it("test_contexto_unicode_casa_arquivo_ascii", async () => {
    // patch with en dash, curly quotes and nbsp; file in ASCII (pass 4)
    write("uni.txt", 'note - "quoted" here\nplain\n');
    await applyPatch(_patch(
      "*** Update File: uni.txt",
      "-note – “quoted” here",
      "+changed",
    ));
    expect(read("uni.txt")).toBe("changed\nplain\n");
  });

  it("test_contexto_ascii_casa_arquivo_unicode", async () => {
    // the reverse: file with a typographic dash, patch in ASCII
    write("uni2.txt", "a — b\nplain\n");
    await applyPatch(_patch(
      "*** Update File: uni2.txt",
      "-a - b",
      "+x",
    ));
    expect(read("uni2.txt")).toBe("x\nplain\n");
  });

  it("test_match_exato_posterior_vence_rstrip_anterior", async () => {
    // line 0 only matches via rstrip; line 2 matches exactly: the exact pass wins
    write("ex.txt", "foo \nmid\nfoo\n");
    await applyPatch(_patch(
      "*** Update File: ex.txt",
      "-foo",
      "+bar",
    ));
    expect(read("ex.txt")).toBe("foo \nmid\nbar\n");
  });

  it("test_retry_sem_linha_vazia_final_do_padrao", async () => {
    // pattern ends in blank context that the file lacks: retry without it
    write("r.txt", "a\nb\n");
    await applyPatch(_patch(
      "*** Update File: r.txt",
      " a",
      "-b",
      "+B",
      " ",
    ));
    expect(read("r.txt")).toBe("a\nB\n");
  });

  it("test_hunk_so_adicoes_com_ancora_ausente_e_erro", async () => {
    write("anc.py", "def a():\n    pass\n");
    const msg = await toolErrorMessage(applyPatch(_patch(
      "*** Update File: anc.py",
      "@@ def missing():",
      "+    x = 1",
    )));
    expect(msg).toContain("anchor");
    expect(msg).toContain("def missing():");
    expect(read("anc.py")).toBe("def a():\n    pass\n"); // intact
  });

  it("test_hunk_so_adicoes_sem_ancora_continua_no_eof", async () => {
    write("tail.txt", "a\n");
    await applyPatch(_patch(
      "*** Update File: tail.txt",
      "+b",
    ));
    expect(read("tail.txt")).toBe("a\nb\n");
  });

  // --- diagnostic errors ------------------------------------------------------

  it("test_erro_no_match_tem_linha_e_bloco_completo", async () => {
    write("e2.py", "line1\nline2\nline3\n");
    const msg = await toolErrorMessage(applyPatch(_patch(
      "*** Update File: e2.py",
      "-missing_a",
      "-missing_b",
      "+x",
    )));
    expect(msg).toContain("searched from line 1");
    expect(msg).toContain("missing_a");
    expect(msg).toContain("missing_b");
  });

  it("test_erro_de_parse_ensina_sintaxe_valida", async () => {
    const msg = await toolErrorMessage(applyPatch(_patch("*** Frobnicar: x")));
    expect(msg).toContain("*** Add File:");
    expect(msg).toContain("'@@'");
    write("p.txt", "a\n");
    const msg2 = await toolErrorMessage(applyPatch(_patch("*** Update File: p.txt", "!bad")));
    expect(msg2).toContain("'@@'");
  });

  // --- atomicity --------------------------------------------------------------

  it("test_hunk_sem_match_nao_aplica_nada", async () => {
    write("a.py", "print(1)\n");
    const msg = await toolErrorMessage(applyPatch(_patch(
      "*** Add File: criado.txt",
      "+conteudo",
      "*** Update File: a.py",
      "-nao_existe()",
      "+outra()",
    )));
    expect(msg).toContain("hunk 1 in a.py");
    expect(exists("criado.txt")).toBe(false); // atomic: the add did not run
    expect(read("a.py")).toBe("print(1)\n");
  });

  it("test_negacao_aborta_o_patch_inteiro", async () => {
    write("e.txt", "um\n");
    const chamadas: [string, string, string | null][] = [];
    const result = await applyWithHandler(
      _patch(
        "*** Add File: novo.txt",
        "+oi",
        "*** Update File: e.txt",
        "-um",
        "+dois",
      ),
      async (kind, action, preview) => {
        chamadas.push([kind, action, preview]);
        return "deny";
      },
    );
    expect(result.startsWith("User denied")).toBe(true);
    expect(exists("novo.txt")).toBe(false);
    expect(read("e.txt")).toBe("um\n");
    expect(chamadas[0]![0]).toBe("write"); // one request per file, in patch order
    expect(chamadas[0]![2]).toContain("+oi"); // short diff preview
  });

  it("test_negacao_parcial_tambem_e_atomica", async () => {
    // approves the first file, denies the second: not even the approved one is written
    write("e.txt", "um\n");
    const respostas: ("once" | "deny")[] = ["once", "deny"];
    const result = await applyWithHandler(
      _patch(
        "*** Add File: novo.txt",
        "+oi",
        "*** Update File: e.txt",
        "-um",
        "+dois",
      ),
      async () => respostas.shift()!,
    );
    expect(result.startsWith("User denied")).toBe(true);
    expect(exists("novo.txt")).toBe(false);
    expect(read("e.txt")).toBe("um\n");
  });

  // --- parser -----------------------------------------------------------------

  const MALFORMADOS: [string, string][] = [
    ["sem marcador", "must start with"],
    ["*** Begin Patch\n*** Update File: x.py\n-a\n+b\n", "must end with"],
    [_patch("*** Frobnicar: x"), "unexpected line"],
    [_patch("*** Add File: a.txt", "linha sem sinal"), "must start with '+'"],
    [_patch(), "no file operations"],
    [_patch("*** Update File: a.py"), "has no hunks"],
    [_patch("*** Move to: b.py"), "Move to"],
    [_patch("*** Delete File: a.txt", "*** Delete File: a.txt"), "more than once"],
  ];

  for (const [patch, motivo] of MALFORMADOS) {
    it(`test_patch_malformado[${motivo}]`, async () => {
      const msg = await toolErrorMessage(applyPatch(patch));
      expect(msg.startsWith("invalid patch")).toBe(true);
      expect(msg).toContain(motivo);
    });
  }

  it("test_erro_de_sintaxe_nao_toca_arquivos", async () => {
    write("a.txt", "intacto\n");
    await toolErrorMessage(applyPatch(
      _patch("*** Update File: a.txt", "-intacto", "+mudado", "*** Frobnicar: x"),
    ));
    expect(read("a.txt")).toBe("intacto\n");
  });

  // --- contrato do schema -----------------------------------------------------

  it("test_schema_contrato", () => {
    const schema = APPLY_PATCH_SCHEMA as {
      type: string;
      function: {
        name: string;
        description: string;
        parameters: { properties: Record<string, unknown>; required: string[] };
      };
    };
    expect(schema.type).toBe("function");
    const fn = schema.function;
    expect(fn.name).toBe("apply_patch");
    expect(fn.parameters.required).toEqual(["patch"]);
    expect("patch" in fn.parameters.properties).toBe(true);
    expect(fn.description).toContain("*** Begin Patch");
    expect(fn.description).toContain("edit_file"); // preferivel a varios edit_file
  });
});
