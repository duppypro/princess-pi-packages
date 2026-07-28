import * as os from "node:os";
import { ServerInstance, KilledServerInstance, isInsideRepo } from "./domain.js";
import wcwidth from "wcwidth";

export function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Compute visual (monospace cell) width of a string after stripping ANSI escapes.
 * Delegates to wcwidth for proper Unicode East Asian Width handling (#103).
 */
export function getVisualLength(str: string): number {
	const cleanStr = stripAnsi(str);
	return wcwidth(cleanStr);
}

export function padVisual(str: string, targetLen: number): string {
	const currentLen = getVisualLength(str);
	if (currentLen >= targetLen) {
		const cleanStr = stripAnsi(str);
		let accumulated = 0;
		let result = "";
		let i = 0;
		while (i < cleanStr.length) {
			const char = cleanStr[i];
			const charWidth = wcwidth(char);
			if (accumulated + charWidth > targetLen) break;
			result += char;
			accumulated += charWidth;
			i++;
		}
		return result + " ".repeat(targetLen - accumulated);
	}
	return str + " ".repeat(targetLen - currentLen);
}

export function isEmojiDisabled(ctx: any): boolean {
	if (!ctx || !ctx.sessionManager) return false;
	let disabled = false;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === "emoji-settings") {
			if (entry.data && typeof entry.data.disabled === "boolean") {
				disabled = entry.data.disabled;
			}
		}
	}
	return disabled;
}

// --- Path display ---

const HOME = os.homedir();

/**
 * Shorten absolute paths for display: convert /home/<user>/ to ~/, leave
 * everything else unchanged (#119).
 */
function homeRelative(dir: string): string {
	if (dir === HOME) return "~";
	if (dir.startsWith(HOME + "/")) return "~/" + dir.slice(HOME.length + 1);
	return dir;
}

// --- Shared server-status formatters (#119) ---
//
// Three widths, one source of truth. Every surface that displays server status
// routes through one of these instead of building its own line/box from scratch.

/**
 * Format A — Compact single-line. For the TUI widget.
 *
 *   • ~/git-projects/rogue-savvy/frontend/dist :8080 [Live] @ https://rogue-savvy.princess-pi.dev
 */
export function formatServerCompact(server: ServerInstance): string {
	const typeColor = server.isLive ? "\x1b[32m" : "\x1b[33m";
	const typeLabel = server.isLive ? "Live" : "Static";
	return `• \x1b[36m${homeRelative(server.dir)}\x1b[0m :${server.port} [${typeColor}${typeLabel}\x1b[0m] @ \x1b[4m\x1b[34m${server.url}\x1b[0m`;
}

/**
 * Format B — Aligned table. For --list and session-shutdown reminder.
 * Plain-text (pipe-friendly), auto-sized columns, full paths with ~/ prefix.
 *
 *     DIRECTORY                                            PORT  TYPE     URL
 *     ~/git-projects/rogue-savvy/frontend/dist             8080  Live     https://rogue-savvy.princess-pi.dev
 *     ~/.local/share/something                             8081  Static   http://localhost:8081
 */
export function formatServerTable(servers: ServerInstance[]): string {
	if (servers.length === 0) return "";

	const rows = servers.map(s => ({
		dir: homeRelative(s.dir),
		port: String(s.port),
		type: s.isLive ? "Live" : "Static",
		url: s.url,
	}));

	const colWidths = {
		dir: Math.max("DIRECTORY".length, ...rows.map(r => getVisualLength(r.dir))),
		port: Math.max("PORT".length, ...rows.map(r => getVisualLength(r.port))),
		type: Math.max("TYPE".length, ...rows.map(r => getVisualLength(r.type))),
	};

	const header = `  ${padVisual("DIRECTORY", colWidths.dir)}  ${padVisual("PORT", colWidths.port)}  ${padVisual("TYPE", colWidths.type)}  URL`;
	const lines = rows.map(r =>
		`  ${padVisual(r.dir, colWidths.dir)}  ${padVisual(r.port, colWidths.port)}  ${padVisual(r.type, colWidths.type)}  ${r.url}`
	);

	return [header, ...lines].join("\n");
}

/**
 * Format C — Rich card (post-start). One card per newly started server.
 *
 *   ┌─ ~/git-projects/rogue-savvy/frontend/dist :8080 ────────┐
 *   │  https://rogue-savvy.princess-pi.dev                     │
 *   │  Live · logs: ~/.pi-certs/logs/port-8080-access.log      │
 *   └──────────────────────────────────────────────────────────┘
 */
