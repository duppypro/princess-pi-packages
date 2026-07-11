// ---
// Compatibility note: this extension targets Pi Coding Agent's runtime API
// (pi.registerCommand, pi.on lifecycle events, ctx.ui.setWidget) — these have
// no equivalent in other agent harnesses. Claude Code, for example, uses a
// different model entirely: markdown-based skills instead of programmatic
// command handlers, declarative hooks instead of in-process event listeners,
// and no persistent multi-line widget surface (only a single-line status bar).
// ---
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, exec, execSync } from "node:child_process";
import { isInsideRepo, getClientSlug, KilledServerInstance } from "./lib/serve/domain.js";
import { discoverServers, resolveIp, checkServerStatus, killServerInstance } from "./lib/serve/process.js";
import { parseAclFile, updateNginxAcls, updateNginxPort, reloadNginx } from "./lib/serve/nginx.js";
import { getVisibility } from "./lib/serve/store.js";
import { writeConfig } from "./lib/config.js";
import { shortenPath } from "./lib/session-path-shortener.js";
import { updateWidget, buildKilledSummary, buildDiscoveredSummary } from "./lib/serve/tui.js";

// Track widget visibility state locally (persisted across reloads via session log)
let isWidgetVisible = true;

// Active instance tracking to self-prune leaked event bus listeners across reloads
let activeInstanceId = "";

// No local certificates needed. Plain HTTP on loopback is gated securely at the VPS edge.

