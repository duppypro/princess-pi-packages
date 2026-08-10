#!/usr/bin/env node
/**
 * @package princess-pi-packages
 * @command merge
 * @description Standalone CLI port of extensions/merge.ts (Git→main Merger).
 * Reuses extensions/lib/merge/* directly (no duplicated logic).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { runMerge } from "../extensions/lib/merge/core.js";
import { renderHelp, renderWhy } from "../extensions/lib/merge/help.js";

function manifestFile(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "merge-cmd.json");
}

async function run() {
	const argsList = process.argv.slice(2).filter(Boolean);

	// --- Short-circuits: everything here must answer WITHOUT touching git (#173).
	// runMerge's first act is `git rev-parse`, so anything that falls through to it
	// dies with "fatal: not a git repository" when merge is installed outside a
	// working tree — which is exactly where a version check gets run.
	if (argsList.includes("--version")) {
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
			console.log(`${manifest.name} ${manifest.version}`);
		} catch (err) {
			console.error(`⚠️ Failed to load merge command manifest: ${err}`);
			process.exitCode = 1;
		}
		return;
	}

	if (argsList.includes("-h") || argsList.includes("--help")) {
		try {
			const scriptDir = path.dirname(fileURLToPath(import.meta.url));
			const manifestPath = path.join(scriptDir, "..", "docs", "manifests", "merge-cmd.json");
			const helpText = renderHelp(manifestPath, "merge");
			console.log(helpText);
		} catch (err) {
			console.error(`⚠️ Failed to load merge command manifest: ${err}`);
			process.exitCode = 1;
		}
		return;
	}

	if (argsList.includes("--why")) {
		try {
			const scriptDir = path.dirname(fileURLToPath(import.meta.url));
			const manifestPath = path.join(scriptDir, "..", "docs", "manifests", "merge-cmd.json");
			const whyText = renderWhy(manifestPath, "merge");
			console.log(whyText);
		} catch (err) {
			console.error(`⚠️ Failed to load merge command manifest: ${err}`);
			process.exitCode = 1;
		}
		return;
	}

	const autoCleanup = argsList.includes("--cleanup");
	const skipBuild = argsList.includes("--no-build");
	const filteredArgs = argsList.filter(a => a !== "--cleanup" && a !== "--no-build");

	try {
		await runMerge(filteredArgs, {
			info: (msg) => console.log(msg),
			error: (msg) => console.error(msg),
			prompt: async (question: string): Promise<boolean> => {
				// If stdin is not a TTY (piped input), skip interactive prompt
				if (!process.stdin.isTTY) {
					console.log(question.replace(/\n/g, " ").trim() + " (skipped — stdin is not a TTY)");
					return false;
				}
				const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
				return new Promise((resolve) => {
					rl.question(question, (answer) => {
						rl.close();
						resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
					});
				});
			},
		}, autoCleanup, { skipBuild });
	} catch (err: any) {
		const errMsg = err?.message || String(err);
		// A build failure means the merge LANDED and only the push was withheld.
		// Saying "Merge Aborted" there would tell the user to undo work that
		// succeeded — the same defect #143.3 removes from the cleanup path.
		const banner = err?.buildFailure ? "❌ Merge not pushed:" : "❌ Merge Aborted:";
		console.error(`${banner}\n${errMsg}`);
		process.exitCode = 1;
	}
}

run();