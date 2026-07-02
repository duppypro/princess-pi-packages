#!/usr/bin/env node
/**
 * @package princess-pi-packages
 * @command merge
 * @description Standalone CLI port of extensions/merge.ts (Git→main Merger).
 * Reuses extensions/lib/merge/* directly (no duplicated logic).
 */
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { runMerge } from "../extensions/lib/merge/core.js";
import { renderHelp, renderWhy } from "../extensions/lib/merge/help.js";

async function run() {
	const argsList = process.argv.slice(2).filter(Boolean);

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
	const filteredArgs = argsList.filter(a => a !== "--cleanup");

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
		}, autoCleanup);
	} catch (err: any) {
		const errMsg = err?.message || String(err);
		console.error(`❌ Merge Aborted:\n${errMsg}`);
		process.exitCode = 1;
	}
}

run();