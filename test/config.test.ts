// 1:1 mirror of tests/test_config.py: COMPACT_THRESHOLD derivation and visible
// errors. Each test writes a .reagent/config.json in a tmp and calls
// setRoot to reread; the afterEach restores the original root (fixture `project`).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { isProjectTrusted, trustProject } from "../src/trust.js";

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
    expect(written).toContain("clamped");
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
    expect(config.configErrors[0]).toContain("line");
    expect(config.configErrors[0]).toContain("column");
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
    // auto_approve: true from a config.json is exactly the security-gated
    // case (see "config: project trust gate" below); trust the project first
    // so this test keeps validating "a well-formed config.json produces zero
    // warnings" rather than the untrusted-downgrade path.
    trustProject(project);
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

  // --- setRoot error messages ------------------------------------------------

  it("test_set_root_distinguishes_missing_from_not_a_directory", () => {
    expect(() => config.setRoot(path.join(project, "no-such-subdir"))).toThrow("directory not found");
    const filePath = path.join(project, "a-file.txt");
    fs.writeFileSync(filePath, "hi");
    expect(() => config.setRoot(filePath)).toThrow("not a directory");
  });

  // --- terminal verbosity -----------------------------------------------------

  it("test_verbosity_defaults_to_normal", () => {
    writeCfg(project, {});
    config.setRoot(project);
    expect(config.verbosity).toBe("normal");
  });

  it("test_verbosity_from_config_file", () => {
    writeCfg(project, { verbosity: "debug" });
    config.setRoot(project);
    expect(config.verbosity).toBe("debug");
  });

  it("test_verbosity_unknown_value_falls_back_to_normal_with_no_warning", () => {
    // an invalid verbosity is cosmetic only (terminal rendering), not worth a
    // configErrors warning like a wrong-typed int/bool field.
    writeCfg(project, { verbosity: "chatty" });
    config.setRoot(project);
    expect(config.verbosity).toBe("normal");
  });

  it("test_set_verbosity_is_sticky_across_set_root", () => {
    config.setVerbosity("quiet");
    writeCfg(project, { verbosity: "debug" });
    config.setRoot(project); // a later /cd must not drop the sticky CLI flag
    expect(config.verbosity).toBe("quiet");
    config.setVerbosity("normal"); // restore for later tests in this file
  });

  // --- project trust gate (security fix) --------------------------------------

  describe("config: project trust gate", () => {
    it("an untrusted config.json cannot enable auto_approve on its own", () => {
      expect(isProjectTrusted(project)).toBe(false);
      writeCfg(project, { auto_approve: true });
      config.setRoot(project);
      expect(config.autoApprove).toBe(false);
      expect(config.configErrors.some((w) => w.includes("auto_approve") && w.includes("not trusted"))).toBe(
        true,
      );
    });

    it("trusting the project makes the SAME config.json's auto_approve take effect", () => {
      writeCfg(project, { auto_approve: true });
      config.setRoot(project);
      expect(config.autoApprove).toBe(false); // still untrusted here
      trustProject(project);
      config.setRoot(project); // fresh setRoot re-reads trust state
      expect(config.autoApprove).toBe(true);
      expect(config.configErrors).toEqual([]);
    });

    it("an untrusted config.json cannot enable allow_dangerous on its own", () => {
      writeCfg(project, { allow_dangerous: true });
      config.setRoot(project);
      expect(config.allowDangerous).toBe(false);
      expect(
        config.configErrors.some((w) => w.includes("allow_dangerous") && w.includes("not trusted")),
      ).toBe(true);
      trustProject(project);
      config.setRoot(project);
      expect(config.allowDangerous).toBe(true);
    });

    it("an untrusted config.json cannot enable permission_mode: bypass on its own", () => {
      writeCfg(project, { permission_mode: "bypass" });
      config.setRoot(project);
      expect(config.permissionMode).not.toBe("bypass");
      expect(
        config.configErrors.some((w) => w.includes("permission_mode") && w.includes("not trusted")),
      ).toBe(true);
      trustProject(project);
      config.setRoot(project);
      expect(config.permissionMode).toBe("bypass");
    });

    it("--yolo (sticky CLI) keeps working unchanged in an untrusted project", () => {
      expect(isProjectTrusted(project)).toBe(false);
      writeCfg(project, {}); // no dangerous file keys at all
      config.setYolo();
      config.setRoot(project);
      expect(config.autoApprove).toBe(true);
      expect(config.permissionMode).toBe("bypass");
      expect(config.configErrors.some((w) => w.includes("not trusted"))).toBe(false);
      // restore sticky state for later tests in this file
      config.forceAutoApprove = false;
      config.autoApprove = false;
      config.permissionMode = "default";
    });

    it("AGENT_AUTO_APPROVE=1 (env) keeps working unchanged in an untrusted project", () => {
      expect(isProjectTrusted(project)).toBe(false);
      const saved = process.env.AGENT_AUTO_APPROVE;
      process.env.AGENT_AUTO_APPROVE = "1";
      try {
        writeCfg(project, {});
        config.setRoot(project);
        expect(config.autoApprove).toBe(true);
        expect(config.configErrors.some((w) => w.includes("not trusted"))).toBe(false);
      } finally {
        if (saved === undefined) delete process.env.AGENT_AUTO_APPROVE;
        else process.env.AGENT_AUTO_APPROVE = saved;
      }
    });

    it("--allow-dangerous (sticky CLI) keeps working unchanged in an untrusted project", () => {
      expect(isProjectTrusted(project)).toBe(false);
      writeCfg(project, {});
      config.setAllowDangerous();
      config.setRoot(project);
      expect(config.allowDangerous).toBe(true);
      expect(config.configErrors.some((w) => w.includes("not trusted"))).toBe(false);
      config.forceAllowDangerous = false;
      config.allowDangerous = false;
    });

    it("a file requesting auto_approve alongside an explicit --yolo does not add a spurious warning", () => {
      // The user's own --yolo already grants it; the file also asking for the
      // same thing is not a surprise and must not be reported as untrusted.
      writeCfg(project, { auto_approve: true });
      config.setYolo();
      config.setRoot(project);
      expect(config.autoApprove).toBe(true);
      expect(config.configErrors.some((w) => w.includes("not trusted"))).toBe(false);
      config.forceAutoApprove = false;
      config.autoApprove = false;
      config.permissionMode = "default";
    });
  });
});
