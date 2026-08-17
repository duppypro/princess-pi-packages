#!/usr/bin/env bun
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
import { type KilledServerInstance } from "../extensions/lib/serve/domain.js";
import { discoverServers, resolveIp, checkServerStatus, killServerInstance, scanUnclaimedServerLike, findFreePort, settleStartedServers, type StartedServer } from "../extensions/lib/serve/process.js";
import { registerServer, readRegistry, verifyRecord, unregisterPort, setRecordSubdomain } from "../extensions/lib/serve/registry.js";
import { shortenPath } from "../extensions/lib/session-path-shortener.ts";
import { buildKilledSummary, buildDiscoveredSummary, buildListSummary, buildNoDirHint, formatServerCard } from "../extensions/lib/serve/tui.js";
// --- Phase 6B (#66): per-subdomain edge publishing via the Cloudflare API (replaces nginx.js).
import { parseAclFile, publishSubdomain, unpublishSubdomain, reapOrphans, subdomainToHostname } from "../extensions/lib/serve/cloudflare.js";

// No local certificates needed. Plain HTTP on loopback is gated securely at the VPS edge.

// ---
// AGENT-FIRST OUTPUT (#181)
//
// serve shipped with no machine-readable mode at all, so anything scripting it had to parse
// a box-drawn TUI table — the exact "prose is load-bearing" failure the standard names. The
// JSON below is the contract; the human rendering is free to change because it exists.
// Flat, one record per server, stable keys, no decoration.
//
// Exit codes: 0 success (an EMPTY result set is success), 1 operation failed, 2 usage error.
// ---

/** True when --json was passed. Set once by run(), read by the handlers. */
let jsonMode = false;

/** Emit one JSON document on stdout. Single writer so the shape stays in one place. */
function emitJson(payload: unknown): void {
	console.log(JSON.stringify(payload));
}

// #119: --list always shows every server on the box, full paths with ~/ prefix.
async function handleList(): Promise<void> {
	const activeServers = await discoverServers();
	if (jsonMode) {
		emitJson({
			schema: "serve/list@1",
			servers: activeServers.map((s) => ({
				pid: s.pid ?? null,
				port: s.port,
				dir: s.dir,
				kind: s.isLive ? "live" : "static",
				subdomain: s.subdomain ?? null,
				url: s.url,
				localUrl: s.localUrl ?? null,
				title: s.title,
			})),
		});
		return;
	}
	console.log(buildListSummary(activeServers));
}

