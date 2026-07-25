// 1:1 mirror of the parametrized cases of tests/test_command_safety.py.
// The 4 integration tests with confirm_bash stay with permissions (phase 3).

import { describe, expect, it } from "vitest";

import { isDangerousCommand, isSafeCommand } from "../src/command-safety.js";

const SAFE_COMMANDS = [
  "ls -la",
  "git status",
  "grep -r foo src",
  "cat a.txt | head -5",
  "find . -name '*.py'",
  "pwd",
  "wc -l file.txt && echo ok",
  "sed -n 1,20p src/main.py",
  "bash -c 'ls -la'",
  "git log --oneline -5",
  "git branch -a",
  "env FOO=1",
  "/usr/bin/ls",
  "/bin/cat f.txt",
];

const UNSAFE_COMMANDS = [
  "ls > out.txt",
  "echo `whoami`",
  "npm install",
  "git push",
  "find . -delete",
  "bash -c 'rm -rf /'",
  "cat a.txt; npm install",
  "echo $(rm x)",
  "git branch -D main",
  "git branch nova",
  "sed -i 's/a/b/' file.txt",
  "env FOO=1 ls",
  "rg --pre cat foo",
  "echo 'aspas desbalanceadas",
  "",
  // Basename only applies to /bin and /usr/bin: the rest can be an arbitrary binary.
  "./ls",
  "/tmp/evil/cat x",
  "/usr/local/bin/ls",
];

const DANGEROUS_COMMANDS = [
  "rm -rf node_modules",
  "sudo rm -rf /",
  "git reset --hard",
  "env FOO=1 rm -f x",
  "bash -lc 'sudo rm -rf /tmp/x'",
  "shred secret.txt",
  "mkfs.ext4 /dev/sda1",
  "dd if=img of=/dev/sda",
  "git push --force",
  "git push -f origin main",
  "git clean -fd",
  "truncate -s 0 app.log",
  "cd /tmp && rm -rf build",
  "xargs rm -rf",
  "timeout 5 rm -rf x",
  // Unconditional basename on the dangerous side: absolute/relative path counts.
  "/bin/rm -rf x",
  "/usr/bin/env rm -rf x",
  "./rm -rf x",
];

const NOT_DANGEROUS_COMMANDS = [
  "rm",
  "echo rm -rf",
  "grep 'rm -rf' src",
  "rm -i old.txt",
  "git push origin main",
  "git reset HEAD~1",
  "git clean",
  "ls -la",
  "truncate -s 100 file.bin",
];

describe("command_safety", () => {
  describe("test_safe_commands", () => {
    for (const cmd of SAFE_COMMANDS) {
      it(`test_safe_commands[${cmd}]`, () => {
        expect(isSafeCommand(cmd)).toBe(true);
      });
    }
  });

  describe("test_unsafe_commands", () => {
    for (const cmd of UNSAFE_COMMANDS) {
      it(`test_unsafe_commands[${cmd}]`, () => {
        expect(isSafeCommand(cmd)).toBe(false);
      });
    }
  });

  describe("test_dangerous_commands", () => {
    for (const cmd of DANGEROUS_COMMANDS) {
      it(`test_dangerous_commands[${cmd}]`, () => {
        expect(isDangerousCommand(cmd)).toBe(true);
      });
    }
  });

  describe("test_not_dangerous_commands", () => {
    for (const cmd of NOT_DANGEROUS_COMMANDS) {
      it(`test_not_dangerous_commands[${cmd}]`, () => {
        expect(isDangerousCommand(cmd)).toBe(false);
      });
    }
  });
});
