/**
 * @package princess-pi-packages
 * @module session-path-shortener
 * @description Shared path/name shortener utilities for Pi and Claude Code session display.
 *
 * Cross-harness pattern: this module provides compact display paths for session logs
 * and generic path ellipsis, used by both the WTFT CLI/extension and the Serve extension.
 *
 * No external dependencies beyond Node builtins (path, os).
 * Kept as TypeScript for type safety; the esbuild build step bundles it into .mjs CLI bins.
 */

import * as path from "node:path";
import * as os from "node:os";

// ---
// SMART SESSION PATH SHORTENER
// ---

/**
 * Build a compact display path from a session file's directory slug and filename.
 *
 * Pi slugs use `--` as path separators (e.g. `--home-user--git-projects--project--`).
 * Claude slugs use `-` and are lossy, so we reconstruct from the known prefix structure.
 *
 * Transformations:
 *   - `/home/<user>/git-projects/<project>` → `~/g-p/<project>` (known prefix compaction)
 *   - Generic slugs have hyphens replaced with slashes for path-like display
 *   - UUID tail extracted (first 4 hex chars from `([a-f0-9]{4}).jsonl`)
 *   - Pi date prefix extracted from `YYYY-MM-DD_...` filenames
 *
 * @param filename - The session file name (e.g. "2026-07-01_session_abc12345.jsonl")
 * @param dirSlug - The directory slug (e.g. "--home-user--git-projects-project--" or "home-user-git-projects-project")
 * @param harness - "pi" or "claude-code" — affects slug wrapping and date prefix extraction
 * @returns Compact display string (e.g. "~/g-p/project/2026-07-01...abc1")
 */
export function buildDisplayPath(
	filename: string,
	dirSlug: string,
	harness: "pi" | "claude-code"
): string {
	// UUID tail: extract last 4 hex chars before .jsonl
	const uuidMatch = filename.match(/([a-f0-9]{4})\.jsonl$/i);
	const uuidTail = uuidMatch ? uuidMatch[1] : "";

	// Strip wrapping delimiters: Pi uses --prefix--suffix--, Claude uses -prefix
	// For Claude: the dirSlug is typically something like "home-user-git-projects-project"
	// For Pi: the dirSlug is "--home-user--git-projects-project--"
	const slug =
		harness === "pi"
			? dirSlug.replace(/^--/, "").replace(/--$/, "")
			: dirSlug.replace(/^-/, "");

	// --- Known path prefix compaction ---
	// Compaction rules:
	//   /home/<user>/git-projects/<project>  →  ~/g-p/<project>
	//   /home/<user>/g-p/<project>            →  ~/g-p/<project>  (already compacted)
	const homeDir = os.homedir();
	const userName = path.basename(homeDir);
	const knownPrefix = `home-${userName}-git-projects`;
	const compactPrefix = `home-${userName}-g-p`; // handle already-compacted paths

	if (slug.startsWith(knownPrefix + "-")) {
		const projectName = slug.slice(knownPrefix.length + 1); // +1 for trailing '-'
		const datePrefix = harness === "pi" ? extractDatePrefix(filename) : "";
		const pathStr = `~/g-p/${projectName}`;
		return appendTail(pathStr, datePrefix, uuidTail);
	}

	// Also handle already-compacted slugs (e.g. from watu or manual resolution)
	if (slug.startsWith(compactPrefix + "-")) {
		const projectName = slug.slice(compactPrefix.length + 1);
		const datePrefix = harness === "pi" ? extractDatePrefix(filename) : "";
		const pathStr = `~/g-p/${projectName}`;
		return appendTail(pathStr, datePrefix, uuidTail);
	}

	// --- Non-standard slug ---
	// Handle slugs that don't match the known prefix (e.g. --root--, --tmp-pi-test--)
	// Just clean up hyphens into slashes for a path-like display
	const cleanedSlug = slug.replace(/-/g, "/");
	const datePrefix = harness === "pi" ? extractDatePrefix(filename) : "";
	return appendTail(cleanedSlug, datePrefix, uuidTail);
}

/**
 * Extract a date prefix from a Pi session filename.
 * Pi names look like: "2026-07-02T01-38-34-253Z_019f207a-4e8d-7527-8290-deb8bc53268a.jsonl"
 * Claude Code names don't have this pattern.
 */
function extractDatePrefix(filename: string): string {
	// Pi date prefix is the part before the first underscore that looks like a date
	const match = filename.match(/^(\d{4}-\d{2}-\d{2}[^_]*)/);
	return match ? match[1] : "";
}

/**
 * Append a date prefix and/or UUID tail to a base path string.
 * Format: `${base}/${datePrefix}...${uuidTail}` when both present,
 *         `${base}` when neither present.
 */
function appendTail(base: string, datePrefix: string, uuidTail: string): string {
	if (datePrefix && uuidTail) {
		return `${base}/${datePrefix}...${uuidTail}`;
	}
	if (datePrefix) {
		return `${base}/${datePrefix}`;
	}
	if (uuidTail) {
		return `${base}/...${uuidTail}`;
	}
	return base;
}

// ---
// GENERIC PATH ELLIPSIS
// ---

/**
 * Shorten a file path for display by making it relative to cwd and
 * truncating with an ellipsis if it exceeds 25 characters.
 *
 * Used by the Serve extension for displaying server root directories in widgets.
 * Less smart than buildDisplayPath() — purely visual truncation, no domain knowledge.
 *
 * @param rawPath - The absolute or relative path to shorten
 * @param cwd - The current working directory (defaults to process.cwd())
 * @returns Shortened path string (e.g. "../../long/path/..." or "...ong/path/name")
 */
export function shortenPath(rawPath: string, cwd: string = process.cwd()): string {
	let rel = rawPath;
	if (path.isAbsolute(rawPath)) {
		rel = path.relative(cwd, rawPath) || rawPath;
	}
	if (rel.length > 25) {
		rel = "..." + rel.slice(-22);
	}
	return rel;
}

// ---
// RELATIVE TIME FORMATTER
// ---

/**
 * Format a timestamp as a human-readable relative time string.
 *
 * @param ts - Timestamp in milliseconds since epoch
 * @returns Relative time string (e.g. "2m ago", "3h ago", "2d ago", "just now")
 */
export function formatRelativeTime(ts: number): string {
	const diffMs = Date.now() - ts;
	const diffSec = Math.floor(diffMs / 1000);
	if (diffSec < 60) return "just now";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 30) return `${diffDay}d ago`;
	const diffMo = Math.floor(diffDay / 30);
	if (diffMo < 12) return `${diffMo}mo ago`;
	return `${Math.floor(diffDay / 365)}y ago`;
}
