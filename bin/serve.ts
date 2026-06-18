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
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { isInsideRepo, type KilledServerInstance } from "../extensions/lib/serve/domain.js";
import { discoverServers, resolveIp, checkServerStatus, findPidByPort, killProcess } from "../extensions/lib/serve/process.js";
import { shortenPath, buildKilledSummary, buildDiscoveredSummary } from "../extensions/lib/serve/tui.js";

function getOrCreateCertificates(): { cert: string; key: string } {
	const certsDir = path.join(os.homedir(), ".pi-certs");
	const certPath = path.join(certsDir, "cert.pem");
	const keyPath = path.join(certsDir, "key.pem");

	if (!fs.existsSync(certsDir)) {
		fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
	}

	if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
		console.log("🔑 Generating persistent self-signed SSL certificates in ~/.pi-certs/...");
		execSync(
			`openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 -keyout "${keyPath}" -out "${certPath}" -subj "/CN=localhost"`,
			{ stdio: "ignore" }
		);
		fs.chmodSync(keyPath, 0o600);
		fs.chmodSync(certPath, 0o644);
	}

	return { cert: certPath, key: keyPath };
}

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

function handleHelp(): void {
	try {
		const manifestPath = path.join(process.cwd(), "docs", "manifests", "serve-cmd.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

		let helpText = `${manifest.name} - ${manifest.tagline}\n\n${manifest.description}\n\n`;
		helpText += `Usage:\n`;
		for (const u of manifest.usage) helpText += `  ${manifest.name} ${(u.flags as string).padEnd(28)} ${u.desc}\n`;
		helpText += `\nExamples:\n`;
		for (const e of manifest.examples) helpText += `  ${(e.cmd as string).padEnd(30)} ${e.desc}\n`;
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
			const statusBefore = await checkServerStatus(server.url);
			const pid = await findPidByPort(server.port);
			if (pid) killProcess(pid);
			const statusAfter = await checkServerStatus(server.url);
			killedList.push({ port: server.port, dir: server.dir, url: server.url, title: server.title, statusBefore, statusAfter });
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
				const statusBefore = await checkServerStatus(matchedServer.url);
				const pid = await findPidByPort(matchedServer.port);
				if (pid) killProcess(pid);
				const statusAfter = await checkServerStatus(matchedServer.url);
				killedList.push({ port: matchedServer.port, dir: matchedServer.dir, url: matchedServer.url, title: matchedServer.title, statusBefore, statusAfter });
			} else {
				console.warn(`⚠️ Could not find any active server matching "${target}".`);
			}
		}
	}

	if (killedList.length === 0) {
		console.warn("No servers were terminated.");
		return;
	}
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
		const { cert, key } = getOrCreateCertificates();

		const __dirname = path.dirname(fileURLToPath(import.meta.url));
		const runnerPath = path.resolve(__dirname, "../extensions/lib/serve/run-live-server.js");

		const spawnCmd = isStatic ? "npx" : "node";
		const spawnArgs = isStatic
			? ["--", "http-server", targetDir, "-S", "-C", cert, "-K", key, "-p", String(port), "-a", "0.0.0.0"]
			: [runnerPath, targetDir, "-S", "-C", cert, "-K", key, "-p", String(port), "-a", "0.0.0.0"];

		const serverProcess = spawn(spawnCmd, spawnArgs, { detached: true, stdio: "ignore" });
		serverProcess.unref();
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
	if (/^(--kill|--cancel|--off|-k)(\s|$)/.test(trimmedArgs)) return handleKill(trimmedArgs);
	return handleStart(trimmedArgs);
}

run();
