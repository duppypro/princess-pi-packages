import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface MergeLogger {
	info(msg: string): void;
	error(msg: string): void;
	prompt(question: string): Promise<boolean>;
}

export interface MergeOptions {
	/** Skip the post-merge artifact rebuild (#177). */
	skipBuild?: boolean;
}

/**
 * A merge that landed locally but whose rebuild failed, so it was not pushed.
 *
 * Tagged rather than thrown as a plain Error because the in-place merge path
 * wraps its own failures in "merge failed and was rolled back" — which would be
 * false here twice over: the merge succeeded, and nothing was rolled back. That
 * is the same class of lie as #143.3, and it must not be reintroduced by the
 * #177 fix in the same commit that removes it.
 */
export class BuildFailureError extends Error {
	readonly buildFailure = true;
}

// ---
// Step 5 acceptance is word-rule based, not phrase based (#100) — the old exact
// "Code and Spec Approved" leading-phrase regex rejected legitimate Step 5
// commits over word order. Rules (subject line only, case-insensitive,
// whole words): some "approved" with "code" AND a spec-word before it, and
// no "not" anywhere before it. Subject-only on purpose: Step 4 commit bodies
// routinely mention specs and would false-positive.
// ---
export function isStep5ApprovedMessage(commitMsg: string): boolean {
	const subject = (commitMsg.split("\n")[0] || "").toLowerCase();
	const firstIndex = (re: RegExp): number => {
		const m = re.exec(subject);
		return m ? m.index : -1;
	};
	const codeIdx = firstIndex(/\bcode\b/);
	const specIdx = firstIndex(/\bspecs?\b|\bspecifications?\b/);
	const notIdx = firstIndex(/\bnot\b/);
	if (codeIdx === -1 || specIdx === -1) return false;

	const approvedRe = /\bapproved\b/g;
	let m: RegExpExecArray | null;
	while ((m = approvedRe.exec(subject)) !== null) {
		const i = m.index;
		if (codeIdx < i && specIdx < i && (notIdx === -1 || notIdx > i)) return true;
	}
	return false;
}

const STEP5_RULE_TEXT =
	"A Step 5 subject line needs the word 'approved' preceded by both 'code' and 'spec' (or 'specification'), with no 'not' before it — e.g. \"docs: Code and Spec Approved — <what> (#<issue>)\".";

// ---
// Post-merge artifact rebuild (#177).
//
// This repo tracks generated bin/*.mjs on purpose (.gitignore: required for
// `npm install -g` from a git URL). Two branches touching DIFFERENT bundled
// sources each commit a correct artifact for their own tree; the merge of the
// two bundles to something neither committed, so main lands stale with a clean
// `git status`. #159's staleness gate makes that visible; this closes it.
//
// Runs after the merge and BEFORE the push, so one push carries both. Building
// after the push would need a second push and would leave a window where
// origin/main is stale.
//
// Stays generic — merge is not a princess-pi-packages-only tool. A build runs
// only where there is one to run; a repo without a build script has nothing to
// regenerate, which is not an error.
// ---
function hasBuildScript(cwd: string): boolean {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
		return typeof pkg?.scripts?.build === "string" && pkg.scripts.build.trim() !== "";
	} catch {
		return false;
	}
}

