/**
 * @package princess-pi-packages
 * @module config
 * @description Harness-agnostic config persistence for all CLI tools.
 *
 * Config hierarchy (lowest to highest precedence):
 *   1. Code defaults (hardcoded in each tool)
 *   2. User-global: ~/.config/princess-pi/<tool>.json
 *   3. Project-local: ./.princess-pi/<tool>.json
 *   4. CLI flags (highest — applied by caller after readConfig)
 *
 * Write target: project-local if it already exists, otherwise user-global.
 * Callers may override scope explicitly via writeConfig's scope parameter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---
// TYPES
// ---

export interface ConfigPaths {
	/** ~/.config/princess-pi/<tool>.json */
	global: string;
	/** ./.princess-pi/<tool>.json (relative to cwd) */
	local: string;
}

/**
 * Settings shape for wtft (the initial consumer; other tools extend this).
 * All fields are optional — missing keys inherit from the layer below.
 */
export interface WtftConfig {
	interval?: string;
	limit?: number;
	mode?: "bucket" | "cumulative";
	showTicks?: boolean;
	timezone?: string;
	disabledEmoji?: boolean;
}

// ---
// PATH RESOLUTION
// ---

/**
 * Resolve config file paths for a tool.
 * Global: ~/.config/princess-pi/<tool>.json
 * Local:  ./.princess-pi/<tool>.json (relative to cwd)
 */
export function getConfigPaths(toolName: string): ConfigPaths {
	const globalDir = path.join(os.homedir(), ".config", "princess-pi");
	const localDir = path.join(process.cwd(), ".princess-pi");
	return {
		global: path.join(globalDir, `${toolName}.json`),
		local: path.join(localDir, `${toolName}.json`),
	};
}

// ---
// READ (merge: global → local)
// ---

/**
 * Read merged config for a tool. Returns an empty object if no config
 * files exist. Local keys override global keys.
 */
export function readConfig(toolName: string): Record<string, unknown> {
	const paths = getConfigPaths(toolName);
	const merged: Record<string, unknown> = {};

	// Layer 1: user-global config
	try {
		const globalRaw = fs.readFileSync(paths.global, "utf8");
		const globalData = JSON.parse(globalRaw);
		if (globalData && typeof globalData === "object" && !Array.isArray(globalData)) {
			Object.assign(merged, globalData);
		}
	} catch {
		// No global config — fine, proceed
	}

	// Layer 2: project-local config (overrides global)
	try {
		const localRaw = fs.readFileSync(paths.local, "utf8");
		const localData = JSON.parse(localRaw);
		if (localData && typeof localData === "object" && !Array.isArray(localData)) {
			Object.assign(merged, localData);
		}
	} catch {
		// No local config — fine, proceed
	}

	return merged;
}

// ---
// WRITE (merge into existing config at target scope)
// ---

/**
 * Persist settings for a tool. Merges into existing config at the target
 * file (reads first, overlays new keys, writes back).
 *
 * Scope resolution (when scope is omitted):
 *   - If ./.princess-pi/<tool>.json already exists → write local
 *   - Otherwise → write global (~/.config/princess-pi/<tool>.json)
 */
export function writeConfig(
	toolName: string,
	settings: Record<string, unknown>,
	scope?: "local" | "global",
): void {
	const paths = getConfigPaths(toolName);

	// Resolve target path
	let targetPath: string;
	if (scope === "local") {
		targetPath = paths.local;
	} else if (scope === "global") {
		targetPath = paths.global;
	} else if (fs.existsSync(paths.local)) {
		targetPath = paths.local;
	} else {
		targetPath = paths.global;
	}

	// Read existing config at target, overlay new settings
	let existing: Record<string, unknown> = {};
	try {
		const raw = fs.readFileSync(targetPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			existing = parsed;
		}
	} catch {
		// File doesn't exist or is corrupt — start fresh
	}

	const merged = { ...existing, ...settings };

	// Ensure directory exists
	const dir = path.dirname(targetPath);
	fs.mkdirSync(dir, { recursive: true });

	fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Check whether any config file exists for a tool (global or local).
 * Used by wtft to auto-show the widget on session_start when the user
 * has configured the tool at least once.
 */
export function hasConfig(toolName: string): boolean {
	const paths = getConfigPaths(toolName);
	return fs.existsSync(paths.global) || fs.existsSync(paths.local);
}
