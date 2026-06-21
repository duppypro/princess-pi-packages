#!/usr/bin/env node
/**
 * @package princess-pi-packages
 * @command merge
 * @description Standalone CLI port of extensions/merge.ts (Git→main Merger).
 * Runs the identical validation/merge/push sequence without the Pi runtime —
 * invokable directly (node bin/merge.mjs <ref>), via the ./merge wrapper, or as the
 * npm-global `merge` bin.
 *
 * Why plain ESM JavaScript (.mjs), not a TypeScript bin: this tool is installed
 * GLOBALLY (`npm install -g github:duppypro/princess-pi-packages`) for cross-harness
 * use (Claude Code). Node refuses `--experimental-strip-types` for files living under
 * `node_modules/` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING — exactly where a global
 * install puts this file), and an `npx tsx` shebang would trigger a per-environment
 * network fetch. Plain `#!/usr/bin/env node` JS needs zero deps, no build step, and
 * runs anywhere. The typed twin remains extensions/merge.ts (the Pi runtime version).
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// --- Step-5 gate matcher (shared by the validation check and the suggestion scan).
// Loosened from a literal `startsWith("Code and Spec Approved:")` to accept our actual
// commit convention `Code and Spec Approved (Step 5): ...` — i.e. an optional
// parenthetical (and surrounding whitespace) before the colon. Why a single shared
// const: the gate and the "did you mean this commit?" suggestion must agree exactly.
const STEP5_SUBJECT = /^Code and Spec Approved(\s*\([^)]*\))?\s*:/;

function run() {
	const argsList = process.argv.slice(2).filter(Boolean);

	if (argsList.includes("-h") || argsList.includes("--help")) {
		try {
			// Resolve the manifest relative to THIS script, not process.cwd(): once installed
			// globally the tool runs from arbitrary repos (rogue-savvy, etc.) where cwd/docs
			// doesn't exist. bin/ is one level under the package root, so go up one.
			const scriptDir = path.dirname(fileURLToPath(import.meta.url));
			const manifestPath = path.join(scriptDir, "..", "docs", "manifests", "merge-cmd.json");
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			const invokedAs = "merge"; // npm-global bin name; `./merge` wrapper also works

			let helpText = `\x1b[1m\x1b[36m${manifest.name}\x1b[0m - ${manifest.tagline}\n\n`;
			helpText += `${manifest.description}\n\n`;
			// Examples first (with mock parameters), full flag enumeration after —
			// see CLAUDE.md "Manifest-driven --help" convention.
			helpText += `\x1b[1mExamples:\x1b[0m\n`;
			for (const e of manifest.examples) {
				const fullCmd = e.args ? `${invokedAs} ${e.args}` : invokedAs;
				helpText += `  ${fullCmd.padEnd(30)} ${e.desc}\n`;
			}
			helpText += `\n\x1b[1mUsage:\x1b[0m\n`;
			for (const u of manifest.usage) {
				helpText += `  ${invokedAs} ${u.flags.padEnd(28)} ${u.desc}\n`;
			}
			console.log(helpText);
		} catch (err) {
			console.error(`⚠️ Failed to load merge command manifest: ${err}`);
			process.exitCode = 1;
		}
		return;
	}

	console.log("🔄 Running merge validation checks...");

	try {
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
		console.log("📡 Fetching origin to update remote tracking references...");
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

			// Verify targetHash is an ancestor of local HEAD (belongs to this branch's history)
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
			// --- Multi-worktree path (Pi's original design): merge inside the isolated
			// 'main' worktree, never disturbing the feature checkout.
			const mainStatus = execSync("git status --porcelain", { cwd: mainCwd, encoding: "utf8" }).trim();
			if (mainStatus !== "") {
				throw new Error(`The 'main' branch worktree at ${mainCwd} is not clean. Please clean or stash changes there first.\n${mainStatus}`);
			}
			console.log("📡 Pulling latest 'main' from origin...");
			execSync("git checkout main", { cwd: mainCwd, stdio: "ignore" });
			execSync("git pull --ff-only origin main", { cwd: mainCwd, stdio: "ignore" });
			console.log(`🔀 Merging target commit ${targetHash.substring(0, 7)} into 'main' in the main worktree...`);
			execSync(`git merge ${targetHash}`, { cwd: mainCwd, stdio: "ignore" });
			console.log("📡 Pushing merged 'main' branch to origin...");
			execSync("git push origin main", { cwd: mainCwd, stdio: "ignore" });
			console.log(`🎉 Success! Merged target commit ${targetHash.substring(0, 7)} into 'main' and pushed to origin.`);
			console.log(`💪 Ready for the next task! You are in worktree '${currentCwd}' on branch '${currentBranch}'.`);
		} else {
			// --- Single-checkout fallback (the common Claude Code case): no dedicated
			// 'main' worktree, so integrate in-place. We checkout main here, merge, push,
			// then ALWAYS return to the feature branch — even on failure — so the user is
			// never stranded on main or mid-merge. The current tree was verified clean at
			// step 2, so switching branches is safe.
			console.log("🪵 No dedicated 'main' worktree found — using in-place single-checkout merge.");
			try {
				// Ensure a local 'main' exists (fresh clones may only have origin/main).
				let hasLocalMain = true;
				try {
					execSync("git rev-parse --verify --quiet refs/heads/main", { cwd: currentCwd, stdio: "ignore" });
				} catch {
					hasLocalMain = false;
				}
				console.log("📡 Checking out and updating 'main'...");
				if (hasLocalMain) {
					execSync("git checkout main", { cwd: currentCwd, stdio: "ignore" });
					execSync("git pull --ff-only origin main", { cwd: currentCwd, stdio: "ignore" });
				} else {
					execSync("git checkout -b main origin/main", { cwd: currentCwd, stdio: "ignore" });
				}
				console.log(`🔀 Merging target commit ${targetHash.substring(0, 7)} into 'main'...`);
				execSync(`git merge ${targetHash}`, { cwd: currentCwd, stdio: "ignore" });
				console.log("📡 Pushing merged 'main' branch to origin...");
				execSync("git push origin main", { cwd: currentCwd, stdio: "ignore" });
			} catch (mergeErr) {
				// Abort any half-finished merge so the working tree is restored.
				try { execSync("git merge --abort", { cwd: currentCwd, stdio: "ignore" }); } catch { /* not mid-merge */ }
				const detail = mergeErr?.message || String(mergeErr);
				throw new Error(
					`In-place merge into 'main' failed and was rolled back (you are back on '${currentBranch}').\n` +
					`Likely a merge conflict or a non-fast-forward 'main' (someone pushed). Fix by updating 'main' and re-running, ` +
					`or resolve manually.\nUnderlying error:\n${detail}`
				);
			} finally {
				// ALWAYS return to the feature branch the user started on.
				try { execSync(`git checkout ${currentBranch}`, { cwd: currentCwd, stdio: "ignore" }); } catch { /* best-effort */ }
			}
			console.log(`🎉 Success! Merged target commit ${targetHash.substring(0, 7)} into 'main' and pushed to origin.`);
			console.log(`💪 Ready for the next task! You are back in '${currentCwd}' on branch '${currentBranch}'.`);
		}
	} catch (err) {
		const errMsg = err?.message || String(err);
		console.error(`❌ Merge Aborted:\n${errMsg}`);
		process.exitCode = 1;
	}
}

run();
