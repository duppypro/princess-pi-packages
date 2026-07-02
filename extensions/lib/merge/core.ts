import { execSync } from "node:child_process";
import * as fs from "node:fs";

export interface MergeLogger {
	info(msg: string): void;
	error(msg: string): void;
	prompt(question: string): Promise<boolean>;
}

const STEP5_SUBJECT = /^Code and Spec Approved(\s*\([^)]*\))?\s*:/;

// ---
// Post-merge branch cleanup: check cleanliness, prompt to delete, switch to main.
// Called after a successful merge+push, while still on the feature branch.
// ---
async function cleanupBranch(currentBranch: string, cwd: string, logger: MergeLogger, autoCleanup = false): Promise<void> {
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

	// Delete remote branch first, then local
	logger.info(`📡 Deleting remote branch 'origin/${currentBranch}'...`);
	try {
		execSync(`git push origin --delete ${currentBranch}`, { cwd, stdio: "ignore" });
		logger.info(`✅ Remote branch 'origin/${currentBranch}' deleted.`);
	} catch (err: any) {
		const msg = err?.stderr || err?.message || String(err);
		logger.error(`⚠️  Failed to delete remote branch: ${msg.trim()}`);
	}

	logger.info(`🔀 Switching to 'main' and deleting local branch '${currentBranch}'...`);
	execSync("git checkout main", { cwd, stdio: "ignore" });
	try {
		execSync(`git branch -D ${currentBranch}`, { cwd, stdio: "ignore" });
		logger.info(`✅ Local branch '${currentBranch}' deleted.`);
	} catch (err: any) {
		const msg = err?.stderr || err?.message || String(err);
		logger.error(`⚠️  Failed to delete local branch: ${msg.trim()}`);
	}

	logger.info(`💪 Ready for the next task! You are on branch 'main'.`);
}

export async function runMerge(argsList: string[], logger: MergeLogger, autoCleanup = false): Promise<void> {
	logger.info("🔄 Running merge validation checks...");

	const currentCwd = process.cwd();

	// 1. Get current branch name
	const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: currentCwd, encoding: "utf8" }).trim();
	if (currentBranch === "main") {
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

	// 6. Validate that the target commit was a "Code and Spec Approved" Step 5 commit
	const targetCommitMsg = execSync(`git log -1 --pretty=%B ${targetHash}`, { cwd: currentCwd, encoding: "utf8" }).trim();
	if (!STEP5_SUBJECT.test(targetCommitMsg)) {
		let suggestedStep5Hash = "";
		let suggestedStep5Msg = "";
		try {
			const logLines = execSync('git log --pretty=format:"%H %s" -n 50', { cwd: currentCwd, encoding: "utf8" }).trim().split("\n");
			for (const line of logLines) {
				const spaceIdx = line.indexOf(" ");
				if (spaceIdx !== -1) {
					const hash = line.substring(0, spaceIdx).trim();
					const msg = line.substring(spaceIdx + 1).trim();
					if (STEP5_SUBJECT.test(msg)) {
						suggestedStep5Hash = hash;
						suggestedStep5Msg = msg;
						break;
					}
				}
			}
		} catch {
			// ignore
		}

		let errorMsg = `The target commit ${targetHash.substring(0, 7)} is not a Step 5 'Code and Spec Approved' commit.\nTarget commit message: "${targetCommitMsg.split("\n")[0]}"\nMerges to main are only permitted for commits in the Step 5 Approved state.`;

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
		logger.info("📡 Pushing merged 'main' branch to origin...");
		execSync("git push origin main", { cwd: mainCwd, stdio: "ignore" });
		logger.info(`🎉 Success! Merged target commit ${targetHash.substring(0, 7)} into 'main' and pushed to origin.`);
		logger.info(`💪 Ready for the next task! You are in worktree '${currentCwd}' on branch '${currentBranch}'.`);
		await cleanupBranch(currentBranch, currentCwd, logger, autoCleanup);
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
			logger.info("📡 Pushing merged 'main' branch to origin...");
			execSync("git push origin main", { cwd: currentCwd, stdio: "ignore" });
		} catch (mergeErr: any) {
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
		logger.info(`💪 Ready for the next task! You are on branch '${currentBranch}'.`);
		await cleanupBranch(currentBranch, currentCwd, logger, autoCleanup);
	}
}
