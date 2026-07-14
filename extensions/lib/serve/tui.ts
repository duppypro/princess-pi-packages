import { shortenPath } from "../session-path-shortener.js";
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

export function updateWidget(ctx: any, servers: ServerInstance[], isWidgetVisible: boolean, cwd: string = process.cwd()) {
	if (!isWidgetVisible) {
		ctx.ui.setWidget("serve-ports", undefined);
		return;
	}

	if (servers.length > 0) {
		const emojiPrefix = isEmojiDisabled(ctx) ? "[ON] " : "🟢 ";
		const widgetLines: string[] = [`\x1b[1m\x1b[32m${emojiPrefix}Active HTTPS Servers:\x1b[0m`];
		
		// This Worktree
		widgetLines.push(`\x1b[1m\x1b[35m--- This Worktree ---\x1b[0m`);
		const thisRepo = servers.filter(s => isInsideRepo(s.dir, cwd));
		if (thisRepo.length > 0) {
			for (const server of thisRepo) {
				const typeLabel = server.isLive ? "\x1b[32m(Live)\x1b[0m" : "\x1b[33m(Static)\x1b[0m";
				const logPath = `~/.pi-certs/logs/port-${server.port}-access.log`;
				widgetLines.push(`• \x1b[36m${shortenPath(server.dir, cwd)}\x1b[0m ${typeLabel} @ \x1b[4m\x1b[34m${server.url}\x1b[0m \x1b[90m(Logs: ${logPath})\x1b[0m`);
			}
		} else {
			widgetLines.push(`  \x1b[2m(none)\x1b[0m`);
		}
		
		// Other
		widgetLines.push(`\x1b[1m\x1b[35m--- Other ---\x1b[0m`);
		const otherRepo = servers.filter(s => !isInsideRepo(s.dir, cwd));
		if (otherRepo.length > 0) {
			for (const server of otherRepo) {
				const typeLabel = server.isLive ? "\x1b[32m(Live)\x1b[0m" : "\x1b[33m(Static)\x1b[0m";
				const logPath = `~/.pi-certs/logs/port-${server.port}-access.log`;
				widgetLines.push(`• \x1b[36m${shortenPath(server.dir, cwd)}\x1b[0m ${typeLabel} @ \x1b[4m\x1b[34m${server.url}\x1b[0m \x1b[90m(Logs: ${logPath})\x1b[0m`);
			}
		} else {
			widgetLines.push(`  \x1b[2m(none)\x1b[0m`);
		}

		ctx.ui.setWidget("serve-ports", widgetLines, { placement: "belowEditor" });
	} else {
		ctx.ui.setWidget("serve-ports", undefined); // Clear the widget completely if no active servers remain
	}
}

export function buildKilledSummary(killedList: KilledServerInstance[], cwd: string = process.cwd()): string {
	const borderStyle = "\x1b[37m"; 
	const summaryParts: string[] = [];
	for (const server of killedList) {
		const beforePadded = padVisual(server.statusBefore, 47);
		const afterPadded = padVisual(server.statusAfter, 48);

		const labelStr = `${shortenPath(server.dir, cwd)} - Port ${server.port}`;
		const headerDashes = "─".repeat(Math.max(1, 53 - labelStr.length));

		summaryParts.push(
			`${borderStyle}┌─ [${labelStr}] ${headerDashes}┐\x1b[0m\n` +
			`${borderStyle}│\x1b[0m  \x1b[1mURL:\x1b[0m \x1b[4m\x1b[34m${server.url || server.localUrl}\x1b[0m\n` +
			`${borderStyle}│\x1b[0m  \x1b[1mBefore:\x1b[0m ${beforePadded} ${borderStyle}│\x1b[0m\n` +
			`${borderStyle}│\x1b[0m  \x1b[1mAfter:\x1b[0m \x1b[31m${afterPadded}\x1b[0m ${borderStyle}│\x1b[0m\n` +
			`${borderStyle}└` + "─".repeat(58) + `┘\x1b[0m`
		);
	}
	return `🛑 Terminated ${killedList.length} server(s)!\n\n` + summaryParts.join("\n\n");
}

export function buildDiscoveredSummary(servers: ServerInstance[], cwd: string = process.cwd()): string {
	const borderStyle = "\x1b[37m";
	const summaryParts: string[] = [];
	for (const server of servers) {
		const titlePadded = padVisual(server.title, 48);
		const logPath = `~/.pi-certs/logs/port-${server.port}-access.log`;
		const logPadded = padVisual(logPath, 49);

		const isSsl = server.url.startsWith("https");
		const typeLabel = server.isLive ? "Live" : "Static";
		const protocolLabelPlain = isSsl ? `Secure HTTPS - ${typeLabel}` : `Plain HTTP - ${typeLabel}`;
		const statusTextPlain = `200 OK (${protocolLabelPlain})`;
		const statusTextPadded = padVisual(statusTextPlain, 47);
		const coloredStatus = isSsl ? `\x1b[32m${statusTextPadded}\x1b[0m` : `\x1b[33m${statusTextPadded}\x1b[0m`;

		const labelStr = `${shortenPath(server.dir, cwd)} - Port ${server.port}`;
		const headerDashes = "─".repeat(Math.max(1, 53 - labelStr.length));

		summaryParts.push(
			`${borderStyle}┌─ [${labelStr}] ${headerDashes}┐\x1b[0m\n` +
			`${borderStyle}│\x1b[0m  \x1b[1mURL:\x1b[0m \x1b[4m\x1b[34m${server.url}\x1b[0m\n` +
			`${borderStyle}│\x1b[0m  \x1b[1mLogs:\x1b[0m \x1b[36m${logPadded}\x1b[0m ${borderStyle}│\x1b[0m\n` +
			`${borderStyle}│\x1b[0m  \x1b[1mTitle:\x1b[0m ${titlePadded} ${borderStyle}│\x1b[0m\n` +
			`${borderStyle}│\x1b[0m  \x1b[1mStatus:\x1b[0m ${coloredStatus} ${borderStyle}│\x1b[0m\n` +
			`${borderStyle}└` + "─".repeat(58) + `┘\x1b[0m`
		);
	}
	return `🚀 Discovering all active servers on this machine...\n\n` + summaryParts.join("\n\n");
}
