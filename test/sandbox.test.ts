// 1:1 mirror of tests/test_sandbox.py (profile, wrap, available, denial and the
// real integration with Seatbelt). The 6 bash flow tests (test_bash_*)
// belong to the owner of tools/shell.ts and are not here.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROTECTED_FILES, config } from "../src/config.js";
import {
  available,
  buildProfile,
  looksLikeDenial,
  regexQuote,
  wrap,
} from "../src/sandbox.js";

const HAS_SEATBELT =
  process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");

const originalRoot = config.root;
let project: string;

// conftest "project" fixture: tmp root + autoApprove + contextFile off.
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-sbx-"));
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

/** Runs the full argv (sandbox-exec) and returns status/stdout/stderr. */
function run(argv: string[], cwd?: string) {
  const [cmd, ...rest] = argv;
  return spawnSync(cmd as string, rest, {
    encoding: "utf8",
    timeout: 60_000,
    cwd,
  });
}

describe("sandbox", () => {
  // --- build_profile ---------------------------------------------------------

  it("test_profile_deny_default_e_escrita_na_root", () => {
    config.sandboxNetwork = false;
    const profile = buildProfile();
    const root = fs.realpathSync(String(config.root));
    expect(profile).toContain("(deny default)");
    expect(profile).toContain(`(allow file-write* (subpath "${root}"))`);
    expect(profile).toContain("(allow file-read*)");
    expect(profile).toContain("(allow process-exec)");
  });

  it("test_profile_nega_git_e_reagent_depois_dos_allow", () => {
    const profile = buildProfile();
    const root = fs.realpathSync(String(config.root));
    const denyGit = `(deny file-write* (subpath "${root}/.git"))`;
    const denyState = `(deny file-write* (subpath "${root}/.reagent"))`;
    expect(profile).toContain(denyGit);
    expect(profile).toContain(denyState);
    // In SBPL the last matching rule wins: the deny must come AFTER
    // the ROOT allow to work as a carveout.
    expect(profile.indexOf(denyGit)).toBeGreaterThan(
      profile.indexOf(`(allow file-write* (subpath "${root}"))`),
    );
  });

  it("test_profile_nega_leitura_de_segredos_depois_dos_allow", () => {
    const profile = buildProfile();
    const root = fs.realpathSync(String(config.root));
    const allowReadIdx = profile.indexOf("(allow file-read*)");
    const denyState = `(deny file-read* (subpath "${root}/.reagent"))`;
    expect(profile).toContain(denyState);
    expect(profile.indexOf(denyState)).toBeGreaterThan(allowReadIdx);
    for (const name of PROTECTED_FILES) {
      const pattern = `^${regexQuote(root)}/(.*/)?${regexQuote(name)}$`;
      const denyRead = `(deny file-read* (regex #"${pattern}"))`;
      const denyWrite = `(deny file-write* (regex #"${pattern}"))`;
      expect(profile).toContain(denyRead);
      expect(profile).toContain(denyWrite);
      expect(profile.indexOf(denyRead)).toBeGreaterThan(allowReadIdx);
    }
  });

  it("test_profile_sem_network_por_padrao", () => {
    // The tmp name may contain "network", so the assert targets the rule itself.
    config.sandboxNetwork = false;
    expect(buildProfile()).not.toContain("(allow network");
  });

  it("test_profile_com_network_quando_ligado", () => {
    config.sandboxNetwork = true;
    expect(buildProfile()).toContain("(allow network*)");
  });

  // --- wrap / available ------------------------------------------------------

  it("test_wrap_monta_argv", () => {
    const argv = wrap("echo hi");
    expect(argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(argv[1]).toBe("-p");
    expect(argv[2]).toBe(buildProfile());
    if (process.platform === "win32") {
      // shellArgv() resolves Git-for-Windows bash.exe instead of /bin/bash there.
      expect(argv[3]).toMatch(/bash\.exe$/i);
      expect(argv.slice(4)).toEqual(["-lc", "echo hi"]);
    } else {
      expect(argv.slice(3)).toEqual(["/bin/bash", "-lc", "echo hi"]);
    }
  });

  it("test_available_respeita_sandbox_mode_off", () => {
    config.sandboxMode = "off";
    expect(available()).toBe(false);
  });

  it.skipIf(!HAS_SEATBELT)("test_available_em_macos_com_modo_auto", () => {
    config.sandboxMode = "auto";
    expect(available()).toBe(true);
  });

  // --- looks_like_denial -----------------------------------------------------

  it("test_denial_exige_evidencia_textual", () => {
    // Conservative: a common test/command failure is not a sandbox denial.
    expect(looksLikeDenial(1, "AssertionError: 1 != 2")).toBe(false);
    expect(looksLikeDenial(0, "Operation not permitted")).toBe(false);
    expect(looksLikeDenial(1, "touch: /Users/x/f: Operation not permitted")).toBe(true);
    expect(looksLikeDenial(1, "sandbox-exec: sandbox_apply: error")).toBe(true);
    expect(looksLikeDenial(1, "open failed: EPERM")).toBe(true);
  });

  // --- real integration with Seatbelt ----------------------------------------

  it.skipIf(!HAS_SEATBELT)(
    "test_seatbelt_permite_tmp_e_nega_home",
    () => {
      const allowed = "/tmp/reagent_sbx_test";
      const denied = path.join(os.homedir(), "reagent_sbx_denied");
      try {
        const ok = run(wrap(`touch ${allowed} && echo ok`));
        expect(ok.status, ok.stderr).toBe(0);
        expect(ok.stdout).toContain("ok");

        const blocked = run(wrap(`touch ${denied}`));
        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("Operation not permitted");
        expect(fs.existsSync(denied)).toBe(false);
        expect(looksLikeDenial(blocked.status, blocked.stderr)).toBe(true);
      } finally {
        for (const p of [allowed, denied]) {
          fs.rmSync(p, { force: true });
        }
      }
    },
    120_000,
  );

  it.skipIf(!HAS_SEATBELT)(
    "test_seatbelt_nega_leitura_de_env",
    () => {
      const marker = "seatbelt-secret-xyz";
      fs.writeFileSync(path.join(project, ".env"), `SECRET=${marker}\n`);
      fs.mkdirSync(path.join(project, "sub"));
      fs.writeFileSync(path.join(project, "sub", ".env"), `SECRET=${marker}\n`);
      fs.writeFileSync(path.join(project, "ok.txt"), "conteudo-legivel-42\n");

      const blocked = run(wrap("cat .env && cat sub/.env"), String(config.root));
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("Operation not permitted");
      expect(blocked.stdout).not.toContain(marker);

      const ok = run(wrap("cat ok.txt"), String(config.root));
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain("conteudo-legivel-42");
    },
    120_000,
  );
});