export function formatServerCard(server: ServerInstance): string {
	const border = "\x1b[37m";
	const header = `${homeRelative(server.dir)} :${server.port}`;
	const headerDashes = "─".repeat(Math.max(1, 56 - getVisualLength(header)));
	const typeColor = server.isLive ? "\x1b[32m" : "\x1b[33m";
	const typeLabel = server.isLive ? "Live" : "Static";
	const logPath = `~/.pi-certs/logs/port-${server.port}-access.log`;

	return [
		`${border}┌─ ${header} ${headerDashes}┐\x1b[0m`,
		`${border}│\x1b[0m  \x1b[4m\x1b[34m${server.url}\x1b[0m`,
		`${border}│\x1b[0m  ${typeColor}${typeLabel}\x1b[0m · logs: \x1b[36m${logPath}\x1b[0m`,
		`${border}└${"─".repeat(58)}┘\x1b[0m`,
	].join("\n");
}

/**
 * Format C (killed variant) — Rich card for killed servers. Shows before/after
 * health-check status instead of type + log path.
 *
 *   ┌─ ~/git-projects/rogue-savvy/frontend/dist :8080 ────────┐
 *   │  https://rogue-savvy.princess-pi.dev                     │
 *   │  Before: 200 OK (Secure HTTPS - Live)                    │
 *   │  After:  Connection refused                              │
 *   └──────────────────────────────────────────────────────────┘
 */
export function formatServerCardKilled(killed: KilledServerInstance): string {
	const border = "\x1b[37m";
	const header = `${homeRelative(killed.dir)} :${killed.port}`;
	const headerDashes = "─".repeat(Math.max(1, 56 - getVisualLength(header)));

	return [
		`${border}┌─ ${header} ${headerDashes}┐\x1b[0m`,
		`${border}│\x1b[0m  \x1b[4m\x1b[34m${killed.url || killed.localUrl}\x1b[0m`,
		`${border}│\x1b[0m  Before: ${killed.statusBefore}`,
		`${border}│\x1b[0m  After:  \x1b[31m${killed.statusAfter}\x1b[0m`,
		`${border}└${"─".repeat(58)}┘\x1b[0m`,
	].join("\n");
}

// --- TUI widget ---

export function updateWidget(ctx: any, servers: ServerInstance[], isWidgetVisible: boolean, cwd: string = process.cwd()) {
	if (!isWidgetVisible) {
		ctx.ui.setWidget("serve-ports", undefined);
		return;
	}

	if (servers.length > 0) {
		const emojiPrefix = isEmojiDisabled(ctx) ? "[ON]" : "🟢";
		const widgetLines: string[] = [];

		// This Worktree
		const thisRepo = servers.filter(s => isInsideRepo(s.dir, cwd));
		widgetLines.push(`\x1b[1m\x1b[35m${emojiPrefix} This Worktree\x1b[0m`);
		if (thisRepo.length > 0) {
			for (const server of thisRepo) {
				widgetLines.push(formatServerCompact(server));
			}
		} else {
			widgetLines.push(`  \x1b[2m(none)\x1b[0m`);
		}

		// Other
		const otherRepo = servers.filter(s => !isInsideRepo(s.dir, cwd));
		widgetLines.push(`\x1b[1m\x1b[35m${emojiPrefix} Other\x1b[0m`);
		if (otherRepo.length > 0) {
			for (const server of otherRepo) {
				widgetLines.push(formatServerCompact(server));
			}
		} else {
			widgetLines.push(`  \x1b[2m(none)\x1b[0m`);
		}

		ctx.ui.setWidget("serve-ports", widgetLines, { placement: "belowEditor" });
	} else {
		ctx.ui.setWidget("serve-ports", undefined);
	}
}

// --- #117/#119: --list always shows every server, full paths with ~/ prefix. ---
export function buildListSummary(servers: ServerInstance[]): string {
	if (servers.length === 0) {
		return "No servers are currently running for this user.";
	}
	return `🚀 Servers active for this user (all repos):\n\n${formatServerTable(servers)}`;
}

// --- #117: shown when `serve` is invoked with no target directory (bare, or flags-only).
// serve no longer defaults to public/+docs/ — instead it lists (above) and suggests an agent
// prompt to locate a servable dir. Kept a pure string so both surfaces and the test share it.
export function buildNoDirHint(): string {
	return [
		"No directory given — nothing started.",
		"",
		"Ask your agent to find one, e.g.:",
		'  "Find the servable build/output dir in this repo and serve it."',
		"",
		"Or name it yourself:      serve <dir>",
		"See every running server: serve --list",
	].join("\n");
}

// --- Post-start summary: card format, only the servers that were *just* started (#119). ---
export function buildDiscoveredSummary(servers: ServerInstance[]): string {
	const cards = servers.map(s => formatServerCard(s));
	const label = servers.length === 1 ? "server" : "servers";
	return `🚀 Started ${servers.length} ${label}:\n\n${cards.join("\n\n")}`;
}

// --- Post-kill summary: card format, only the servers that were *just* killed. ---
export function buildKilledSummary(killedList: KilledServerInstance[]): string {
	const cards = killedList.map(k => formatServerCardKilled(k));
	const label = killedList.length === 1 ? "server" : "servers";
	return `🛑 Terminated ${killedList.length} ${label}!\n\n${cards.join("\n\n")}`;
}
