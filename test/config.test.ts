// 1:1 mirror of tests/test_config.py: COMPACT_THRESHOLD derivation and visible
// errors. Each test writes a .reagent/config.json in a tmp and calls
// setRoot to reread; the afterEach restores the original root (fixture `project`).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";

const originalRoot = config.root;
let project: string;
const cleanups: string[] = [];

function mktemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function writeCfg(root: string, data: Record<string, unknown> | string): void {
  const state = path.join(root, ".reagent");
  fs.mkdirSync(state, { recursive: true });
  const text = typeof data === "string" ? data : JSON.stringify(data);
  fs.writeFileSync(path.join(state, "config.json"), text);
}

beforeEach(() => {
  project = mktemp("reagent-project-");
  config.setRoot(project);
});

afterEach(() => {
  vi.restoreAllMocks();
  config.setRoot(originalRoot);
  while (cleanups.length) {
    fs.rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

describe("config", () => {
  // --- compact-threshold derived from the window ----------------------------

  it("test_threshold_deriva_da_janela", () => {
    writeCfg(project, { context_window_tokens: 200_000 });
    config.setRoot(project);
    expect(config.contextWindowTokens).toBe(200_000);
    expect(config.compactThreshold).toBe(125_000); // 62.5% of the window
  });

  it("test_threshold_default_continua_80k", () => {
    writeCfg(project, {});
    config.setRoot(project);
    expect(config.contextWindowTokens).toBe(128_000);
    expect(config.compactThreshold).toBe(80_000);
  });

  it("test_threshold_explicito_clampa_em_90_por_cento", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeCfg(project, { compact_threshold_tokens: 100_000, context_window_tokens: 64_000 });
    config.setRoot(project);
    expect(config.compactThreshold).toBe(57_600); // 0.9 * 64000
    expect(config.configErrors.some((w) => w.includes("compact_threshold_tokens"))).toBe(true);
    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("clampado");
  });

  it("test_threshold_explicito_abaixo_do_cap_fica_intacto", () => {
    writeCfg(project, { compact_threshold_tokens: 50_000, context_window_tokens: 64_000 });
    config.setRoot(project);
    expect(config.compactThreshold).toBe(50_000);
    expect(config.configErrors).toEqual([]);
  });

  // --- visible config errors ------------------------------------------------

  it("test_json_invalido_usa_defaults_e_avisa", () => {
    writeCfg(project, '{"max_iterations": 10,,}');
    config.setRoot(project);
    expect(config.maxIterations).toBe(40); // defaults preserved
    expect(config.configErrors).toHaveLength(1);
    expect(config.configErrors[0]).toContain("linha");
    expect(config.configErrors[0]).toContain("coluna");
  });

  it("test_chave_desconhecida_sugere_a_mais_proxima", () => {
    writeCfg(project, { max_iterationz: 10 });
    config.setRoot(project);
    expect(
      config.configErrors.some((w) => w.includes("max_iterationz") && w.includes("max_iterations")),
    ).toBe(true);
    expect(config.maxIterations).toBe(40); // the wrong key configures nothing
  });

  it("test_bool_como_string_nao_vira_true", () => {
    // Boolean("false") would be true: the typed getter rejects and warns.
    writeCfg(project, { auto_approve: "false" });
    config.setRoot(project);
    expect(config.autoApprove).toBe(false);
    expect(config.configErrors.some((w) => w.includes("auto_approve"))).toBe(true);
  });

  it("test_int_invalido_cai_no_default_sem_crash", () => {
    writeCfg(project, { max_iterations: "forty" });
    config.setRoot(project); // a wrong type must never crash setRoot
    expect(config.maxIterations).toBe(40);
    expect(config.configErrors.some((w) => w.includes("max_iterations"))).toBe(true);
  });

  it("test_config_valida_sem_avisos", () => {
    writeCfg(project, { max_iterations: 20, auto_approve: true, webfetch: false });
    config.setRoot(project);
    expect(config.configErrors).toEqual([]);
    expect(config.maxIterations).toBe(20);
  });

  it("test_erros_nao_vazam_para_projeto_limpo", () => {
    writeCfg(project, "{invalido");
    config.setRoot(project);
    expect(config.configErrors).not.toEqual([]);
    const clean = mktemp("reagent-clean-");
    config.setRoot(clean);
    expect(config.configErrors).toEqual([]);
  });

  it("test_bool_e_rejeitado_como_int", () => {
    // max_iterations=true must not become 1.
    writeCfg(project, { max_iterations: true });
    config.setRoot(project);
    expect(config.maxIterations).toBe(40);
    expect(config.configErrors.some((w) => w.includes("max_iterations"))).toBe(true);
  });

  // --- permission timeout ---------------------------------------------------

  it("test_permission_timeout_default_e_override", () => {
    writeCfg(project, {});
    config.setRoot(project);
    expect(config.permissionTimeout).toBe(300.0);
    writeCfg(project, { permission_timeout_seconds: 0 });
    config.setRoot(project);
    expect(config.permissionTimeout).toBe(0.0); // 0 = wait indefinitely
    expect(config.configErrors).toEqual([]);
  });
});
