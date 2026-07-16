#!/usr/bin/env -S npx tsx
/**
 * @package princess-pi-packages
 * @command serve
 * @description Standalone CLI port of extensions/serve.ts (Serve Utility).
 * Reuses extensions/lib/serve/* directly (no duplicated logic). Runs headless —
 * --hide/--show have no CLI equivalent since there's no persistent TUI widget here.
 * The .env secret warning can't block on an interactive confirm in a non-TTY
 * context, so it defaults to skipping that directory unless --force is passed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { spawn, execSync } from "node:child_process";
import { isInsideRepo, getClientSlug, type KilledServerInstance } from "../extensions/lib/serve/domain.js";
import { discoverServers, resolveIp, checkServerStatus, killServerInstance } from "../extensions/lib/serve/process.js";
import { shortenPath } from "../extensions/lib/session-path-shortener.ts";
import { buildKilledSummary, buildDiscoveredSummary } from "../extensions/lib/serve/tui.js";

// No local certificates needed. Plain HTTP on loopback is gated securely at the VPS edge.

async function handleLog(): Promise<void> {
	const activeServers = await discoverServers();
	const repoServers = activeServers.filter((s) => isInsideRepo(s.dir, process.cwd()));
	if (repoServers.length === 0) {
		console.log("No servers are currently running in this repository.");
		return;
	}
	const lines = repoServers.map((s) => {
		const logPath = `~/.pi-certs/logs/port-${s.port}-access.log`;
		return `• ${shortenPath(s.dir, process.cwd())} @ ${s.url} (Logs: ${logPath})`;
	});
	console.log(`🚀 Servers active in this repository:\n\n${lines.join("\n")}`);
}

function handleWhy(): void {
	try {
		const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "serve-cmd.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		const invokedAs = "./serve";
		let text = `${manifest.name} - ${manifest.tagline}

`;
		text += `${manifest.description}

`;
		text += `Why run ${invokedAs}?

`;
		const scenarios = manifest.why || [];
		for (const s of scenarios) {
			text += `  ${s.scenario}
`;
			for (const cmd of s.commands) {
				text += `    $ ${invokedAs}${cmd ? " " + cmd : ""}
`;
			}
			text += `    → ${s.result}

`;
		}
		text += `Run ${invokedAs} --help for the full flag reference.
`;
		console.log(text);
	} catch (err) {
		console.error(`⚠️ Failed to load command manifest: ${err}`);
		process.exitCode = 1;
	}
}

function handleHelp(): void {
	try {
		const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "serve-cmd.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		const invokedAs = "./serve"; // CLI entry point; bare `serve` also works once repo root is on $PATH

		let helpText = `${manifest.name} - ${manifest.tagline}\n\n${manifest.description}\n\n`;
		// Examples first (with mock parameters), full flag enumeration after —
		// see CLAUDE.md "Manifest-driven --help" convention.
		helpText += `Examples:\n`;
		for (const e of manifest.examples) {
			const fullCmd = e.args ? `${invokedAs} ${e.args}` : invokedAs;
			helpText += `  ${fullCmd.padEnd(30)} ${e.desc}\n`;
		}
		helpText += `\nUsage:\n`;
		for (const u of manifest.usage) helpText += `  ${invokedAs} ${(u.flags as string).padEnd(28)} ${u.desc}\n`;
		console.log(helpText);
	} catch (err) {
		console.error(`⚠️ Failed to load command manifest: ${err}`);
		process.exitCode = 1;
	}
}

async function handleKill(trimmedArgs: string): Promise<void> {
	const killArgs = trimmedArgs.replace(/^(--kill|--cancel|--off|-k)/, "").trim();
	const targets = killArgs.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0);

	const activeServers = await discoverServers();
	const killedList: KilledServerInstance[] = [];
	const killAll = targets.some((t) => t.toLowerCase() === "all");

	if (targets.length === 0 || killAll) {
		const targetsToKill = killAll ? activeServers : activeServers.filter((s) => isInsideRepo(s.dir, process.cwd()));
		if (targetsToKill.length === 0) {
			const scopeLabel = killAll ? "anywhere on this machine" : "in this repository/worktree";
			console.warn(`⚠️ No servers are currently running ${scopeLabel} to kill.`);
			return;
		}
		for (const server of targetsToKill) {
			const statusBefore = await checkServerStatus(server.localUrl || server.url);
			const killed = await killServerInstance(server);
			if (!killed) {
				console.warn(`⚠️ Could NOT terminate server on port ${server.port} (PID ${server.pid ?? "unknown"} not found or still running). Skipping.`);
				continue;
			}
			const statusAfter = await checkServerStatus(server.localUrl || server.url);
			killedList.push({ port: server.port, dir: server.dir, url: server.url, localUrl: server.localUrl, clientSlug: server.clientSlug, title: server.title, statusBefore, statusAfter });
		}
	} else {
		for (const target of targets) {
			const isPort = /^\d+$/.test(target);
			const matchedServer = activeServers.find((s) =>
				isPort
					? s.port === parseInt(target, 10)
					: s.dir.replace(/\/$/, "") === target.replace(/\/$/, "") || shortenPath(s.dir, process.cwd()) === target.replace(/\/$/, "")
			);
			if (matchedServer) {
				const statusBefore = await checkServerStatus(matchedServer.localUrl || matchedServer.url);
				const killed = await killServerInstance(matchedServer);
				if (!killed) {
					console.warn(`⚠️ Could NOT terminate server on port ${matchedServer.port} (PID ${matchedServer.pid ?? "unknown"} not found or still running).`);
					continue;
				}
				const statusAfter = await checkServerStatus(matchedServer.localUrl || matchedServer.url);
				killedList.push({ port: matchedServer.port, dir: matchedServer.dir, url: matchedServer.url, localUrl: matchedServer.localUrl, clientSlug: matchedServer.clientSlug, title: matchedServer.title, statusBefore, statusAfter });
			} else {
				console.warn(`⚠️ Could not find any active server matching "${target}".`);
			}
		}
	}

	if (killedList.length === 0) {
		console.warn("No servers were terminated.");
		return;
	}

	// --- Phase 6A (#64): nginx map cleanup + reload removed. WHY: the edge gate is
	// Cloudflare Tunnel + Access now; killing the loopback origin is the whole job.
	// (#66 re-adds per-slug UNpublishing via the Cloudflare API.)
	console.log(buildKilledSummary(killedList, process.cwd()));
}

async function handleStart(trimmedArgs: string): Promise<void> {
	let dirs = trimmedArgs.split(/\s+/).map((d) => d.trim()).filter((d) => d.length > 0);
	const isStatic = dirs.includes("--static") || dirs.includes("-s");
	const force = dirs.includes("--force") || dirs.includes("-f");
	dirs = dirs.filter((d) => d !== "--static" && d !== "-s" && d !== "--force" && d !== "-f");

	if (dirs.length === 0) dirs = ["public", "docs"];

	let startPort = 8080;

	for (const rawDir of dirs) {
		const targetDir = path.resolve(process.cwd(), rawDir);

		if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
			console.warn(`⚠️ Warning: Directory "${rawDir}" does not exist. Skipping.`);
			continue;
		}

		const activeServers = await discoverServers();
		const hasMatchingTypeServer = activeServers.some(
			(s) => path.resolve(process.cwd(), s.dir) === targetDir && !!s.isLive === !isStatic
		);
		if (hasMatchingTypeServer) {
			console.log(`ℹ️ Note: Directory "${rawDir}" is already being served ${isStatic ? "statically" : "live-reloading"}. Skipping.`);
			continue;
		}

		const envPath = path.join(targetDir, ".env");
		if (fs.existsSync(envPath) && !force) {
			console.warn(`⚠️ Found .env file in "${rawDir}"! Skipping (pass --force to serve anyway).`);
			continue;
		}

		while (activeServers.some((s) => s.port === startPort)) startPort++;
		const port = startPort++;

		// --- Phase 6A (#64): the .serve-acl gate validation is dormant — allow-lists
		// now live in Cloudflare Access policy, managed outside serve. (#66 re-reads
		// .serve-acl as the per-slug Access policy source.)
		const clientSlug = getClientSlug(targetDir);

		const __dirname = path.dirname(fileURLToPath(import.meta.url));
		const runnerPath = path.resolve(__dirname, "../extensions/lib/serve/run-live-server.js");

		const spawnCmd = isStatic ? "npx" : "node";
		const spawnArgs = isStatic
			? ["--", "http-server", targetDir, "-p", String(port), "-a", "127.0.0.1"]
			: [runnerPath, targetDir, "--slug", clientSlug, "-p", String(port), "-a", "127.0.0.1"];

		const serverProcess = spawn(spawnCmd, spawnArgs, { detached: true, stdio: "ignore" });
		serverProcess.unref();

		// --- Phase 6A (#64): nginx map writes + reload removed. serve spawns a plain
		// loopback origin; the Cloudflare Tunnel statically routes the MVP hostname to
		// it, and Cloudflare Access is the sole public gate. (#66: per-slug publishing.)
	}

	await new Promise((r) => setTimeout(r, 1200));

	const allActiveServers = await discoverServers();
	if (allActiveServers.length === 0) {
		console.warn("No active directories are currently being served.");
		return;
	}
	console.log(buildDiscoveredSummary(allActiveServers, process.cwd()));
}

async function run(): Promise<void> {
	await resolveIp();
	const trimmedArgs = process.argv.slice(2).join(" ").trim();

	if (trimmedArgs === "--log" || trimmedArgs === "-L") return handleLog();
	if (trimmedArgs === "--help" || trimmedArgs === "-h") return handleHelp();
	if (trimmedArgs === "--why") return handleWhy();
	if (/^(--kill|--cancel|--off|-k)(\s|$)/.test(trimmedArgs)) return handleKill(trimmedArgs);
	return handleStart(trimmedArgs);
}

run();
