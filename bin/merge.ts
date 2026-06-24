#!/usr/bin/env node
/**
 * @package princess-pi-packages
 * @command merge
 * @description Standalone CLI port of extensions/merge.ts (Git→main Merger).
 * Reuses extensions/lib/merge/* directly (no duplicated logic).
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMerge } from "../extensions/lib/merge/core.js";
import { renderHelp } from "../extensions/lib/merge/help.js";

function run() {
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

	try {
		runMerge(argsList, {
			info: (msg) => console.log(msg),
			error: (msg) => console.error(msg),
		});
	} catch (err: any) {
		const errMsg = err?.message || String(err);
		console.error(`❌ Merge Aborted:\n${errMsg}`);
		process.exitCode = 1;
	}
}

run();