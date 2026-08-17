/**
 * Block-edit-on-main core decision logic (#303) — harness-independent.
 *
 * Pure function, no Pi imports, so tests/block-edit-on-main-parity.test.ts can
 * exercise this directly. The Pi extension (extensions/git-guardrails.ts)
 * wraps checkEditOnMain() in a `tool_call` handler on the `edit`/`write`
 * tools; the Claude Code twin is hooks/block-edit-on-main.sh (install target
 * ~/.claude/hooks/, PreToolUse matcher `Edit|Write|MultiEdit`). Keep the two
 * in sync — the parity test runs the same case set against both.
 *
 * Why this exists (#303): Claude Code enforces the CLAUDE.md HARD GATE
 * ("never edit on main") technically via block-edit-on-main.sh. Pi had no
 * equivalent — extensions/git-guardrails.ts only blocked dangerous BASH
 * commands, so Edit/Write in Pi modified files on main with zero friction;
 * only `git push` was gated. Observed live: an agent edited a doc and
 * committed straight to main in Pi, while the identical edit was correctly
 * blocked in Claude Code — the outcome depended purely on which harness held
 * the pen.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// --- git queries: capture stdout regardless of exit status, mirroring the
// shell hook's `$(git … 2>/dev/null)` — a failing git call yields "", never
// a thrown exception. ---
function gitOut(dir: string, args: string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return (res.stdout ?? "").trim();
}

// ---
// realpath -m equivalent (#267 finding, ported from block-edit-on-main.sh):
// resolve every symlink along an EXISTING prefix of the path, then append any
// non-existent tail lexically. Node's fs.realpathSync throws ENOENT the
// moment any component — including the final target of a dangling symlink —
// doesn't exist, which breaks two load-bearing cases: a brand-new file being
// created by Write, and a symlink whose target doesn't exist yet. Both must
// still resolve as far as they can, exactly like GNU `realpath -m`.
// ---
function realpathTolerant(inputPath: string): string {
  const abs = path.resolve(inputPath);
  const parts = abs.split(path.sep).filter(Boolean);
  let real = path.sep;
  for (let i = 0; i < parts.length; i++) {
    let candidate = path.join(real, parts[i]);
    let linkDepth = 0;
    // Follow a chain of symlinks for this ONE component (bounded — a self-
    // referential symlink must not hang the guard).
    while (linkDepth++ < 40) {
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(candidate);
      } catch {
        // Component doesn't exist: from here on nothing resolves further —
        // return what's real so far, joined with the untouched remainder.
        return path.join(candidate, ...parts.slice(i + 1));
      }
      if (!st.isSymbolicLink()) break;
      const target = fs.readlinkSync(candidate);
      candidate = path.isAbsolute(target) ? target : path.resolve(path.dirname(candidate), target);
    }
    real = candidate;
  }
  return real;
}

/** Walk up to the nearest existing ancestor — mirrors the shell hook's loop
 *  for a new-file Write whose parent directory doesn't exist yet either. */
function nearestExistingAncestor(dir: string): string {
  while (dir !== path.dirname(dir) && !fs.existsSync(dir)) {
    dir = path.dirname(dir);
  }
  return dir;
}

/**
 * Decide whether editing `filePath` (from cwd `cwd`) should be blocked.
 * Returns a block reason string, or null to allow. Semantics mirror
 * hooks/block-edit-on-main.sh line for line — see that file's header for the
 * exemptions this preserves: outside any work tree, inside the git dir
 * itself, feature branch, and detached HEAD mid-rebase/merge/cherry-pick.
 */
export function checkEditOnMain(filePath: string, cwd: string): string | null {
  let dir: string;
  if (filePath) {
    const absInput = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || ".", filePath);
    const resolved = realpathTolerant(absInput);
    dir = path.dirname(resolved);
  } else {
    dir = cwd || ".";
  }
  dir = nearestExistingAncestor(dir);

  // Inside the git dir itself (.git/config, .git/hooks/*, .git/worktrees/*)
  // → allow (dotfiles-doctor#15, ADR 0001). Nothing under .git/ lives in a
  // branch, so the stash/checkout hazard below cannot reach it.
  if (gitOut(dir, ["rev-parse", "--is-inside-git-dir"]) === "true") return null;

  // Not inside a git work tree at all (e.g. ~/.claude configs) → not gated.
  if (gitOut(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;

  const branch = gitOut(dir, ["branch", "--show-current"]);

  // Detached HEAD is two states (#272): a plain `git checkout <sha>` stays
  // BLOCKED (edit, walk away, work is unreferenced); a detached HEAD with a
  // rebase/merge/cherry-pick/revert genuinely in progress is ALLOWED, because
  // the files needing edits are the conflict markers git itself just wrote.
  if (!branch) {
    const gitDir = gitOut(dir, ["rev-parse", "--absolute-git-dir"]);
    if (gitDir) {
      const inProgress =
        fs.existsSync(path.join(gitDir, "rebase-merge")) ||
        fs.existsSync(path.join(gitDir, "rebase-apply")) ||
        fs.existsSync(path.join(gitDir, "MERGE_HEAD")) ||
        fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD")) ||
        fs.existsSync(path.join(gitDir, "REVERT_HEAD"));
      if (inProgress) return null;
    }
  }

  // Empty branch (detached, no operation in progress) or main/master → block.
  // Fail closed: no identifiable branch is not a licence to edit.
  if (!branch || branch === "main" || branch === "master") {
    return (
      `'${filePath}' is in a repo on '${branch || "detached HEAD"}'. Start feature/fix work on a branch first:\n` +
      `  git checkout -b <issue#>-<slug>\n` +
      `(CLAUDE.md HARD GATE — editing on main risks lossy stash/checkout recovery.)`
    );
  }

  return null;
}
