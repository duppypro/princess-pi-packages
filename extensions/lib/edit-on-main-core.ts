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

// Thrown by realpathTolerant when resolving a path needs more than 40 symlink
// hops — a loop, or a chain deeper than the cap (#303 review finding,
// macroscopeapp on PR #313, thread PRRT_kwDOS37--c6Zr6MV). Before this type
// existed the loop below simply assigned the still-unresolved `candidate` to
// `real` once the cap was hit — silently treating an UNRESOLVED symlink as
// resolved. That let checkEditOnMain inspect the wrong repo (e.g. the feature
// worktree a deep symlink sits in) while the write's real target — reached by
// the OS's own unbounded symlink resolution during the later fs write — landed
// somewhere else entirely, including a repo on main. Confirmed empirically: a
// 45-hop chain inside a feature-branch repo whose final target lives in a
// repo on main made checkEditOnMain return ALLOW. #210 governs: a check that
// cannot prove its precondition must refuse, not assume the safe case.
export class SymlinkDepthExceededError extends Error {
  constructor(public readonly candidate: string) {
    super(`symlink chain exceeds 40 hops while resolving '${candidate}'`);
    this.name = "SymlinkDepthExceededError";
  }
}

// ---
// realpath -m equivalent (#267 finding, ported from block-edit-on-main.sh):
// resolve every symlink along the path, tolerating components that don't exist
// yet. Node's fs.realpathSync throws ENOENT the moment any component —
// including the final target of a dangling symlink — doesn't exist, which
// breaks two load-bearing cases: a brand-new file being created by Write, and
// a symlink whose target doesn't exist yet. Both must still resolve as far as
// they can, exactly like GNU `realpath -m`.
//
// THE ORDERING RULE (#303 review finding, macroscopeapp on PR #313, thread
// PRRT_kwDOS37--c6Zr-dX): `.` and `..` are resolved DURING the component walk,
// never before it — because POSIX resolves `..` against the directory a
// symlink actually points at, while path.resolve()/path.normalize()/path.join()
// collapse it LEXICALLY, against the directory it is written in. When any
// component is a symlink the two answers differ, and the lexical one is
// permissive: `<feature-repo>/link/../f.txt` collapsed to `<feature-repo>/f.txt`
// (feature branch → ALLOW) while the kernel — and `realpath -m` in the shell
// twin — walk `link` into a repo on main and land the bytes there. Reproduced
// before this fix: ts ALLOW, sh BLOCK, and the write overwrote the main repo's
// file. So: build the absolute string by CONCATENATION only, and handle `..` by
// popping `real`, which is fully symlink-resolved at that point.
//
// The narrower patch suggested on the thread (skip normalization only when the
// input is already absolute) is not enough: a RELATIVE input containing `..`
// still goes through path.resolve(cwd, …) and is collapsed exactly the same
// way. Both shapes are pinned in tests/block-edit-on-main-parity.test.ts.
//
// Shape: a single component QUEUE, walked the way the kernel walks a path —
// `real` is the canonical prefix proven so far, and a symlink target is pushed
// back onto the FRONT of the queue rather than resolved by a nested call. That
// keeps the `..`-after-symlink rule applying to link targets too (a target of
// `../other` is subject to it just as much as the input is), and it terminates
// on a self-referential relative link (`a -> a`), which a recursive walker
// would blow the stack on.
// ---
function realpathTolerant(inputPath: string): string {
  // Concatenate, never normalize — mirrors the shell twin's
  // `realpath -m "${CWD:-.}/$FILE"`, which hands the raw string to a
  // symlink-aware resolver rather than pre-collapsing it.
  const abs = path.isAbsolute(inputPath) ? inputPath : `${process.cwd()}${path.sep}${inputPath}`;
  const queue = abs.split(path.sep).filter(Boolean);
  let real = path.sep;
  // One budget for the WHOLE walk, not per component — the same accounting the
  // kernel uses before it returns ELOOP, and the only way to bound a path whose
  // links each resolve fine but collectively never terminate.
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === ".") continue;
    // `..` applies to the RESOLVED prefix. `real` has had every symlink in it
    // dereferenced already, and a canonical path's parent is canonical, so
    // dirname() here is the POSIX answer. (dirname("/") === "/", matching
    // `realpath -m /../x` → `/x`.)
    if (part === "..") {
      real = path.dirname(real);
      continue;
    }
    const candidate = real + (real.endsWith(path.sep) ? "" : path.sep) + part;

    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(candidate);
    } catch {
      // Component doesn't exist — so it cannot be a symlink, and it is already
      // resolved as far as it can ever be. Keep walking rather than appending
      // the remainder lexically: a later `..` may pop back out of the missing
      // part onto a component that DOES exist and IS a symlink
      // (`realpath -m 'nope/../link/x'` resolves `link` — verified against GNU
      // realpath). Stopping here would skip that symlink.
      real = candidate;
      continue;
    }
    if (!st.isSymbolicLink()) {
      real = candidate;
      continue;
    }

    // Budget exhausted and we are still looking at a symlink: we cannot prove
    // where this path resolves. Fail closed rather than trust the unresolved
    // value — see SymlinkDepthExceededError above.
    if (++hops > 40) throw new SymlinkDepthExceededError(candidate);

    const target = fs.readlinkSync(candidate);
    // An absolute target restarts from the root; a relative one continues from
    // the directory holding the link — which is exactly the current `real`.
    if (path.isAbsolute(target)) real = path.sep;
    queue.unshift(...target.split(path.sep).filter(Boolean));
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
    // Concatenation, NOT path.resolve — see the ordering rule on
    // realpathTolerant. path.resolve() would collapse `..` lexically here,
    // before any symlink in `cwd` or in `filePath` had been dereferenced, which
    // is the exact bypass this guard was found to have. Mirrors the shell
    // twin's `realpath -m "${CWD:-.}/$FILE"` character for character.
    const absInput = path.isAbsolute(filePath) ? filePath : `${cwd || "."}${path.sep}${filePath}`;
    let resolved: string;
    try {
      resolved = realpathTolerant(absInput);
    } catch (err) {
      if (err instanceof SymlinkDepthExceededError) {
        // Fail closed (#210): we cannot prove which repo/branch this edit's
        // bytes actually land in, so refuse rather than assume the safe case.
        // This is a guardrail, not a crash path — return a block reason the
        // human can act on, same as every other branch below.
        return (
          `'${filePath}' could not be safely resolved — its symlink chain is longer than 40 hops ` +
          `(possible symlink loop, or a chain deep enough that this guard cannot prove where the edit ` +
          `ultimately lands). Refusing to edit until the path resolves within the hop limit:\n` +
          `  readlink -f '${filePath}'\n` +
          `(CLAUDE.md HARD GATE / #210 — a check that cannot prove its precondition must refuse.)`
        );
      }
      throw err;
    }
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
      `'${filePath}' is in a repo on '${branch || "detached HEAD"}'. Start feature/fix work in a worktree first:\n` +
      `  wt-new <issue#>-<slug>\n` +
      `(CLAUDE.md HARD GATE — editing on main risks lossy stash/checkout recovery.)`
    );
  }

  return null;
}
