import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---
// HELPERS
// ---

/**
 * Resolves a raw path string. Handles home directory symbol '~' and relative paths.
 */
function resolvePath(inputPath: string): string {
	const trimmed = inputPath.trim();
	if (trimmed.startsWith("~")) {
		return path.join(os.homedir(), trimmed.slice(1));
	}
	return path.resolve(process.cwd(), trimmed);
}

/**
 * Validates whether the target path is a valid and existing directory.
 * Adheres to Option A: Fail Fast.
 */
function validateDirectory(resolvedPath: string): { ok: true } | { ok: false; error: string } {
	if (!fs.existsSync(resolvedPath)) {
		return { ok: false, error: `Path does not exist: "${resolvedPath}"` };
	}
	try {
		const stat = fs.statSync(resolvedPath);
		if (!stat.isDirectory()) {
			return { ok: false, error: `Path is not a directory: "${resolvedPath}"` };
		}
	} catch (err: any) {
		return { ok: false, error: `Failed to read path attributes: ${err.message}` };
	}
	return { ok: true };
}

/**
 * Performs the actual process-level working directory shift and triggers UI updates.
 */
function changeCwd(targetPath: string, ctx: any): boolean {
	const resolved = resolvePath(targetPath);
	const validation = validateDirectory(resolved);

	if (!validation.ok) {
		if (ctx?.ui) {
			ctx.ui.notify(`❌ Directory Change Failed: ${validation.error}`, "error");
		}
		return false;
	}

	try {
		process.chdir(resolved);
		
		// Dynamic TUI Sync: Update the session manager's internal CWD state
		if (ctx && typeof ctx === "object") {
			if ("sessionManager" in ctx && ctx.sessionManager) {
				try {
					ctx.sessionManager.cwd = resolved;
				} catch (_) {}
			}
		}

		if (ctx?.ui) {
			ctx.ui.notify(`📁 Workspace changed to: ${resolved}`, "info");
		}
		return true;
	} catch (err: any) {
		if (ctx?.ui) {
			ctx.ui.notify(`❌ Failed to change directory: ${err.message}`, "error");
		}
		return false;
	}
}

/**
 * Permanently relocates the active .jsonl session file on disk to the standard target
 * session folder, rewrites the header cwd metadata, re-binds the session manager, and shifts CWD.
 */
function moveSessionAndCwd(targetPath: string, ctx: any): boolean {
	const resolvedTarget = resolvePath(targetPath);
	const validation = validateDirectory(resolvedTarget);

	if (!validation.ok) {
		if (ctx?.ui) {
			ctx.ui.notify(`❌ Session Move Failed: ${validation.error}`, "error");
		}
		return false;
	}

	const oldSessionFile = ctx?.sessionManager?.getSessionFile();

	// If no session file is active (ephemeral mode), behave exactly like /cd
	if (!oldSessionFile || !fs.existsSync(oldSessionFile)) {
		const success = changeCwd(resolvedTarget, ctx);
		if (success && ctx?.ui) {
			ctx.ui.notify(`📁 Ephemeral session workspace changed to: ${resolvedTarget} (No file to move)`, "info");
		}
		return success;
	}

	try {
		// 1. Compute target session directory path
		const safePath = `--${resolvedTarget.replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-")}--`;
		const targetSessionDir = path.join(os.homedir(), ".pi/agent/sessions", safePath);

		// Create target folder if it does not exist
		if (!fs.existsSync(targetSessionDir)) {
			fs.mkdirSync(targetSessionDir, { recursive: true });
		}

		// 2. Generate new session file path
		const fileName = path.basename(oldSessionFile);
		const newSessionFile = path.join(targetSessionDir, fileName);

		if (oldSessionFile === newSessionFile) {
			if (ctx?.ui) {
				ctx.ui.notify(`ℹ️ Session is already located in the target directory folder.`, "info");
			}
			return changeCwd(resolvedTarget, ctx);
		}

		// 3. Move file and update the header CWD
		const fileContent = fs.readFileSync(oldSessionFile, "utf8");
		const lines = fileContent.trim().split("\n");
		if (lines.length > 0) {
			try {
				const header = JSON.parse(lines[0]);
				if (header.type === "session") {
					header.cwd = resolvedTarget;
					lines[0] = JSON.stringify(header);
				}
			} catch (_) {}
		}

		// Write to new path
		fs.writeFileSync(newSessionFile, lines.join("\n") + "\n");

		// Delete old file
		fs.unlinkSync(oldSessionFile);

		// 4. Re-bind the session manager to the new file on disk and set CWD state
		if (ctx?.sessionManager) {
			ctx.sessionManager.setSessionFile(newSessionFile);
			ctx.sessionManager.cwd = resolvedTarget;
		}

		// 5. Shift process-level CWD
		process.chdir(resolvedTarget);

		if (ctx?.ui) {
			ctx.ui.notify(`📁 Session permanently moved to: ${resolvedTarget}`, "info");
			ctx.ui.notify(`⚠️ Please type '/reload' now to flush the previous directory's instructions and fully load your new workspace settings, prompts, and local AGENTS.md guidelines!`, "warning");
		}
		return true;
	} catch (err: any) {
		if (ctx?.ui) {
			ctx.ui.notify(`❌ Error moving session: ${err.message}`, "error");
		}
		return false;
	}
}

// ---
// EXTENSION ENTRYPOINT
// ---

export default function cdCommandExtension(pi: ExtensionAPI) {
	// 1. Register TUI slash command for Human (Dynamic Pivot)
	pi.registerCommand("cd", {
		description: "Change the current working directory of the Pi session dynamically (Option A: Fail Fast)",
		handler: async (args, ctx) => {
			const target = (args || "").trim();
			if (!target) {
				if (ctx?.ui) {
					ctx.ui.notify("ℹ️ Usage: /cd <path>", "info");
				}
				return;
			}
			changeCwd(target, ctx);
		}
	});

	// 2. Register TUI slash command for Human (Permanent Session Relocation)
	pi.registerCommand("mv-session", {
		description: "Permanently move the active session and CWD to a new target directory (Option A: Fail Fast)",
		handler: async (args, ctx) => {
			const target = (args || "").trim();
			if (!target) {
				if (ctx?.ui) {
					ctx.ui.notify("ℹ️ Usage: /mv-session <path>", "info");
				}
				return;
			}
			moveSessionAndCwd(target, ctx);
		}
	});

	// 3. Register Custom Tool for Agent
	pi.registerTool({
		name: "change_working_directory",
		label: "Change Working Directory",
		description: "Change the current working directory of the active Pi session dynamically (Option A: Fail Fast). Use this tool whenever you need to shift your focus to a different folder/project.",
		parameters: Type.Object({
			path: Type.String({ description: "The target directory path (supports ~, relative, or absolute)" })
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const success = changeCwd(params.path, ctx);
			const resolved = resolvePath(params.path);
			
			if (success) {
				return {
					content: [{ type: "text", text: `📁 Successfully changed working directory to: ${resolved}` }],
					details: { path: resolved, success: true }
				};
			} else {
				return {
					content: [{ type: "text", text: `❌ Failed to change working directory to: ${resolved}` }],
					details: { path: resolved, success: false },
					error: { message: `Directory does not exist or is invalid: ${params.path}` }
				};
			}
		}
	});
}
