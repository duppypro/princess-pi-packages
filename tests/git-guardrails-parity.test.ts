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
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  /** What the frozen pre-#74 ancestor returned. Absent = no historical claim. */
  pre74?: "allow" | "block";
  /** Which documented defect this case demonstrates. Present iff pre74 is. */
  pre74_class?: "greedy-push-regex" | "cwd-only-branch" | "substring-checkout-dot";
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

// --- regression witness (#260) ---
//
// Everything above asserts the two CURRENT implementations agree with the spec.
// None of it shows the guardrail catches anything a naive implementation would
// miss — 124 cases of mutual agreement are equally consistent with the rewrite
// having been unnecessary.
//
// hooks/block-dangerous-git.sh's header makes two historical claims: the old
// greedy regex `push\s+.*\b(main|master)\b` spanned the whole command line and
// over-blocked, and it resolved the branch from the hook cwd alone so
// `git -C <path> push` with <path> on main slipped through. Those claims were
// prose. The ancestor itself survived as a stray .bak (#257 cleanup) and is now
// frozen at tests/fixtures/block-dangerous-git.pre-74.sh, so they can be run.
//
// The fixture is EXECUTED, never sourced or deployed: it is a historical input,
// and the only thing that may ever change about it is deletion.
const PRE74_HOOK = join(REPO_ROOT, "tests", "fixtures", "block-dangerous-git.pre-74.sh");

function pre74Verdict(command: string, cwd: string): "allow" | "block" {
  const input = JSON.stringify({ tool_input: { command, cwd } });
  const res = spawnSync("bash", [PRE74_HOOK], { input, encoding: "utf8" });
  if (res.status === 0) return "allow";
  if (res.status === 2) return "block";
  throw new Error(
    `pre-74 hook exited ${res.status} (expected 0 or 2): ${res.stderr || res.stdout}`
  );
}

describe("git-guardrails regression witness (#260)", () => {
  const witnesses = (fixture as { cases: Case[] }).cases.filter((c) => c.pre74 !== undefined);

  // The artifact carries no "FROZEN — do not edit" banner on purpose: adding one
  // would edit it, and its whole evidentiary value is being the unmodified file
  // recovered from ~/.claude/hooks in the #257 cleanup. So the freeze is pinned
  // here instead, where it can be enforced rather than requested.
  test("the pre-74 artifact is unmodified (2810 bytes, 2026-07-15)", () => {
    const sha = createHash("sha256").update(readFileSync(PRE74_HOOK)).digest("hex");
    expect(sha, "tests/fixtures/block-dangerous-git.pre-74.sh must not be edited — it is a historical artifact, and the only valid change to it is deletion").toBe(
      "6596501671fb71a1a9dc920e054d990f69af6e16b41fb8fe4bbc1d43522a5f74"
    );
  });

  for (const c of witnesses) {
    test(`${c.id} — pre-74 answered ${c.pre74}, spec says ${c.verdict} [${c.pre74_class}]`, () => {
      const { command, cwd } = materialize(c);
      // The ancestor's recorded behaviour is pinned. This fails if the frozen
      // fixture is edited — which is the point of freezing it.
      expect(pre74Verdict(command, cwd), `pre-74: ${c.why}`).toBe(c.pre74!);
      // ...and it was WRONG, which is what makes this a witness rather than
      // a second spec. Guards against annotating a case the old hook got right.
      expect(c.pre74).not.toBe(c.verdict);
      // Both current implementations get it right. Without this the test would
      // prove only that something changed, not that it improved.
      expect(tsVerdict(command, cwd), `ts: ${c.why}`).toBe(c.verdict);
      expect(shVerdict(command, cwd), `sh: ${c.why}`).toBe(c.verdict);
    });
  }

  // Each documented claim must keep at least one live witness. Without this,
  // deleting the last case of a class would silently retire the evidence for a
  // bug the hook's header still asserts.
  for (const cls of ["greedy-push-regex", "cwd-only-branch", "substring-checkout-dot"]) {
    test(`class '${cls}' still has a witness`, () => {
      expect(witnesses.filter((c) => c.pre74_class === cls).length).toBeGreaterThan(0);
    });
  }

  // The cwd-only-branch defect was wrong in BOTH directions: it under-blocked a
  // push to a -C target on main, and over-blocked one whose --git-dir target was
  // on a feature branch while the shell cwd sat on main. A witness set holding
  // only under-blocks would misrepresent it as a missing rule rather than a
  // wrong input to an existing one.
  test("cwd-only-branch is witnessed in both directions", () => {
    const cwdOnly = witnesses.filter((c) => c.pre74_class === "cwd-only-branch");
    expect(cwdOnly.some((c) => c.pre74 === "allow" && c.verdict === "block")).toBe(true);
    expect(cwdOnly.some((c) => c.pre74 === "block" && c.verdict === "allow")).toBe(true);
  });
});