function handleVersion(): void {
	try {
		const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "serve-cmd.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		console.log(`${manifest.name} ${manifest.version}`);
	} catch (err) {
		console.error(`⚠️ Failed to load command manifest: ${err}`);
		process.exitCode = 1;
	}
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

async function handleUnpub(subdomain: string): Promise<void> {
	try {
		await unpublishSubdomain({ subdomain });
		console.log(`🌐 Unpublished ${subdomain}.princess-pi.dev`);
	} catch (err) {
		console.warn(`⚠️ Failed to unpublish ${subdomain}: ${(err as Error).message}`);
	}
}

async function handleKill(trimmedArgs: string): Promise<void> {
	const killArgs = trimmedArgs.replace(/^(--kill|--cancel|--off|-k)/, "").trim();
	const targets = killArgs.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0);

	const activeServers = await discoverServers();
	const killedList: KilledServerInstance[] = [];
	const failedList: { pid: number | null; port: number; reason: string }[] = [];
	const killAll = targets.some((t) => t.toLowerCase() === "all");

	if (targets.length === 0) {
		if (jsonMode) { emitJson({ schema: "serve/kill@1", killed: [], failed: [], unclaimed: [] }); process.exitCode = 2; return; }
		console.log("No targets given — nothing killed. Use --kill <port|dir|all> to target specific servers.");
		process.exitCode = 2;
		return;
	}

	// #181: `--kill all` used to mean "every process whose cmdline contains http-server or
	// run-live-server" — including processes serve never started. It now kills only what the
	// registry claims, and REPORTS what it cannot account for. Warning/info only: the scan is
	// still a substring heuristic, and a heuristic may produce a sentence, never a SIGKILL.
	const unclaimed = killAll ? await scanUnclaimedServerLike() : [];

	if (killAll) {
		if (activeServers.length === 0) {
			if (!jsonMode) {
				console.warn("⚠️ No servers started by serve are currently running.");
				reportUnclaimed(unclaimed);
			} else {
				emitJson({ schema: "serve/kill@1", killed: [], failed: [], unclaimed });
			}
			return;
		}
		for (const server of activeServers) {
			const statusBefore = await checkServerStatus(server.localUrl || server.url);
			const killed = await killServerInstance(server);
			if (!killed) {
				failedList.push({ pid: server.pid ?? null, port: server.port, reason: "not-confirmed-dead" });
				if (!jsonMode) console.warn(`⚠️ Could NOT terminate server on port ${server.port} (PID ${server.pid ?? "unknown"} not found or still running). Skipping.`);
				continue;
			}
			const statusAfter = await checkServerStatus(server.localUrl || server.url);
			killedList.push({ port: server.port, dir: server.dir, url: server.url, localUrl: server.localUrl, subdomain: server.subdomain, title: server.title, pid: server.pid, statusBefore, statusAfter });
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
					failedList.push({ pid: matchedServer.pid ?? null, port: matchedServer.port, reason: "not-confirmed-dead" });
					if (!jsonMode) console.warn(`⚠️ Could NOT terminate server on port ${matchedServer.port} (PID ${matchedServer.pid ?? "unknown"} not found or still running).`);
					continue;
				}
				const statusAfter = await checkServerStatus(matchedServer.localUrl || matchedServer.url);
				killedList.push({ port: matchedServer.port, dir: matchedServer.dir, url: matchedServer.url, localUrl: matchedServer.localUrl, subdomain: matchedServer.subdomain, title: matchedServer.title, pid: matchedServer.pid, statusBefore, statusAfter });
			} else {
				if (!jsonMode) console.warn(`⚠️ Could not find any server started by serve matching "${target}".`);
			}
		}
	}

	if (killedList.length === 0) {
		if (jsonMode) { emitJson({ schema: "serve/kill@1", killed: [], failed: failedList, unclaimed }); return; }
		console.warn("No servers were terminated.");
		reportUnclaimed(unclaimed);
		return;
	}

	// --- Phase 6B (#66): unpublish each killed sub-domain from the edge (ingress rule + Access
	// app). Best-effort: a CF failure must not mask a successful local kill, so we warn and
	// continue. Subdomains dedup'd so two servers sharing a dir unpublish once.
	const killedSubdomains = [...new Set(killedList.map((k) => k.subdomain).filter((s): s is string => !!s))];
	for (const subdomain of killedSubdomains) {
		try {
			await unpublishSubdomain({ subdomain });
		} catch (err) {
			console.warn(`⚠️ Killed local origin for "${subdomain}" but failed to unpublish from Cloudflare: ${(err as Error).message}`);
		}
	}
	if (jsonMode) {
		emitJson({
			schema: "serve/kill@1",
			killed: killedList.map((k) => ({
				pid: k.pid ?? null,
				port: k.port,
				dir: k.dir,
				subdomain: k.subdomain ?? null,
				confirmed: true,
			})),
			failed: failedList,
			unclaimed,
		});
		return;
	}
	console.log(buildKilledSummary(killedList));
	reportUnclaimed(unclaimed);
}

/**
 * Human half of the unclaimed advisory (#181). The JSON half carries the same array under
 * `unclaimed` whenever this would print, so the two surfaces never disagree about what was
 * found. Says plainly that nothing was killed — the point is that serve no longer touches
 * processes it did not start.
 */