function haveBun(): boolean {
	try {
		execSync("bun --version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Rebuild tracked artifacts in `cwd` and commit any delta. Throws when the build
 * itself fails — the caller must not push a tree that does not build.
 */
function rebuildArtifacts(cwd: string, targetHash: string, logger: MergeLogger, opts: MergeOptions): void {
	if (opts.skipBuild) {
		logger.info("⏭️  Skipping post-merge rebuild (--no-build).");
		return;
	}
	if (!hasBuildScript(cwd)) {
		logger.info("⏭️  No 'build' script in package.json — nothing to regenerate.");
		return;
	}
	if (!haveBun()) {
		logger.info("⏭️  bun not found on PATH — skipping post-merge rebuild. If this repo tracks built output, it may now be stale.");
		return;
	}

	logger.info("🔨 Rebuilding tracked artifacts after the merge...");
	try {
		execSync("bun run build", { cwd, stdio: "ignore" });
	} catch (err: any) {
		const detail = err?.stderr?.toString?.() || err?.message || String(err);
		throw new BuildFailureError(
			`The merged tree does not build, so it was NOT pushed.\n` +
			`The merge commit exists locally in ${cwd} — nothing is lost.\n` +
			`Fix the build there and push, or undo the merge commit if you prefer.\n` +
			`Underlying error:\n${detail}`
		);
	}

	const delta = execSync("git status --porcelain", { cwd, encoding: "utf8" }).trim();
	if (delta === "") {
		logger.info("✅ Build output already current — no rebuild commit needed.");
		return;
	}

	// A separate commit, not an amend: it keeps "what the merge did" and "what the
	// build did" independently auditable, which matters because build output can
	// change for reasons unrelated to the source (#172).
	execSync("git add -A", { cwd, stdio: "ignore" });
	execSync(`git commit -m "build: regenerate tracked artifacts after merging ${targetHash.substring(0, 7)} (#177) 👑π🐱"`, { cwd, stdio: "ignore" });
	logger.info(`✅ Rebuilt artifacts committed:\n${delta}`);
}

// ---
// Post-merge branch cleanup: check cleanliness, prompt to delete, retire the branch.
// Called after a successful merge+push, while still on the feature branch.
//
// Worktree-aware since #143. When a dedicated main worktree exists, this worktree
// CANNOT switch to main — git refuses to check out a branch already checked out
// elsewhere, so the old unconditional `git checkout main` could never succeed in
// the layout this repo now standardises on. Detaching instead is legal, because a
// detached HEAD does not claim the branch, which then frees `git branch -d`.
//
// Ordering is local-first on purpose (#143.2). The old order deleted the REMOTE
// branch first, so the failure above left remote-gone/local-present — the state
// that later makes `git branch -d` report "not merged to upstream" against an
// upstream that no longer exists. Local-first leaves remote-present/local-gone
// on failure, which is inert and re-runnable.
// ---
async function cleanupBranch(currentBranch: string, cwd: string, logger: MergeLogger, autoCleanup = false, mainCwd = ""): Promise<void> {
	const status = execSync("git status --porcelain", { cwd, encoding: "utf8" }).trim();

	if (status !== "") {
		// Branch is dirty — show what's uncommitted and leave the decision to the user
		logger.info(`\n⚠️  Branch '${currentBranch}' has uncommitted changes. Cannot safely delete.`);
		try {
			const diffStat = execSync("git diff --stat", { cwd, encoding: "utf8" }).trim();
			if (diffStat) logger.info(`\n${diffStat}`);
		} catch { /* ignore */ }
		logger.info(`\n💡 To clean up manually after committing/stashing:\n   git checkout main\n   git branch -D ${currentBranch}\n   git push origin --delete ${currentBranch}`);
		return;
	}

	// Verify branch is fully merged into origin/main (safety check)
	try {
		execSync(`git merge-base --is-ancestor ${currentBranch} origin/main`, { cwd, stdio: "ignore" });
	} catch {
		logger.info(`\n⚠️  Branch '${currentBranch}' is not an ancestor of origin/main. Refusing to delete.`);
		logger.info(`💡 Verify merge completed, then clean up manually.`);
		return;
	}

	let answer = autoCleanup;
	if (!autoCleanup) {
		answer = await logger.prompt(`\n🗑️  Delete feature branch '${currentBranch}' (local + remote) and switch to main? [y/N] `);
	}

	if (!answer) {
		logger.info(`\n💡 Branch '${currentBranch}' kept. To clean up later:\n   git checkout main\n   git branch -D ${currentBranch}\n   git push origin --delete ${currentBranch}`);
		return;
	}

	// --- Local first (#143.2): nothing is deleted remotely until the local branch is gone.
	const inWorktreeLayout = !!mainCwd && mainCwd !== cwd;
	if (inWorktreeLayout) {
		// `main` is checked out in the main clone, so this worktree cannot take it.
		// Detaching onto main's commit releases the feature branch without claiming main.
		logger.info(`🔀 Detaching this worktree from '${currentBranch}' (main stays checked out at ${mainCwd})...`);
		execSync("git checkout --detach main", { cwd, stdio: "ignore" });
	} else {
		logger.info(`🔀 Switching to 'main' and deleting local branch '${currentBranch}'...`);
		execSync("git checkout main", { cwd, stdio: "ignore" });
	}

	// -d, not -D (#143.4): the ancestor check above already proved this branch is in
	// origin/main, and HEAD now sits on a commit containing it. Force would only hide
	// the case where that check was wrong.
	try {
		execSync(`git branch -d ${currentBranch}`, { cwd, stdio: "ignore" });
		logger.info(`✅ Local branch '${currentBranch}' deleted.`);
	} catch (err: any) {
		const msg = err?.stderr || err?.message || String(err);
		logger.error(`⚠️  Failed to delete local branch '${currentBranch}': ${String(msg).trim()}`);
		logger.info(`✅ The merge itself succeeded and was pushed — nothing needs undoing.`);
		logger.info(`💡 Remote branch 'origin/${currentBranch}' was left in place, so nothing is half-deleted. Re-run cleanup once resolved.`);
		return;
	}

	logger.info(`📡 Deleting remote branch 'origin/${currentBranch}'...`);
	try {
		execSync(`git push origin --delete ${currentBranch}`, { cwd, stdio: "ignore" });
		logger.info(`✅ Remote branch 'origin/${currentBranch}' deleted.`);
	} catch (err: any) {
		const msg = err?.stderr || err?.message || String(err);
		logger.error(`⚠️  Failed to delete remote branch: ${String(msg).trim()}`);
		logger.info(`💡 Local branch is already gone; finish with: git push origin --delete ${currentBranch}`);
	}

	if (inWorktreeLayout) {
		logger.info(`💪 Ready for the next task! This worktree is on a detached HEAD at 'main'.`);
		logger.info(`💡 The worktree itself is still here — removing it is a manual step: git worktree remove ${cwd}`);
	} else {
		logger.info(`💪 Ready for the next task! You are on branch 'main'.`);
	}
}

/**
 * Run cleanup without letting it fail the merge (#143.3).
 *
 * `bin/merge.ts` prints "❌ Merge Aborted" for any throw out of runMerge. Cleanup
 * happens AFTER the merge landed and was pushed, so a throw from here used to
 * report a successful merge as a failure — telling the user to undo work that
 * actually succeeded. Cleanup is best-effort by construction.
 */
async function cleanupBranchBestEffort(currentBranch: string, cwd: string, logger: MergeLogger, autoCleanup: boolean, mainCwd: string): Promise<void> {
	try {
		await cleanupBranch(currentBranch, cwd, logger, autoCleanup, mainCwd);
	} catch (err: any) {
		const msg = err?.stderr || err?.message || String(err);
		logger.error(`\n⚠️  Branch cleanup failed — but the merge itself succeeded and was pushed.`);
		logger.error(`   ${String(msg).trim()}`);
		logger.info(`💡 Nothing needs undoing. Clean up by hand when convenient:\n   git branch -d ${currentBranch}\n   git push origin --delete ${currentBranch}`);
	}
}

export async function runMerge(argsList: string[], logger: MergeLogger, autoCleanup = false, opts: MergeOptions = {}): Promise<void> {
	logger.info("🔄 Running merge validation checks...");

	const currentCwd = process.cwd();

	// 1. Get current branch name
	const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: currentCwd, encoding: "utf8" }).trim();
	if (currentBranch === "main") {
		if (process.argv.includes("--cleanup")) {
			logger.info("Already on 'main' — nothing to clean up.");
			return;
		}
		throw new Error("You are already on the 'main' branch/worktree. Cannot merge main into itself.");
	}

	// 2. Check that current worktree is clean
	const currentStatus = execSync("git status --porcelain", { cwd: currentCwd, encoding: "utf8" }).trim();
	if (currentStatus !== "") {
		throw new Error(`Your current branch worktree (${currentBranch}) is not clean. Please commit or stash changes first.\n${currentStatus}`);
	}

	// 3. Fetch remote first to ensure our remote-tracking reference is current
	logger.info("📡 Fetching origin to update remote tracking references...");
	execSync("git fetch origin", { cwd: currentCwd, stdio: "ignore" });

	// 4. Determine target commit
	const localHash = execSync("git rev-parse HEAD", { cwd: currentCwd, encoding: "utf8" }).trim();
	let targetHash = "";
	const ref = argsList[0];

	if (ref) {
		try {
			targetHash = execSync(`git rev-parse ${ref}`, { cwd: currentCwd, encoding: "utf8" }).trim();
		} catch {
			throw new Error(`The provided reference '${ref}' is not a valid Git commit or branch name.`);
		}

		// Verify targetHash is an ancestor of local HEAD
		try {
			execSync(`git merge-base --is-ancestor ${targetHash} HEAD`, { cwd: currentCwd });
		} catch {
			throw new Error(`The target commit '${ref}' (${targetHash.substring(0, 7)}) is not in the history of the current branch '${currentBranch}'.`);
		}
	} else {
		targetHash = localHash;
	}

	// 5. Check if target commit has been pushed to remote
	let isPushed = false;
	try {
		execSync(`git merge-base --is-ancestor ${targetHash} origin/${currentBranch}`, { cwd: currentCwd });
		isPushed = true;
	} catch {
		isPushed = false;
	}

	if (!isPushed) {
		throw new Error(`The target commit ${targetHash.substring(0, 7)} has not been pushed to 'origin/${currentBranch}'. Please push your changes first.`);
	}

	// 6. Validate that the target commit was a Step 5 (code + spec approved) commit
	const targetCommitMsg = execSync(`git log -1 --pretty=%B ${targetHash}`, { cwd: currentCwd, encoding: "utf8" }).trim();
	if (!isStep5ApprovedMessage(targetCommitMsg)) {
		let suggestedStep5Hash = "";
		let suggestedStep5Msg = "";
		try {
			const logLines = execSync('git log --pretty=format:"%H %s" -n 50', { cwd: currentCwd, encoding: "utf8" }).trim().split("\n");
			for (const line of logLines) {
				const spaceIdx = line.indexOf(" ");
				if (spaceIdx !== -1) {
					const hash = line.substring(0, spaceIdx).trim();
					const msg = line.substring(spaceIdx + 1).trim();
					if (isStep5ApprovedMessage(msg)) {
						suggestedStep5Hash = hash;
						suggestedStep5Msg = msg;
						break;
					}
				}
			}
		} catch {
			// ignore
		}

		let errorMsg = `The target commit ${targetHash.substring(0, 7)} is not a Step 5 (code + spec approved) commit.\nTarget commit message: "${targetCommitMsg.split("\n")[0]}"\nMerges to main are only permitted for commits in the Step 5 Approved state.\n${STEP5_RULE_TEXT}`;

		if (suggestedStep5Hash) {
			errorMsg += `\n\n💡 Suggestion: A previous Step 5 commit was found in your history:\n   Hash: \x1b[33m${suggestedStep5Hash.substring(0, 7)}\x1b[0m\n   Message: "${suggestedStep5Msg}"\n\nTo merge up to that stable checkpoint, run:\n   \x1b[36mmerge ${suggestedStep5Hash.substring(0, 7)}\x1b[0m`;
		}
		throw new Error(errorMsg);
	}

	// 7. Locate a dedicated 'main' worktree, if one exists.
	const worktreeLines = execSync("git worktree list", { cwd: currentCwd, encoding: "utf8" }).trim().split("\n");
	let mainCwd = "";
	for (const line of worktreeLines) {
		if (line.includes("[main]")) {
			const idx = line.lastIndexOf("[main]");
			const beforeBranch = line.substring(0, idx).trim();
			const spaceIdx = beforeBranch.lastIndexOf(" ");
			mainCwd = spaceIdx !== -1 ? beforeBranch.substring(0, spaceIdx).trim() : beforeBranch;
		}
	}
	const haveMainWorktree = !!mainCwd && fs.existsSync(mainCwd) && mainCwd !== currentCwd;

	if (haveMainWorktree) {
		const mainStatus = execSync("git status --porcelain", { cwd: mainCwd, encoding: "utf8" }).trim();
		if (mainStatus !== "") {
			throw new Error(`The 'main' branch worktree at ${mainCwd} is not clean. Please clean or stash changes there first.\n${mainStatus}`);
		}
		logger.info("📡 Pulling latest 'main' from origin...");
		execSync("git checkout main", { cwd: mainCwd, stdio: "ignore" });
		execSync("git pull --ff-only origin main", { cwd: mainCwd, stdio: "ignore" });
		logger.info(`🔀 Merging target commit ${targetHash.substring(0, 7)} into 'main' in the main worktree...`);
		execSync(`git merge ${targetHash}`, { cwd: mainCwd, stdio: "ignore" });
		// Rebuild BEFORE the push so a single push carries the merge and its artifacts (#177).
		rebuildArtifacts(mainCwd, targetHash, logger, opts);
		logger.info("📡 Pushing merged 'main' branch to origin...");
		execSync("git push origin main", { cwd: mainCwd, stdio: "ignore" });
		logger.info(`🎉 Success! Merged target commit ${targetHash.substring(0, 7)} into 'main' and pushed to origin.`);
		await cleanupBranchBestEffort(currentBranch, currentCwd, logger, autoCleanup, mainCwd);
	} else {
		logger.info("🪵 No dedicated 'main' worktree found — using in-place single-checkout merge.");
		try {
			let hasLocalMain = true;
			try {
				execSync("git rev-parse --verify --quiet refs/heads/main", { cwd: currentCwd, stdio: "ignore" });
			} catch {
				hasLocalMain = false;
			}
			logger.info("📡 Checking out and updating 'main'...");
			if (hasLocalMain) {
				execSync("git checkout main", { cwd: currentCwd, stdio: "ignore" });
				execSync("git pull --ff-only origin main", { cwd: currentCwd, stdio: "ignore" });
			} else {
				execSync("git checkout -b main origin/main", { cwd: currentCwd, stdio: "ignore" });
			}
			logger.info(`🔀 Merging target commit ${targetHash.substring(0, 7)} into 'main'...`);
			execSync(`git merge ${targetHash}`, { cwd: currentCwd, stdio: "ignore" });
			// Rebuild BEFORE the push so a single push carries the merge and its artifacts (#177).
			rebuildArtifacts(currentCwd, targetHash, logger, opts);
			logger.info("📡 Pushing merged 'main' branch to origin...");
			execSync("git push origin main", { cwd: currentCwd, stdio: "ignore" });
		} catch (mergeErr: any) {
			// A build failure is not a merge failure — the merge landed, nothing was
			// rolled back, and only the push was withheld. Let it through untouched.
			if (mergeErr?.buildFailure) throw mergeErr;
			try { execSync("git merge --abort", { cwd: currentCwd, stdio: "ignore" }); } catch { /* not mid-merge */ }
			const detail = mergeErr?.message || String(mergeErr);
			throw new Error(
				`In-place merge into 'main' failed and was rolled back (you are back on '${currentBranch}').\n` +
				`Likely a merge conflict or a non-fast-forward 'main' (someone pushed). Fix by updating 'main' and re-running, ` +
				`or resolve manually.\nUnderlying error:\n${detail}`
			);
		} finally {
			try { execSync(`git checkout ${currentBranch}`, { cwd: currentCwd, stdio: "ignore" }); } catch { /* best-effort */ }
		}
		logger.info(`🎉 Success! Merged target commit ${targetHash.substring(0, 7)} into 'main' and pushed to origin.`);
		await cleanupBranchBestEffort(currentBranch, currentCwd, logger, autoCleanup, "");
	}
}
