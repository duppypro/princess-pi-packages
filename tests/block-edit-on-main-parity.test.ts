/**
 * Parity test for block-edit-on-main (#303).
 *
 * Same shape as tests/git-guardrails-parity.test.ts, but for a different tool
 * surface: hooks/block-edit-on-main.sh gates Edit/Write/MultiEdit by FILE
 * PATH, not by bash command string, so its case fixtures are real repos on
 * real branches (mkdtempSync + git init), not a JSON command-string matrix.
 * The case matrix itself is not new — it is the load-bearing spec already
 * pinned in tests/hooks-deploy-drift.test.ts §5b; this file adds the Pi twin
 * to that same spec rather than inventing a second one.
 *
 * Runs every case against BOTH implementations and asserts they agree:
 *   - extensions/lib/edit-on-main-core.ts → checkEditOnMain() called directly
 *   - hooks/block-edit-on-main.sh         → spawned with hook-shaped JSON on
 *     stdin (exit 0 = allow, exit 2 = block — the Claude Code PreToolUse
 *     contract)
 */

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkEditOnMain } from "../extensions/lib/edit-on-main-core";

const REPO_ROOT = path.join(import.meta.dir, "..");
const SH_HOOK = path.join(REPO_ROOT, "hooks", "block-edit-on-main.sh");

function tmpRepo(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
}

function repoOnBranch(branch: string): string {
  const dir = tmpRepo("edit-main-case-");
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir });
  return dir;
}

/** A repo whose feature branch conflicts with main, left mid-rebase (detached, conflicted). */
function conflictedRebase(label: string): { repo: string; file: string } {
  const repo = tmpRepo(`edit-main-${label}-`);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-q", "-b", "42-slug");
  fs.writeFileSync(path.join(repo, "f.txt"), "feature\n");
  git(repo, "commit", "-qam", "feature");
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "f.txt"), "mainline\n");
  git(repo, "commit", "-qam", "mainline");
  git(repo, "checkout", "-q", "42-slug");
  try {
    git(repo, "rebase", "main");
  } catch {
    /* conflict — the state under test */
  }
  return { repo, file: path.join(repo, "f.txt") };
}

function shVerdict(filePath: string, cwd: string): "allow" | "block" {
  const input = JSON.stringify({ tool_input: { file_path: filePath }, cwd });
  const res = spawnSync("bash", [SH_HOOK], { input, encoding: "utf8" });
  if (res.status === 0) return "allow";
  if (res.status === 2) return "block";
  throw new Error(`sh hook exited ${res.status} (expected 0 or 2): ${res.stderr || res.stdout}`);
}

function tsVerdict(filePath: string, cwd: string): "allow" | "block" {
  return checkEditOnMain(filePath, cwd) === null ? "allow" : "block";
}

function assertBoth(filePath: string, cwd: string, verdict: "allow" | "block", why: string) {
  expect(tsVerdict(filePath, cwd), `ts: ${why}`).toBe(verdict);
  expect(shVerdict(filePath, cwd), `sh: ${why}`).toBe(verdict);
}

