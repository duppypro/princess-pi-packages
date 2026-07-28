import * as os from "node:os";
import { ServerInstance, KilledServerInstance } from "./domain.js";
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

// --- Shared server-status formatters (#119) ---
export function formatServerTable(servers: ServerInstance[]): string {
	if (servers.length === 0) return "";

	const COLOR = "\x1b[1;35m";
	const RESET = "\x1b[0m";

	const rows = servers.map(s => ({
		dir: homeRelative(s.dir),
		port: String(s.port),
		type: s.isLive ? "Live" : "Static",
		url: s.url,
	}));

	const colWidths = {
		dir: Math.max("SERVED DIRECTORY".length, ...rows.map(r => getVisualLength(r.dir))),
		port: Math.max("PORT".length, ...rows.map(r => getVisualLength(r.port))),
		type: Math.max("TYPE".length, ...rows.map(r => getVisualLength(r.type))),
	};

	const header = `${COLOR}  ${padVisual("SERVED DIRECTORY", colWidths.dir)}  ${padVisual("PORT", colWidths.port)}  ${padVisual("TYPE", colWidths.type)}  URL${RESET}`;
	const lines = rows.map(r =>
		`${COLOR}  ${padVisual(r.dir, colWidths.dir)}  ${padVisual(r.port, colWidths.port)}  ${padVisual(r.type, colWidths.type)}  ${r.url}${RESET}`
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
	const typeColor = server.isLive ? "\x1b[32m" : "\x1b[33m";
	const typeLabel = server.isLive ? "Live" : "Static";
	const logPath = `~/.pi-certs/logs/port-${server.port}-access.log`;

	const urlLine = `  \x1b[4m\x1b[34m${server.url}\x1b[0m`;
	const infoLine = `  ${typeColor}${typeLabel}\x1b[0m · logs: \x1b[36m${logPath}\x1b[0m`;

	// Box inner-width: max of header+3 (for "┌─ "), url, info (#119 fix)
	const inner = Math.max(
		getVisualLength(header) + 3,
		getVisualLength(urlLine),
		getVisualLength(infoLine)
	);

	const headerDashes = "─".repeat(Math.max(1, inner - getVisualLength(header) - 3));
	const urlPadded = padVisual(urlLine, inner);
	const infoPadded = padVisual(infoLine, inner);

	return [
		`${border}┌─ ${header} ${headerDashes}┐\x1b[0m`,
		`${border}│\x1b[0m${urlPadded}${border}│\x1b[0m`,
		`${border}│\x1b[0m${infoPadded}${border}│\x1b[0m`,
		`${border}└${"─".repeat(inner)}┘\x1b[0m`,
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

	const urlLine = `  \x1b[4m\x1b[34m${killed.url || killed.localUrl}\x1b[0m`;
	const beforeLine = `  Before: ${killed.statusBefore}`;
	const afterLine = `  After:  \x1b[31m${killed.statusAfter}\x1b[0m`;

	const inner = Math.max(
		getVisualLength(header) + 3,
		getVisualLength(urlLine),
		getVisualLength(beforeLine),
		getVisualLength(afterLine)
	);

	const headerDashes = "─".repeat(Math.max(1, inner - getVisualLength(header) - 3));
	const urlPadded = padVisual(urlLine, inner);
	const beforePadded = padVisual(beforeLine, inner);
	const afterPadded = padVisual(afterLine, inner);

	return [
		`${border}┌─ ${header} ${headerDashes}┐\x1b[0m`,
		`${border}│\x1b[0m${urlPadded}${border}│\x1b[0m`,
		`${border}│\x1b[0m${beforePadded}${border}│\x1b[0m`,
		`${border}│\x1b[0m${afterPadded}${border}│\x1b[0m`,
		`${border}└${"─".repeat(inner)}┘\x1b[0m`,
	].join("\n");
}

// --- TUI widget ---

export function updateWidget(ctx: any, servers: ServerInstance[], isWidgetVisible: boolean) {
	if (!isWidgetVisible) {
		ctx.ui.setWidget("serve-ports", undefined);
		return;
	}

	if (servers.length > 0) {
		ctx.ui.setWidget("serve-ports", formatServerTable(servers).split("\n"), { placement: "belowEditor" });
	} else {
		ctx.ui.setWidget("serve-ports", undefined);
	}
}

// --- #117/#119: --list always shows every server, table only (no title). ---
export function buildListSummary(servers: ServerInstance[]): string {
	if (servers.length === 0) {
		return "No servers are currently running.";
	}
	return formatServerTable(servers);
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
	return servers.map(s => formatServerCard(s)).join("\n\n");
}

// --- Post-kill summary: card format, only the servers that were *just* killed. ---
export function buildKilledSummary(killedList: KilledServerInstance[]): string {
	const cards = killedList.map(k => formatServerCardKilled(k));
	const label = killedList.length === 1 ? "server" : "servers";
	return `🛑 Terminated ${killedList.length} ${label}!\n\n${cards.join("\n\n")}`;
}
