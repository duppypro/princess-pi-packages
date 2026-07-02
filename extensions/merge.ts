import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { runMerge } from "./lib/merge/core.js";
import { renderHelp, renderWhy } from "./lib/merge/help.js";

// ---
// MAIN EXTENSION ENTRY POINT
// ---

export default function mergeExtension(pi: ExtensionAPI) {
	pi.registerCommand("merge", {
		description: "Multi-Worktree Git Merger",
		handler: async (args, ctx) => {
			const argsList = (args || "").trim().split(/\s+/).filter(Boolean);
			if (argsList.includes("-h") || argsList.includes("--help")) {
				try {
					const manifestPath = path.join(process.cwd(), "docs", "manifests", "merge-cmd.json");
					const helpText = renderHelp(manifestPath, "/merge");
					ctx.ui.notify(helpText, "info");
				} catch (err) {
					ctx.ui.notify(`⚠️ Failed to load MERGE command manifest: ${err}`, "error");
				}
				return;
			}

			if (argsList.includes("--why")) {
				try {
					const manifestPath = path.join(process.cwd(), "docs", "manifests", "merge-cmd.json");
					const whyText = renderWhy(manifestPath, "/merge");
					ctx.ui.notify(whyText, "info");
				} catch (err) {
					ctx.ui.notify(`⚠️ Failed to load MERGE command manifest: ${err}`, "error");
				}
				return;
			}

			try {
				await runMerge(argsList, {
					info: (msg) => ctx.ui.notify(msg, "info"),
					error: (msg) => ctx.ui.notify(msg, "error"),
					prompt: async (question: string): Promise<boolean> => {
						// Pi slash commands can't do interactive prompts — show notification with manual commands
						ctx.ui.notify(question + "\n(Run this command from the CLI shell for interactive cleanup.)", "info");
						return false;
					},
				});
			} catch (err: any) {
				const errMsg = err?.message || String(err);
				ctx.ui.notify(`❌ Merge Aborted:\n${errMsg}`, "error");
			}
		}
	});
}