export default function serveExtension(pi: ExtensionAPI) {
	const myInstanceId = Math.random().toString(36).substring(2, 11);
	activeInstanceId = myInstanceId;

	let unsubscribeTick: (() => void) | null = null;

	// 1. Auto-discover on session start, restore visibility state, and hook into central refresher service
	pi.on("session_start", async (_event, ctx) => {
		isWidgetVisible = getVisibility(ctx);
		const servers = await discoverServers();

		updateWidget(ctx, servers, isWidgetVisible, process.cwd());

		// Subscribe to the centralized refresher tick event
		unsubscribeTick = pi.events.on("clock:tick:4s", async () => {
			if (activeInstanceId !== myInstanceId) {
				// Self-prune: We are a leaked, stale listener from a previous reload
				if (unsubscribeTick) unsubscribeTick();
				return;
			}

			if (!isWidgetVisible) {
				ctx.ui.setWidget("serve-ports", undefined);
				return;
			}
			const currentServers = await discoverServers();
			updateWidget(ctx, currentServers, isWidgetVisible, process.cwd());
		});
	});

	// 2. Display persistent active server list reminder on `/quit` / exit
	pi.on("session_shutdown", async (_event, ctx) => {
		// Clean up the global event listener to prevent event listener leaks on reload
		if (unsubscribeTick) {
			unsubscribeTick();
			unsubscribeTick = null;
		}

		const allServers = await discoverServers();
		const repoServers = allServers.filter(s => isInsideRepo(s.dir, process.cwd()));
		if (repoServers.length > 0) {
			const serverLinks = repoServers
				.map(s => `  • \x1b[36m${shortenPath(s.dir, process.cwd())}\x1b[0m @ \x1b[4m\x1b[34m${s.url}\x1b[0m`)
				.join("\n");

			console.log(
				`\n\x1b[1m\x1b[33m⚠️  REMINDER: You have active background servers running in this repository:\x1b[0m\n` +
				serverLinks + `\n\n` +
				`\x1b[33mThese servers will remain active during your "pause". To stop them, resume this session and run:\x1b[0m\n` +
				`  \x1b[1m/serve --kill\x1b[0m\n`
			);
		}
	});

	// --- Command handlers (one per /serve subcommand) ---

	async function handleLog(ctx: any): Promise<void> {
		const activeServers = await discoverServers();
		const repoServers = activeServers.filter(s => isInsideRepo(s.dir, process.cwd()));
		if (repoServers.length === 0) {
			ctx.ui.notify("No servers are currently running in this repository.", "info");
			return;
		}
		const lines = repoServers.map(s => {
			const logPath = `~/.pi-certs/logs/port-${s.port}-access.log`;
			return `• \x1b[36m${shortenPath(s.dir, process.cwd())}\x1b[0m @ \x1b[4m\x1b[34m${s.url}\x1b[0m \x1b[90m(Logs: ${logPath})\x1b[0m`;
		});
		ctx.ui.notify(`🚀 Servers active in this repository:\n\n${lines.join("\n")}`, "info");
	}

	async function handleHelp(ctx: any): Promise<void> {
		try {
			const manifestPath = path.join(process.cwd(), "docs", "manifests", "serve-cmd.json");
			const manifestStr = fs.readFileSync(manifestPath, "utf8");
			const manifest = JSON.parse(manifestStr);
			const invokedAs = "/serve";

			let helpText = `\x1b[1m\x1b[36m${manifest.name}\x1b[0m - ${manifest.tagline}\n\n`;
			helpText += `${manifest.description}\n\n`;

			// Examples first (with mock parameters), full flag enumeration after —
			// see CLAUDE.md "Manifest-driven --help" convention.
			helpText += `\x1b[1mExamples:\x1b[0m\n`;
			for (const e of manifest.examples) {
				const fullCmd = e.args ? `${invokedAs} ${e.args}` : invokedAs;
				helpText += `  ${fullCmd.padEnd(30)} ${e.desc}\n`;
			}

			helpText += `\n\x1b[1mUsage:\x1b[0m\n`;
			for (const u of manifest.usage) {
				helpText += `  ${invokedAs} ${(u.flags).padEnd(28)} ${u.desc}\n`;
			}

			ctx.ui.notify(helpText, "info");
		} catch (err) {
			ctx.ui.notify(`⚠️ Failed to load command manifest: ${err}`, "error");
		}
	}

	async function handleVersion(ctx: any): Promise<void> {
		try {
			const manifestPath = path.join(process.cwd(), "docs", "manifests", "serve-cmd.json");
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			ctx.ui.notify(`${manifest.name} ${manifest.version}`, "info");
		} catch (err) {
			ctx.ui.notify(`\u26A0\uFE0F Failed to load command manifest: ${err}`, "error");
		}
	}

	async function handleWhy(ctx: any): Promise<void> {
		try {
			const { renderWhy } = await import("./lib/merge/help.js");
			const manifestPath = path.join(process.cwd(), "docs", "manifests", "serve-cmd.json");
			const whyText = renderWhy(manifestPath, "/serve");
			ctx.ui.notify(whyText, "info");
		} catch (err) {
			ctx.ui.notify(`⚠️ Failed to load command manifest: ${err}`, "error");
		}
	}

	async function handleHide(ctx: any): Promise<void> {
		isWidgetVisible = false;
		writeConfig("serve", { visible: false });
		updateWidget(ctx, [], isWidgetVisible, process.cwd());
		ctx.ui.notify("Active server list widget hidden.", "info");
	}

	async function handleShow(ctx: any): Promise<void> {
		isWidgetVisible = true;
		writeConfig("serve", { visible: true });
		const servers = await discoverServers();
		updateWidget(ctx, servers, isWidgetVisible, process.cwd());

		if (servers.length > 0) {
			ctx.ui.notify(`Discovered and displaying ${servers.length} active servers.`, "info");
		} else {
			ctx.ui.setWidget("serve-ports", undefined);
			ctx.ui.notify("No active servers found to display.", "warning");
		}
	}

	async function handleKill(trimmedArgs: string, ctx: any): Promise<void> {
		const killArgs = trimmedArgs.replace(/^(--kill|--cancel|--off|-k)/, "").trim();
		const targets = killArgs.split(/\s+/).map(t => t.trim()).filter(t => t.length > 0);

		const activeServers = await discoverServers();
		const killedList: KilledServerInstance[] = [];

		const killAll = targets.some(t => t.toLowerCase() === "all");

		if (targets.length === 0 || killAll) {
			const targetsToKill = killAll ? activeServers : activeServers.filter(s => isInsideRepo(s.dir, process.cwd()));
			if (targetsToKill.length === 0) {
				const scopeLabel = killAll ? "anywhere on this machine" : "in this repository/worktree";
				ctx.ui.notify(`⚠️ No servers are currently running ${scopeLabel} to kill.`, "warning");
				return;
			}

			for (const server of targetsToKill) {
				const statusBefore = await checkServerStatus(server.localUrl || server.url);
				const killed = await killServerInstance(server);
				if (!killed) {
					ctx.ui.notify(`⚠️ Could NOT terminate server on port ${server.port} (PID ${server.pid ?? "unknown"} not found or still running). Skipping.`, "warning");
					continue;
				}
				const statusAfter = await checkServerStatus(server.localUrl || server.url);

				killedList.push({
					port: server.port,
					dir: server.dir,
					url: server.url,
					localUrl: server.localUrl,
					clientSlug: server.clientSlug,
					title: server.title,
					statusBefore,
					statusAfter
				});
			}
		} else {
			for (const target of targets) {
				const isPort = /^\d+$/.test(target);
				let matchedServer = activeServers.find(s => {
					if (isPort) {
						return s.port === parseInt(target, 10);
					} else {
						return s.dir.replace(/\/$/, "") === target.replace(/\/$/, "") || shortenPath(s.dir, process.cwd()) === target.replace(/\/$/, "");
					}
				});

				if (matchedServer) {
					const statusBefore = await checkServerStatus(matchedServer.localUrl || matchedServer.url);
					const killed = await killServerInstance(matchedServer);
					if (!killed) {
						ctx.ui.notify(`⚠️ Could NOT terminate server on port ${matchedServer.port} (PID ${matchedServer.pid ?? "unknown"} not found or still running).`, "warning");
						continue;
					}

					const statusAfter = await checkServerStatus(matchedServer.localUrl || matchedServer.url);

					killedList.push({
						port: matchedServer.port,
						dir: matchedServer.dir,
						url: matchedServer.url,
						localUrl: matchedServer.localUrl,
						clientSlug: matchedServer.clientSlug,
						title: matchedServer.title,
						statusBefore,
						statusAfter
					});
				} else {
					ctx.ui.notify(`⚠️ Could not find any active server matching "${target}".`, "warning");
				}
			}
		}

		if (killedList.length === 0) {
			ctx.ui.notify("No servers were terminated.", "warning");
			return;
		}

		for (const killed of killedList) {
			if (killed.clientSlug) {
				try {
					updateNginxPort(killed.clientSlug, null);
				} catch (err: any) {
					ctx.ui.notify(`⚠️ Map Cleanup Error for ${killed.clientSlug}: ${err.message}`, "error");
				}
			}
		}

		if (killedList.length > 0) {
			const reloadErr = reloadNginx();
			if (reloadErr) {
				ctx.ui.notify(`⚠️ Cleaned maps, but NGINX reload failed.\nError: ${reloadErr}`, "warning");
			} else {
				ctx.ui.notify(`✅ Cleaned up routing entries and reloaded NGINX.`, "info");
			}
		}

		const remainingServers = await discoverServers();
		updateWidget(ctx, remainingServers, isWidgetVisible, process.cwd());

		const fullSummary = buildKilledSummary(killedList, process.cwd());
		ctx.ui.notify(fullSummary, "info");
	}

	async function handleStart(trimmedArgs: string, ctx: any): Promise<void> {
		let dirs = trimmedArgs.split(/\s+/).map(d => d.trim()).filter(d => d.length > 0);
		const isStatic = dirs.includes("--static") || dirs.includes("-s");
		dirs = dirs.filter(d => d !== "--static" && d !== "-s");

		if (dirs.length === 0) {
			dirs = ["public", "docs"];
		}

		let startPort = 8080;
		const ip = await resolveIp();

		for (const rawDir of dirs) {
			const targetDir = path.resolve(process.cwd(), rawDir);

			if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
				ctx.ui.notify(`⚠️ Warning: Directory "${rawDir}" does not exist. Skipping.`, "warning");
				continue;
			}

			const activeServers = await discoverServers();
			const hasMatchingTypeServer = activeServers.some(s =>
				path.resolve(process.cwd(), s.dir) === targetDir &&
				!!s.isLive === !isStatic
			);

			if (hasMatchingTypeServer) {
				const typeLabel = isStatic ? "statically" : "live-reloading";
				ctx.ui.notify(`ℹ️ Note: Directory "${rawDir}" is already being served ${typeLabel}. Skipping.`, "info");
				continue;
			}

			const envPath = path.join(targetDir, ".env");
			if (fs.existsSync(envPath)) {
				const proceed = await ctx.ui.confirm(
					"⚠️ Secret Warning",
					`Found .env file in "${rawDir}"! This directory may contain sensitive secrets.\nAre you sure you want to serve it?`
				);
				if (!proceed) {
					ctx.ui.notify(`Skipped directory "${rawDir}" due to secret warning.`, "info");
					continue;
				}
			}

			while (activeServers.some(s => s.port === startPort)) {
				startPort++;
			}

			const port = startPort++;

			// Secure Dynamic Gating Validation (.serve-acl file must exist)
			let emails: string[];
			try {
				emails = parseAclFile(targetDir);
			} catch (err: any) {
				ctx.ui.notify(`⚠️ Failed to start server for "${rawDir}": ${err.message}`, "error");
				continue;
			}
			const clientSlug = getClientSlug(targetDir);

			const __filename = fileURLToPath(import.meta.url);
			const __dirname = path.dirname(__filename);
			const runnerPath = path.resolve(__dirname, "lib/serve/run-live-server.js");

			const spawnCmd = isStatic ? "npx" : "node";
			const spawnArgs = isStatic ? [
				"--",
				"http-server",
				targetDir,
				"-p", String(port),
				"-a", "127.0.0.1"
			] : [
				runnerPath,
				targetDir,
				"--slug", clientSlug,
				"-p", String(port),
				"-a", "127.0.0.1"
			];

			const serverProcess = spawn(spawnCmd, spawnArgs, {
				detached: true,
				stdio: "ignore"
			});

			serverProcess.unref();

			// Write Dynamic Maps and trigger NGINX reload
			try {
				updateNginxAcls(clientSlug, emails);
				updateNginxPort(clientSlug, port);
				const reloadErr = reloadNginx();
				if (reloadErr) {
					ctx.ui.notify(`⚠️ Maps updated for ${clientSlug}, but NGINX reload failed. Error: ${reloadErr}`, "warning");
				} else {
					ctx.ui.notify(`✅ NGINX reloaded. Routing mapped for https://princess-pi.dev/live/${clientSlug}/`, "info");
				}
			} catch (err: any) {
				ctx.ui.notify(`⚠️ Dynamic Map/ACL Error: ${err.message}`, "error");
			}
		}

		await new Promise(r => setTimeout(r, 1200));

		const allActiveServers = await discoverServers();

		if (allActiveServers.length === 0) {
			ctx.ui.notify("No active directories are currently being served.", "warning");
			return;
		}

		updateWidget(ctx, allActiveServers, isWidgetVisible, process.cwd());

		const fullSummary = buildDiscoveredSummary(allActiveServers, process.cwd());
		ctx.ui.notify(fullSummary, "info");
	}

	async function handleEmojiToggle(enabled: boolean, ctx: any): Promise<void> {
		writeConfig("serve", { emojiDisabled: !enabled });
		const servers = await discoverServers();
		updateWidget(ctx, servers, isWidgetVisible, process.cwd());
		const statusText = enabled ? "enabled" : "disabled";
		ctx.ui.notify(`Emoji icons in widgets have been ${statusText}.`, "info");
	}

	// --- Dispatch table: matches the raw trimmed args to the right subcommand handler ---
	// `--kill` needs a prefix-match (it carries trailing target args); the rest are exact flags.
	const routes: { test: (args: string) => boolean; handler: (args: string, ctx: any) => Promise<void> }[] = [
		{ test: (a) => a === "--log" || a === "-L", handler: (_a, ctx) => handleLog(ctx) },
		{ test: (a) => a === "--help" || a === "-h", handler: (_a, ctx) => handleHelp(ctx) },
		{ test: (a) => a === "--version", handler: (_a, ctx) => handleVersion(ctx) },
		{ test: (a) => a === "--why", handler: (_a, ctx) => handleWhy(ctx) },
		{ test: (a) => a === "--hide" || a === "-H", handler: (_a, ctx) => handleHide(ctx) },
		{ test: (a) => a === "--show" || a === "-S", handler: (_a, ctx) => handleShow(ctx) },
		{ test: (a) => a === "--no-emojii" || a === "--no-emoji", handler: (_a, ctx) => handleEmojiToggle(false, ctx) },
		{ test: (a) => a === "--emojii" || a === "--emoji", handler: (_a, ctx) => handleEmojiToggle(true, ctx) },
		{ test: (a) => /^(--kill|--cancel|--off|-k)(\s|$)/.test(a), handler: handleKill },
	];

	// 3. Define the /serve command
	pi.registerCommand("serve", {
		description: "Serve public/ and docs/ (or specified directories) securely over HTTPS with helper controls",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			const route = routes.find(r => r.test(trimmedArgs));
			if (route) {
				await route.handler(trimmedArgs, ctx);
			} else {
				await handleStart(trimmedArgs, ctx);
			}
		}
	});
}
