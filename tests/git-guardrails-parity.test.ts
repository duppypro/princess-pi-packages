/**
 * Parity test for the git guardrails (#74).
 *
 * Runs every case in tests/fixtures/git-guardrails-cases.json against BOTH
 * implementations and asserts they agree with the fixture verdict:
 *   - extensions/git-guardrails.ts  → checkGitCommand() called directly
 *   - hooks/block-dangerous-git.sh  → spawned with hook-shaped JSON on stdin
 *     (exit 0 = allow, exit 2 = block — the Claude Code PreToolUse contract)
 *
 * Branch state is real, not mocked: each case gets throwaway `git init -b`
 * repos matching its declared branches. "/repo" in a command is a placeholder
 * replaced with the -C target repo's actual path.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { checkGitCommand } from "../extensions/lib/git-guardrails-core";
import fixture from "./fixtures/git-guardrails-cases.json";

const REPO_ROOT = join(import.meta.dir, "..");
const SH_HOOK = join(REPO_ROOT, "hooks", "block-dangerous-git.sh");

interface Case {
  id: string;
  command: string;
  verdict: "allow" | "block";
  branch?: string;
  cwd_branch?: string;
  c_path_branch?: string;
  c_path_rel?: string;
  why: string;
}

// --- test doubles: real throwaway repos, real branches ---

function repoOnBranch(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrail-case-"));
  execSync(`git init -q -b "${branch}"`, { cwd: dir });
  return dir;
}

function nonRepoDir(): string {
  return mkdtempSync(join(tmpdir(), "guardrail-nonrepo-"));
}

/** Materialize a case's declared branch state into (command, cwd). */
function materialize(c: Case): { command: string; cwd: string } {
  let command = c.command;
  const cwdBranch = c.cwd_branch !== undefined ? c.cwd_branch : c.branch;
  const cwd = cwdBranch ? repoOnBranch(cwdBranch) : nonRepoDir();
  if (c.c_path_branch !== undefined) {
    if (c.c_path_rel !== undefined) {
      // relative -C target: a repo INSIDE the tool-call cwd, referenced by
      // its relative name — the command already says `-C <c_path_rel>`
      execSync(`git init -q -b "${c.c_path_branch}" "${c.c_path_rel}"`, { cwd });
    } else {
      const cRepo = repoOnBranch(c.c_path_branch);
      command = command.replaceAll("/repo", cRepo);
    }
  }
  return { command, cwd };
}

function shVerdict(command: string, cwd: string): "allow" | "block" {
  const input = JSON.stringify({ tool_input: { command, cwd } });
  const res = spawnSync("bash", [SH_HOOK], { input, encoding: "utf8" });
  if (res.status === 0) return "allow";
  if (res.status === 2) return "block";
  throw new Error(
    `hook exited ${res.status} (expected 0 or 2): ${res.stderr || res.stdout}`
  );
}

function tsVerdict(command: string, cwd: string): "allow" | "block" {
  return checkGitCommand(command, cwd) === null ? "allow" : "block";
}

// --- the parity gate ---

describe("git-guardrails parity (#74)", () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    test(`${c.id} → ${c.verdict}`, () => {
      const { command, cwd } = materialize(c);
      // fixture is the spec: both implementations must match it
      expect(tsVerdict(command, cwd), `ts: ${c.why}`).toBe(c.verdict);
      expect(shVerdict(command, cwd), `sh: ${c.why}`).toBe(c.verdict);
    });
  }
});