function reportUnclaimed(unclaimed: { pid: number; port: number | null; command: string }[]): void {
	if (unclaimed.length === 0) return;
	console.warn(`\nℹ️  ${unclaimed.length} server-like process(es) NOT started by serve — left running:`);
	for (const u of unclaimed) {
		console.warn(`     PID ${u.pid}${u.port !== null ? ` port ${u.port}` : ""}  ${u.command}`);
	}
	console.warn("     serve only kills what it started. Stop these yourself if you meant to.");
}

async function handleStart(trimmedArgs: string): Promise<void> {
	let dirs = trimmedArgs.split(/\s+/).map((d) => d.trim()).filter((d) => d.length > 0);
	const isStatic = dirs.includes("--static") || dirs.includes("-s");
	const force = dirs.includes("--force") || dirs.includes("-f");
	dirs = dirs.filter((d) => d !== "--static" && d !== "-s" && d !== "--force" && d !== "-f");

	// --- Phase 6B (#66): optional subdomain override. `serve <dir> --pub <subdomain>` publishes at
	// <subdomain>.princess-pi.dev instead of the repo-derived subdomain (which leaks internal paths,
	// e.g. "rogue-savvy/frontend/dist"). One override can only name one hostname, so it
	// requires exactly one target dir.
	let overrideSubdomain: string | null = null;
	let pubIdx = dirs.indexOf("--pub");
		if (pubIdx === -1) pubIdx = dirs.indexOf("-P");
	const asIdx = dirs.indexOf("--as");
	const idx = pubIdx !== -1 ? pubIdx : asIdx;
	if (idx !== -1) {
		const val = dirs[idx + 1];
		if (val && !val.startsWith("-")) { overrideSubdomain = val; dirs.splice(idx, 2); }
		else { console.warn("⚠️ --pub needs a sub-domain value (e.g. --pub my-preview); ignoring."); dirs.splice(idx, 1); }
	}

	// #117: no default dirs anymore (public/+docs/ rarely fit a given repo). With no target —
	// bare `serve` or flags-only (e.g. `--static`) — list what's already running here, then
	// suggest an agent prompt to find a servable dir. Start nothing; serving needs an explicit dir.
	if (dirs.length === 0) {
		await handleList();
		console.log("\n" + buildNoDirHint());
		return;
	}

	if (overrideSubdomain && dirs.length !== 1) {
		console.warn(`⚠️ --pub ${overrideSubdomain} ignored: it requires exactly one target directory (${dirs.length} given).`);
		overrideSubdomain = null;
	}

	let startPort = 8080;
	const startedPorts: number[] = [];
	// #307: the child handles, so the summary can ask "did it come up?" instead of sleeping.
	const started: StartedServer[] = [];

	// --- Phase 6B (#66): reap edge entries orphaned by a crash-without-kill (stale allow-
	// list live at the edge = security drift) before publishing new state. Best-effort:
	// no token / API failure must not block serving.
	// #306: reap needs a second fact besides a silent port — the registry's verdict on the
	// process serve spawned for it. Silent + no record → left published and said out loud.
	try {
		const evidence = readRegistry().map(r => ({ port: r.port, hostname: r.subdomain ? subdomainToHostname(r.subdomain) : null, verdict: verifyRecord(r) }));
		const reaped = await reapOrphans({
			evidence,
			onReaped: (_hostname, port) => unregisterPort(port),
			onUnverified: (hostname, port) => console.warn(`⚠️ ${hostname} → 127.0.0.1:${port} is not answering, but serve has no record of spawning it — left published (a service tenant mid-restart looks like this). Use --unpublish if it is gone.`),
		});
		if (reaped.length) console.log(`🧹 Reaped ${reaped.length} orphaned preview(s): ${reaped.join(", ")}`);
	} catch (err) {
		console.warn(`⚠️ Orphan reap skipped: ${(err as Error).message}`);
	}

	// Labels published this run — a second dir colliding on the same flattened label is refused.
	const activeLabels = new Set<string>();

	for (const rawDir of dirs) {
		const targetDir = path.resolve(process.cwd(), rawDir);

		if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
			console.warn(`⚠️ Warning: Directory "${rawDir}" does not exist. Skipping.`);
			continue;
		}

		const activeServers = await discoverServers();
		const existingServer = activeServers.find(s =>
			path.resolve(process.cwd(), s.dir) === targetDir && !!s.isLive === !isStatic
		);
		if (existingServer) {
			if (overrideSubdomain) {
				// Publish the new subdomain to the existing server's port (#119)
				try {
					const emails = parseAclFile(targetDir);
					const hostname = await publishSubdomain({ subdomain: overrideSubdomain, port: existingServer.port, emails, activeLabels });
					setRecordSubdomain(existingServer.port, overrideSubdomain); // reap evidence is hostname-bound (#318)
					activeLabels.add(hostname.split(".")[0]);
					console.log(`🌐 Published https://${hostname} (Access-gated, ${emails.length} allow-listed) on existing port ${existingServer.port}.`);
				console.log(formatServerCard({ ...existingServer, url: `https://${hostname}/` }));
				} catch (err) {
					console.warn(`⚠️ Directory "${rawDir}" already served on port ${existingServer.port}, but edge publish failed: ${(err as Error).message}`);
				}
			} else {
				console.log(`ℹ️ Note: Directory "${rawDir}" is already being served ${isStatic ? "statically" : "live-reloading"}. Skipping.`);
			}
			continue;
		}

		const envPath = path.join(targetDir, ".env");
		if (fs.existsSync(envPath) && !force) {
			console.warn(`⚠️ Found .env file in "${rawDir}"! Skipping (pass --force to serve anyway).`);
			continue;
		}

		// #181: ask the port, not the process table. Discovery only knows about servers WE
		// started, so it cannot tell us a systemd tenant or a hand-started server already holds
		// this port — only a bind attempt can.
		const port = await findFreePort(startPort);
		if (port === null) {
			console.warn(`⚠️ No free loopback port found at or above ${startPort}; skipping "${rawDir}".`);
			continue;
		}
		startPort = port + 1;

		// #66: publishing is opt-in via --pub. A subdomain ⟺ this preview is published to the edge:
		// it flows to the runner's --subdomain (live-ACL watcher target) AND the publish call, so
		// publish/kill/unpublish/watch all key off the same condition. No --pub → local only.
		const subdomain = overrideSubdomain; // null unless --pub given

		const __dirname = path.dirname(fileURLToPath(import.meta.url));
		const runnerPath = path.resolve(__dirname, "../extensions/lib/serve/run-live-server.js");

		const spawnCmd = isStatic ? "npx" : "node";
		const spawnArgs = isStatic
			? ["--", "http-server", targetDir, "-p", String(port), "-a", "127.0.0.1"]
			: [runnerPath, targetDir, ...(subdomain ? ["--subdomain", subdomain] : []), "-p", String(port), "-a", "127.0.0.1"];

		const serverProcess = spawn(spawnCmd, spawnArgs, { detached: true, stdio: "ignore" });
		serverProcess.unref();
		startedPorts.push(port);
		const startedEntry: StartedServer = { port, child: serverProcess, dir: rawDir, subdomain: null };
		started.push(startedEntry);

		// #181: record identity NOW, while this PID is unambiguously ours. Discovery reads
		// this instead of guessing from a `ps` substring, and `--kill` targets only what is
		// recorded here.
		if (serverProcess.pid) {
			registerServer({
				pid: serverProcess.pid,
				port,
				dir: path.resolve(process.cwd(), targetDir),
				kind: isStatic ? "static" : "live",
				subdomain,
			});
		}

		// --- Phase 6B (#66): publish to the edge ONLY when --pub or --as names a sub-domain. Upserts the
		// tunnel ingress rule (<subdomain>.princess-pi.dev → this loopback port) + a per-subdomain Access
		// app carrying the .serve-acl allow-list. Best-effort: the loopback origin is already
		// up, so any failure (no cf.env, reserved label, API error) warns and leaves it running.
		if (subdomain) {
			try {
				const emails = parseAclFile(targetDir);
				const hostname = await publishSubdomain({ subdomain, port, emails, activeLabels });
				activeLabels.add(hostname.split(".")[0]);
				startedEntry.subdomain = subdomain; // published — an early exit must take this back down
				console.log(`🌐 Published https://${hostname} (Access-gated, ${emails.length} allow-listed).`);
			} catch (err) {
				console.warn(`⚠️ Serving "${rawDir}" locally on 127.0.0.1:${port}, but edge publish failed: ${(err as Error).message}`);
			}
		} else {
			console.log(`ℹ️ Serving "${rawDir}" locally on 127.0.0.1:${port}. Pass --pub <name> to publish a gated preview at <name>.princess-pi.dev.`);
		}
	}

	// #307: no fixed sleep. Ask each spawn whether it came up — port answers, child exited,
	// or still pending at the ceiling — and say which. Concurrent, so the ceiling bounds the
	// whole start. An exited PUBLISHED server is unpublished before its record is retired.
	const SERVER_START_CEILING_MS = 10_000;
	const pendingPorts: number[] = [];
	for (const { server: s, result: r, unpublish, unpublishError } of await settleStartedServers(started, SERVER_START_CEILING_MS)) {
		if (r.state === "exited") {
			const how = r.signalCode ? `on ${r.signalCode}` : `with code ${r.exitCode}`;
			console.error(`❌ Server for "${s.dir}" exited ${how} before answering on 127.0.0.1:${s.port} (after ${r.elapsedMs} ms).`);
			if (unpublish === "done") console.error(`   Unpublished ${s.subdomain}.princess-pi.dev — nothing is behind it.`);
			if (unpublish === "failed") console.error(`   ⚠️ Could not unpublish ${s.subdomain}.princess-pi.dev (${unpublishError}); left for the next reap.`);
		} else if (r.state === "pending") {
			pendingPorts.push(s.port);
			console.warn(`⏳ Server for "${s.dir}" started but is not answering on 127.0.0.1:${s.port} yet (${r.elapsedMs} ms) — it may still be booting; check with --list.`);
		}
	}

	const allActiveServers = await discoverServers();
	const newServers = allActiveServers.filter(s => startedPorts.includes(s.port) && !pendingPorts.includes(s.port));
	if (allActiveServers.length === 0) {
		console.warn("No active directories are currently being served.");
		return;
	}
	if (newServers.length > 0) {
		console.log(buildDiscoveredSummary(newServers));
	}
}

