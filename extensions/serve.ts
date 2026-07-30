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
import { isInsideRepo, KilledServerInstance } from "./lib/serve/domain.js";
import { discoverServers, resolveIp, checkServerStatus, killServerInstance } from "./lib/serve/process.js";
import { getVisibility } from "./lib/serve/store.js";
import { writeConfig } from "./lib/config.js";
import { shortenPath } from "./lib/session-path-shortener.js";
import { updateWidget, buildKilledSummary, buildDiscoveredSummary, buildListSummary, buildNoDirHint, formatServerTable, formatServerCard } from "./lib/serve/tui.js";
// --- Phase 6B (#66): per-subdomain edge publishing via the Cloudflare API (replaces nginx.js).
import { parseAclFile, publishSubdomain, unpublishSubdomain, reapOrphans } from "./lib/serve/cloudflare.js";

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

		updateWidget(ctx, servers, isWidgetVisible);

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
			updateWidget(ctx, currentServers, isWidgetVisible);
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
			const tableText = formatServerTable(repoServers);

			console.log(
				`\n\x1b[1m\x1b[33m⚠️  REMINDER: You have active background servers running in this repository:\x1b[0m\n\n` +
				tableText + `\n\n` +
				`\x1b[33mThese servers will remain active during your "pause". To stop them, resume this session and run:\x1b[0m\n` +
				`  \x1b[1m/serve --kill\x1b[0m\n`
			);
		}
	});

	// --- Command handlers (one per /serve subcommand) ---

	// #119: --list always shows every server on the box, full paths with ~/ prefix.
	async function handleList(ctx: any): Promise<void> {
		const activeServers = await discoverServers();
		ctx.ui.notify(buildListSummary(activeServers), "info");
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
		updateWidget(ctx, [], isWidgetVisible);
		ctx.ui.notify("Active server list widget hidden.", "info");
	}

	async function handleShow(ctx: any): Promise<void> {
		isWidgetVisible = true;
		writeConfig("serve", { visible: true });
		const servers = await discoverServers();
		updateWidget(ctx, servers, isWidgetVisible);

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

		if (targets.length === 0) {
			ctx.ui.notify("No targets given — nothing killed. Use --kill <port|dir|all> to target specific servers.", "warning");
			return;
		}

		if (killAll) {
			if (activeServers.length === 0) {
				ctx.ui.notify("⚠️ No servers are currently running anywhere on this machine to kill.", "warning");
				return;
			}

			for (const server of activeServers) {
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
					subdomain: server.subdomain,
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
						subdomain: matchedServer.subdomain,
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

		// --- Phase 6B (#66): unpublish each killed sub-domain from the edge (ingress + Access app).
		// Best-effort — a CF failure must not mask a successful local kill.
		const killedSubdomains = [...new Set(killedList.map(k => k.subdomain).filter((s): s is string => !!s))];
		for (const subdomain of killedSubdomains) {
			try {
				await unpublishSubdomain({ subdomain });
			} catch (err) {
				ctx.ui.notify(`⚠️ Killed local origin for "${subdomain}" but failed to unpublish from Cloudflare: ${(err as Error).message}`, "warning");
			}
		}

		const remainingServers = await discoverServers();
		updateWidget(ctx, remainingServers, isWidgetVisible);

		const fullSummary = buildKilledSummary(killedList);
		ctx.ui.notify(fullSummary, "info");
	}

	async function handleStart(trimmedArgs: string, ctx: any): Promise<void> {
		let dirs = trimmedArgs.split(/\s+/).map(d => d.trim()).filter(d => d.length > 0);
		const isStatic = dirs.includes("--static") || dirs.includes("-s");
		dirs = dirs.filter(d => d !== "--static" && d !== "-s");

		// --- Phase 6B (#66): optional slug override. `/serve <dir> --pub <subdomain>` publishes at
		// <subdomain>.princess-pi.dev instead of the repo-derived slug. One override names one
		// hostname, so it requires exactly one target dir.
		let overrideSubdomain: string | null = null;
		let pubIdx = dirs.indexOf("--pub");
		if (pubIdx === -1) pubIdx = dirs.indexOf("-P");
		const asIdx = dirs.indexOf("--as");
		const idx = pubIdx !== -1 ? pubIdx : asIdx;
		if (idx !== -1) {
			const val = dirs[idx + 1];
			if (val && !val.startsWith("-")) { overrideSubdomain = val; dirs.splice(idx, 2); }
			else { ctx.ui.notify("⚠️ --pub needs a sub-domain value (e.g. --pub my-preview); ignoring.", "warning"); dirs.splice(idx, 1); }
		}

		// #117: no default dirs anymore (public/+docs/ rarely fit a given repo). With no target —
		// bare /serve or flags-only (e.g. --static) — list what's already running here, then
		// suggest an agent prompt to find a servable dir. Start nothing; serving needs an explicit dir.
		if (dirs.length === 0) {
			const activeServers = await discoverServers();
			ctx.ui.notify(`${buildListSummary(activeServers)}\n\n${buildNoDirHint()}`, "info");
			return;
		}

		if (overrideSubdomain && dirs.length !== 1) {
			ctx.ui.notify(`⚠️ --pub ${overrideSubdomain} ignored: it requires exactly one target directory (${dirs.length} given).`, "warning");
			overrideSubdomain = null;
		}

		let startPort = 8080;
		const startedPorts: number[] = [];
		const ip = await resolveIp();

		// --- Phase 6B (#66): reap edge entries orphaned by a crash-without-kill before
		// publishing new state (stale allow-list live at the edge = security drift).
		try {
			const reaped = await reapOrphans();
			if (reaped.length) ctx.ui.notify(`🧹 Reaped ${reaped.length} orphaned preview(s): ${reaped.join(", ")}`, "info");
		} catch (err) {
			ctx.ui.notify(`⚠️ Orphan reap skipped: ${(err as Error).message}`, "warning");
		}

		// Labels published this run — a second dir colliding on the same flattened label is refused.
		const activeLabels = new Set<string>();

		for (const rawDir of dirs) {
			const targetDir = path.resolve(process.cwd(), rawDir);

			if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
				ctx.ui.notify(`⚠️ Warning: Directory "${rawDir}" does not exist. Skipping.`, "warning");
				continue;
			}

			const activeServers = await discoverServers();
			const existingServer = activeServers.find(s =>
				path.resolve(process.cwd(), s.dir) === targetDir &&
				!!s.isLive === !isStatic
			);

			if (existingServer) {
				if (overrideSubdomain) {
					// Publish the new slug to the existing server's port (#119)
					try {
						const emails = parseAclFile(targetDir);
						const hostname = await publishSubdomain({ slug: overrideSubdomain, port: existingServer.port, emails, activeLabels });
						activeLabels.add(hostname.split(".")[0]);
						ctx.ui.notify(`🌐 Published https://${hostname} (Access-gated, ${emails.length} allow-listed) on existing port ${existingServer.port}.\n\n${formatServerCard({ ...existingServer, url: `https://${hostname}/` })}`, "info");
					} catch (err) {
						ctx.ui.notify(`⚠️ Directory "${rawDir}" already served on port ${existingServer.port}, but edge publish failed: ${(err as Error).message}`, "warning");
					}
				} else {
					const typeLabel = isStatic ? "statically" : "live-reloading";
					ctx.ui.notify(`ℹ️ Note: Directory "${rawDir}" is already being served ${typeLabel}. Skipping.`, "info");
				}
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

			// #66: publishing is opt-in via --pub. A slug ⟺ published to the edge; it flows to
			// the runner's --subdomain (watcher target) AND the publish call. No --pub → local only.
			const subdomain = overrideSubdomain; // null unless --pub given

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
				...(subdomain ? ["--subdomain", subdomain] : []),
				"-p", String(port),
				"-a", "127.0.0.1"
			];

			const serverProcess = spawn(spawnCmd, spawnArgs, {
				detached: true,
				stdio: "ignore"
			});

			serverProcess.unref();
			startedPorts.push(port);

			// --- Phase 6B (#66): publish to the edge ONLY when --pub or --as names a sub-domain — tunnel
			// ingress rule + per-subdomain Access app carrying the .serve-acl allow-list. Best-
			// effort: the loopback origin is already up, so any failure warns and leaves it up.
			if (subdomain) {
				try {
					const emails = parseAclFile(targetDir);
					const hostname = await publishSubdomain({ slug: subdomain, port, emails, activeLabels });
					activeLabels.add(hostname.split(".")[0]);
					ctx.ui.notify(`🌐 Published https://${hostname} (Access-gated, ${emails.length} allow-listed).`, "info");
				} catch (err) {
					ctx.ui.notify(`⚠️ Serving "${rawDir}" locally on 127.0.0.1:${port}, but edge publish failed: ${(err as Error).message}`, "warning");
				}
			} else {
				ctx.ui.notify(`ℹ️ Serving "${rawDir}" locally. Pass --pub <name> to publish a gated preview at <name>.princess-pi.dev.`, "info");
			}
		}

		await new Promise(r => setTimeout(r, 1200));

		const allActiveServers = await discoverServers();
		const newServers = allActiveServers.filter(s => startedPorts.includes(s.port));

		if (allActiveServers.length === 0) {
			ctx.ui.notify("No active directories are currently being served.", "warning");
			return;
		}

		updateWidget(ctx, allActiveServers, isWidgetVisible);

		if (newServers.length > 0) {
			const fullSummary = buildDiscoveredSummary(newServers);
			ctx.ui.notify(fullSummary, "info");
		}
	}

	async function handleUnpub(subdomain: string, ctx: any): Promise<void> {
		try {
			await unpublishSubdomain({ subdomain });
			ctx.ui.notify(`🌐 Unpublished ${slug}.princess-pi.dev`, "info");
		} catch (err) {
			ctx.ui.notify(`⚠️ Failed to unpublish ${slug}: ${(err as Error).message}`, "warning");
		}
	}

	async function handleEmojiToggle(enabled: boolean, ctx: any): Promise<void> {
		writeConfig("serve", { emojiDisabled: !enabled });
		const servers = await discoverServers();
		updateWidget(ctx, servers, isWidgetVisible);
		const statusText = enabled ? "enabled" : "disabled";
		ctx.ui.notify(`Emoji icons in widgets have been ${statusText}.`, "info");
	}

	// --- Dispatch table: matches the raw trimmed args to the right subcommand handler ---
	// `--kill` needs a prefix-match (it carries trailing target args); the rest are exact flags.
	const routes: { test: (args: string) => boolean; handler: (args: string, ctx: any) => Promise<void> }[] = [
		{ test: (a) => a === "--list" || a === "-L", handler: (_a, ctx) => handleList(ctx) },
		{ test: (a) => a === "--help" || a === "-h", handler: (_a, ctx) => handleHelp(ctx) },
		{ test: (a) => a === "--version", handler: (_a, ctx) => handleVersion(ctx) },
		{ test: (a) => a === "--why", handler: (_a, ctx) => handleWhy(ctx) },
		{ test: (a) => a === "--hide" || a === "-H", handler: (_a, ctx) => handleHide(ctx) },
		{ test: (a) => a === "--show" || a === "-S", handler: (_a, ctx) => handleShow(ctx) },
		{ test: (a) => a === "--no-emojii" || a === "--no-emoji", handler: (_a, ctx) => handleEmojiToggle(false, ctx) },
		{ test: (a) => a === "--emojii" || a === "--emoji", handler: (_a, ctx) => handleEmojiToggle(true, ctx) },
		{ test: (a) => /^(--kill|--cancel|--off|-k)(\s|$)/.test(a), handler: handleKill },
		{ test: (a) => /^(--unpub|-U)(\s|$)/.test(a), handler: (args, ctx) => {
			const subdomain = args.replace(/^(--unpub|-U)/, "").trim();
			if (!slug) { ctx.ui.notify("Usage: --unpub <subdomain>", "warning"); return; }
			return handleUnpub(subdomain, ctx);
		}},
	];

	// 3. Define the /serve command
	pi.registerCommand("serve", {
		description: "Serve one or more directories securely over HTTPS with helper controls (bare /serve lists running servers and suggests how to find one)",
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