describe("block-edit-on-main parity (#303)", () => {
  test("blocks an edit inside a repo on 'main'", () => {
    const repo = repoOnBranch("main");
    assertBoth(path.join(repo, "f.txt"), repo, "block", "repo is on main");
  });

  test("allows an edit inside a repo on a feature branch", () => {
    const repo = repoOnBranch("42-slug");
    assertBoth(path.join(repo, "f.txt"), repo, "allow", "repo is on a feature branch");
  });

  test("allows an edit outside any git work tree", () => {
    const nonRepo = tmpRepo("edit-main-nonrepo-");
    assertBoth(path.join(nonRepo, "f.txt"), nonRepo, "allow", "not inside any git work tree");
  });

  // Symlink bypass (#267 finding): a symlink SITS in a feature worktree but
  // its TARGET is physically inside a repo on main. A naive `dirname` on the
  // symlink path alone would resolve to the feature repo and allow the edit,
  // even though the bytes land on main.
  test("blocks a symlink in a feature worktree whose target is inside a repo on main", () => {
    const mainRepo = repoOnBranch("main");
    const featRepo = repoOnBranch("42-slug");
    fs.symlinkSync(path.join(mainRepo, "f.txt"), path.join(featRepo, "symlink-to-main.txt"));
    assertBoth(
      path.join(featRepo, "symlink-to-main.txt"),
      featRepo,
      "block",
      "symlink target resolves into a repo on main",
    );
  });

  // --- #272: detached HEAD is two states, not one -------------------------
  test("allows editing a conflicted file mid-rebase (detached HEAD, operation in progress)", () => {
    const { repo, file } = conflictedRebase("rebase");
    expect(
      fs.existsSync(path.join(repo, ".git", "rebase-merge")) || fs.existsSync(path.join(repo, ".git", "rebase-apply")),
      "fixture sanity: the rebase really is in progress",
    ).toBe(true);
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim(),
      "fixture sanity: mid-rebase HEAD really is detached",
    ).toBe("");
    assertBoth(file, repo, "allow", "mid-rebase conflict — the only way forward is resolving it");
  });

  test("still blocks a plain detached checkout (no operation in progress)", () => {
    const repo = tmpRepo("edit-main-detached-");
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    git(repo, "checkout", "-q", sha);
    assertBoth(path.join(repo, "f.txt"), repo, "block", "plain detached checkout — the hazard this guard exists for");
  });

  // --- linked worktree layout (#257) — the git dir is <main>/.git/worktrees/<name> ---
  test("allows an edit in a linked worktree on a feature branch, and the mid-rebase exemption still applies there", () => {
    const { repo } = conflictedRebase("wt-host");
    git(repo, "rebase", "--abort");
    const wt = path.join(repo, ".claude", "worktrees", "99-wt");
    git(repo, "worktree", "add", "-q", "-b", "99-wt", wt, "42-slug");

    expect(fs.statSync(path.join(wt, ".git")).isFile(), "fixture sanity: linked worktree .git is a file").toBe(true);
    assertBoth(path.join(wt, "f.txt"), wt, "allow", "worktree is on a feature branch");

    fs.writeFileSync(path.join(wt, "f.txt"), "worktree-side\n");
    git(wt, "commit", "-qam", "worktree-side");
    try {
      git(wt, "rebase", "main");
    } catch {
      /* conflict — the state under test */
    }
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: wt, encoding: "utf8" }).trim(),
      "fixture sanity: mid-rebase HEAD is detached inside the worktree too",
    ).toBe("");
    assertBoth(path.join(wt, "f.txt"), wt, "allow", "mid-rebase conflict inside a linked worktree");

    git(wt, "rebase", "--abort");
    const wtSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
    git(wt, "checkout", "-q", wtSha);
    assertBoth(path.join(wt, "f.txt"), wt, "block", "plain detached checkout inside a linked worktree");
  });

  test("still blocks a conflicted merge raised ON main (exemption is detached-only)", () => {
    const repo = tmpRepo("edit-main-mergemain-");
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    git(repo, "checkout", "-q", "-b", "42-slug");
    fs.writeFileSync(path.join(repo, "f.txt"), "feature\n");
    git(repo, "commit", "-qam", "feature");
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "f.txt"), "mainline\n");
    git(repo, "commit", "-qam", "mainline");
    try {
      git(repo, "merge", "42-slug");
    } catch {
      /* conflict — the state under test */
    }
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD")), "fixture sanity: merge in progress on main").toBe(true);
    assertBoth(path.join(repo, "f.txt"), repo, "block", "a conflicted merge on main keeps its branch name — still gated");
  });

  // --- git-dir exemption (dotfiles-doctor#15, ADR 0001) --------------------
  describe("paths inside the git dir are not gated, even on main", () => {
    const repo = tmpRepo("edit-main-gitdir-");
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");

    test("fixture sanity: this repo is on main and gates work-tree files", () => {
      assertBoth(path.join(repo, "f.txt"), repo, "block", "sanity check");
    });

    for (const rel of [".git/config", ".git/info/exclude", ".git/hooks/pre-commit"]) {
      test(`allows ${rel}`, () => {
        assertBoth(path.join(repo, rel), repo, "allow", "inside the git dir itself — no branch-scoped hazard");
      });
    }

    // Lookalikes — tracked work-tree files whose names merely START WITH
    // ".git". A prefix-matching implementation would pass every case above
    // and silently un-gate these too.
    for (const rel of [".gitignore", ".gitattributes", ".gitmodules", ".github/workflows/ci.yml"]) {
      test(`still blocks ${rel} (lookalike, not a git-dir path)`, () => {
        assertBoth(path.join(repo, rel), repo, "block", "tracked work-tree file, not inside .git/");
      });
    }
  });

  test("allows a path under .git/worktrees/<name>/ from a repo on main", () => {
    const repo = tmpRepo("edit-main-wtgitdir-");
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    const wt = path.join(repo, ".claude", "worktrees", "77-wt");
    git(repo, "worktree", "add", "-q", "-b", "77-wt", wt);

    assertBoth(
      path.join(repo, ".git", "worktrees", "77-wt", "config.worktree"),
      repo,
      "allow",
      "inside the per-worktree git dir",
    );
  });

  test("allows creating a brand-new file whose parent directory doesn't exist yet, in a repo on a feature branch", () => {
    const repo = repoOnBranch("42-slug");
    assertBoth(path.join(repo, "new", "subdir", "f.txt"), repo, "allow", "new nested file, feature branch");
  });

  test("blocks creating a brand-new file whose parent directory doesn't exist yet, in a repo on main", () => {
    const repo = repoOnBranch("main");
    assertBoth(path.join(repo, "new", "subdir", "f.txt"), repo, "block", "new nested file, main");
  });

  // Deep-symlink fail-closed (#303 review finding, macroscopeapp on PR #313,
  // thread PRRT_kwDOS37--c6Zr6MV): edit-on-main-core.ts's tolerant realpath
  // walker capped a single component's symlink chain at 40 hops, but on
  // hitting the cap while STILL a symlink it silently assigned the
  // unresolved value to `real` — treating an unproven path as resolved. A
  // symlink chain sitting in a feature worktree but longer than 40 hops,
  // whose final target lives in a repo on main, made checkEditOnMain inspect
  // the feature repo (ALLOW) while the OS's own unbounded resolution — used
  // by realpath -m in the shell hook, and by the eventual fs write — lands
  // the bytes on main. Confirmed empirically before the fix: this exact case
  // returned ALLOW from checkEditOnMain and BLOCK from the shell hook.
  // Symlink-then-`..` traversal (#303 review finding, macroscopeapp on PR #313,
  // thread PRRT_kwDOS37--c6Zr-dX): POSIX resolves `..` AFTER following symlinks,
  // but `path.resolve`/`path.normalize` collapse it LEXICALLY, before. So
  // `<feature>/link/../f.txt` — where `link` is a symlink into a repo on main —
  // collapsed to `<feature>/f.txt` and the guard inspected the feature repo
  // (ALLOW), while `realpath -m` in the shell twin, and the kernel's own path
  // walk during the eventual write, both land in the main repo. Reproduced
  // before the fix: ts ALLOW / sh BLOCK, and `writeFileSync` on that exact
  // string overwrote the file inside the repo on main.
  //
  // Note the fixture builds the path by STRING CONCATENATION: path.join() would
  // collapse the `..` itself and quietly destroy the case under test.
  function traversalFixture(): { mainRepo: string; featRepo: string } {
    const mainRepo = repoOnBranch("main");
    fs.mkdirSync(path.join(mainRepo, "subdir"));
    fs.writeFileSync(path.join(mainRepo, "f.txt"), "base\n");
    const featRepo = repoOnBranch("42-slug");
    fs.writeFileSync(path.join(featRepo, "f.txt"), "feature\n");
    fs.symlinkSync(path.join(mainRepo, "subdir"), path.join(featRepo, "link"));
    return { mainRepo, featRepo };
  }

  test("blocks an absolute path whose '..' traverses out of a symlink into a repo on main", () => {
    const { featRepo } = traversalFixture();
    assertBoth(
      `${featRepo}/link/../f.txt`,
      featRepo,
      "block",
      "`..` after a symlink resolves into the repo on main, not the feature repo",
    );
  });

  // The same bug via a RELATIVE input. Pinned separately because the narrow
  // patch suggested on the thread (skip normalization for absolute inputs only)
  // passes the case above and still fails this one: a relative path routed
  // through path.resolve(cwd, …) is normalized lexically just the same.
  test("blocks a RELATIVE path whose '..' traverses out of a symlink into a repo on main", () => {
    const { featRepo } = traversalFixture();
    assertBoth("link/../f.txt", featRepo, "block", "relative input must not be lexically collapsed either");
  });

  test("fails closed on a symlink chain longer than 40 hops whose real target is a repo on main", () => {
    const mainRepo = repoOnBranch("main");
    fs.writeFileSync(path.join(mainRepo, "f.txt"), "base\n");
    const featRepo = repoOnBranch("42-slug");

    let prev = path.join(mainRepo, "f.txt");
    for (let i = 1; i <= 45; i++) {
      const linkPath = path.join(featRepo, `link${i}`);
      fs.symlinkSync(prev, linkPath);
      prev = linkPath;
    }
    const targetFile = prev; // featRepo/link45 -> ... -> link1 -> mainRepo/f.txt

    assertBoth(
      targetFile,
      featRepo,
      "block",
      "chain exceeds the 40-hop cap; guard must refuse rather than assume the safe (feature-branch) case",
    );
  });

  // Self-referential symlink (#316): GNU `realpath -m` hits ELOOP internally
  // resolving a symlink that points at itself, but -m mode SWALLOWS that
  // failure and returns the unresolved input path with rc=0 — the shell
  // hook then treated an unproven path as resolved and ALLOWED the edit,
  // even on a feature branch where nothing else about this case would be
  // blocked. The TS twin already fails closed here: the walker keeps
  // re-expanding the same self-target forever, so the existing 40-hop cap
  // trips and SymlinkDepthExceededError converts to BLOCK. This pins the
  // two twins in agreement on the case the issue reports as diverging.
  test("blocks a self-referential symlink (realpath -m returns rc=0 unresolved)", () => {
    const repo = repoOnBranch("42-slug");
    const selfLink = path.join(repo, "selfLink");
    fs.symlinkSync("selfLink", selfLink);
    assertBoth(selfLink, repo, "block", "self-referential symlink cannot be resolved — fail closed, not fail open");
  });
});