async function run(): Promise<void> {
	await resolveIp();
	const rawArgs = process.argv.slice(2);
	// --json is a modifier, valid alongside any command — strip it before dispatch so every
	// existing exact-match branch below keeps working unchanged.
	jsonMode = rawArgs.includes("--json");
	const trimmedArgs = rawArgs.filter((a) => a !== "--json").join(" ").trim();

	if (trimmedArgs === "--version") return handleVersion();
	if (trimmedArgs === "--why") return handleWhy();
	if (trimmedArgs === "--list" || trimmedArgs === "-L") return handleList();
	if (trimmedArgs === "--help" || trimmedArgs === "-h") return handleHelp();
	// Pi-only flags — print a notice and exit cleanly
	if (["--show", "-S", "--hide", "-H"].includes(trimmedArgs)) {
		console.log("ℹ️  This flag is a Pi TUI setting only — run it inside Pi (/serve --help for details).");
		return;
	}
	// Emoji flags are valid everywhere — accepted silently (controls terminal rendering)
	if (["--emoji", "--emojii", "--no-emoji", "--no-emojii"].includes(trimmedArgs)) return;
	if (/^(--kill|--cancel|--off|-k)(\s|$)/.test(trimmedArgs)) return handleKill(trimmedArgs);
	if (/^(--unpub|-U)(\s|$)/.test(trimmedArgs)) {
		const subdomain = trimmedArgs.replace(/^(--unpub|-U)/, "").trim();
		if (!subdomain) { console.log("Usage: --unpub <subdomain>"); return; }
		return handleUnpub(subdomain);
	}
	return handleStart(trimmedArgs);
}

run();
