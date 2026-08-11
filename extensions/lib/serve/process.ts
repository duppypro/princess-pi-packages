import * as https from "node:https";
import * as http from "node:http";
import * as path from "node:path";
import * as net from "node:net";
import { exec, execFile } from "node:child_process";
import { ServerInstance } from "./domain.js";
import { flattenSubdomainToLabel, readSubdomainMap } from "./cloudflare.js";
import { liveServers, readRegistry, unregisterPid, type UnclaimedProcess } from "./registry.js";

// Cached public IP address of the VPS
let cachedPublicIp: string | null = null;

export async function resolveIp(): Promise<string> {
	return "127.0.0.1";
}

// Kept for potential future use if needed, but no longer called
function getPublicIp(): Promise<string> {
	return new Promise((resolve) => {
		https.get("https://api.ipify.org", { timeout: 1000 }, (res) => {
			res.on("error", () => {}); // Prevent unhandled stream crashes
			let data = "";
			res.on("data", (chunk) => { data += chunk; });
			res.on("end", () => {
				const ip = data.trim();
				if (ip && ip.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
					resolve(ip);
				} else {
					resolve("127.0.0.1");
				}
			});
		}).on("error", () => {
			resolve("127.0.0.1");
		});
	});
}

/**
 * Every server `serve` started that is still running (#181).
 *
 * Identity comes from the registry — a fact we recorded at spawn — and liveness from
 * (pid, startTicks) against the kernel. Nothing here reads `ps`, and nothing here infers
 * what a process IS from what its command line SAYS.
 *
 * What this replaced: `ps aux | grep -E 'http-server|run-live-server' | grep -v grep`, plus
 * a port regex, an index walk skipping flag values, and a `--subdomain` regex to re-derive
 * fields we already knew. The narrowing is deliberate — a hand-started `npx http-server` is
 * no longer reported as ours, and therefore no longer killed by `--kill all`. It surfaces
 * through scanUnclaimedServerLike() instead.
 */
export async function discoverServers(): Promise<ServerInstance[]> {
	const records = liveServers();
	if (records.length === 0) return [];

	// Sub-domain map for servers published after start (#119) — a sub-domain outlives the
	// process that published it, so the map stays the authority for that case.
	const subdomainMap = readSubdomainMap();

	const servers: ServerInstance[] = [];
	for (const record of records) {
		const subdomain = record.subdomain ?? subdomainMap[String(record.port)]?.[0];
		const localUrl = `http://127.0.0.1:${record.port}`;
		// #66: a published server's public URL is its own <subdomain>.princess-pi.dev; an
		// unpublished (local-only) server has no public URL, only the loopback.
		// Why no ?token=: the static bypass token was a committed backdoor (#38 F2 → #59).
		const url = subdomain ? `https://${flattenSubdomainToLabel(subdomain)}.princess-pi.dev/` : localUrl;

		let title = "Index Page";
		try {
			title = await fetchPageTitle(localUrl);
		} catch {
			// ignore — a title is decoration, its absence is not a discovery failure
		}

		servers.push({
			port: record.port,
			dir: record.dir,
			url,
			localUrl,
			title,
			isLive: record.kind === "live",
			subdomain,
			pid: record.pid,
		});
	}
	return servers;
}

/**
 * Is this loopback port actually free? (#181)
 *
 * WHY this exists now. Port selection used to read `while (activeServers.some(s => s.port
 * === startPort)) startPort++` — which only worked because discovery returned every
 * server-like process on the box. Once discovery correctly narrowed to servers WE started,
 * that loop stopped seeing anything else and would hand out a port already held by a
 * systemd tenant or a hand-started server; the spawn then died on EADDRINUSE, silently.
 *
 * The narrowing did not cause this — it exposed it. "Is this port free" was always the
 * question being asked, and answering it by scanning a process table was the same
 * infer-from-a-proxy mistake as the substring predicate. Bind and find out.
 */
export function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.once("error", () => resolve(false));          // EADDRINUSE (or unusable) → taken
		probe.once("listening", () => probe.close(() => resolve(true)));
		probe.listen(port, "127.0.0.1");
	});
}

/**
 * The first free loopback port at or above `from`. Bounded so a saturated range fails loudly
 * instead of spinning; returns null when nothing in the window is available.
 */
export async function findFreePort(from: number, window = 100): Promise<number | null> {
	for (let port = from; port < from + window; port++) {
		if (await isPortFree(port)) return port;
	}
	return null;
}

/** The substrings the old predicate matched on. Kept ONLY as an advisory heuristic (#181). */
const SERVER_LIKE_HINTS = ["http-server", "run-live-server"];

/**
 * Server-like processes the registry has no memory of starting. **Advisory only.**
 *
 * This is the old `ps` predicate, demoted. It is still a guess about identity from free
 * text — the difference is what the guess is allowed to do. Before, it selected SIGKILL
 * targets; now its entire output is a warning for a human and a `unclaimed` array for an
 * agent. A guess is fine when it produces a sentence; it is not fine when it produces a
 * kill target.
 *
 * `ps -eo pid=,args=` rather than `ps aux | grep … | grep -v grep`: headerless, exactly two
 * columns, and no shell pipeline — which is why the `grep -v grep` is gone too. That second
 * grep only ever existed to undo the pipeline's own footprint.
 *
 * Never throws and never kills. A scan failure yields an empty advisory.
 */
export function scanUnclaimedServerLike(): Promise<UnclaimedProcess[]> {
	return new Promise((resolve) => {
		execFile("ps", ["-eo", "pid=,args="], (error, stdout) => {
			if (error || !stdout) {
				resolve([]);
				return;
			}
			const claimed = new Set(readRegistry().map(r => r.pid));
			const found: UnclaimedProcess[] = [];

			for (const line of stdout.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const spaceIdx = trimmed.indexOf(" ");
				if (spaceIdx === -1) continue;
				const pid = Number.parseInt(trimmed.slice(0, spaceIdx), 10);
				if (!Number.isFinite(pid)) continue;
				const command = trimmed.slice(spaceIdx + 1);

				if (!SERVER_LIKE_HINTS.some(hint => command.includes(hint))) continue;
				if (claimed.has(pid)) continue;      // ours — accounted for, not unclaimed
				if (pid === process.pid) continue;   // never report the scanning process

				const portMatch = command.match(/-p\s+(\d+)/) || command.match(/--port\s+(\d+)/);
				found.push({
					pid,
					port: portMatch ? Number.parseInt(portMatch[1], 10) : null,
					command,
				});
			}
			resolve(found);
		});
	});
}

export function findPidByPort(port: number): Promise<number | null> {
	return new Promise((resolve) => {
		exec(`lsof -t -i :${port}`, (error, stdout) => {
			if (error || !stdout) {
				resolve(null);
				return;
			}
			const pids = stdout.split("\n").map(p => p.trim()).filter(p => p.length > 0);
			if (pids.length > 0) {
				resolve(parseInt(pids[0], 10));
			} else {
				resolve(null);
			}
		});
	});
}

// Terminates a process by PID. Tries SIGKILL via the Node API first (fast,
// no subprocess); falls back to a shell `kill -9` if that throws (e.g. PID
// owned by a different user/namespace where process.kill is rejected).
export function killProcess(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (e) {
		exec(`kill -9 ${pid}`);
	}
}

// True if the PID still exists. `process.kill(pid, 0)` sends no signal; it throws ESRCH
// when the process is gone, or EPERM when it exists but we may not signal it (still alive).
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM";
	}
}

// Polls until the PID is gone (SIGKILL is fast but reaping/socket release is async).
export async function confirmProcessKilled(pid: number, retries = 10, delayMs = 100): Promise<boolean> {
	for (let i = 0; i < retries; i++) {
		if (!isProcessAlive(pid)) return true;
		await new Promise(r => setTimeout(r, delayMs));
	}
	return !isProcessAlive(pid);
}

// Single, reliable kill path for a discovered server (#39). Uses the PID captured at
// discovery time; falls back to an lsof-by-port lookup only if that's missing. Returns true
// ONLY when the process is actually confirmed gone — so callers can fail loud instead of
// silently reporting a still-running server as "terminated".
export async function killServerInstance(server: ServerInstance): Promise<boolean> {
	const pid = server.pid ?? (await findPidByPort(server.port));
	if (!pid) return false;
	killProcess(pid);
	const confirmed = await confirmProcessKilled(pid);
	// Drop the record only once the process is confirmed gone (#181). Unregistering a
	// still-running server would make it unkillable AND invisible — the worst of both.
	if (confirmed) unregisterPid(pid);
	return confirmed;
}

export function fetchPageTitle(url: string): Promise<string> {
	return new Promise((resolve) => {
		const isSsl = url.startsWith("https");
		const getter = isSsl ? https.get : http.get;
		const agent = isSsl ? new https.Agent({ rejectUnauthorized: false }) : undefined;

		getter(url, { agent, timeout: 500 } as any, (res) => {
			res.on("error", () => {}); // Prevent unhandled stream crashes
			let data = "";
			res.on("data", (chunk) => { data += chunk; });
			res.on("end", () => {
				const match = data.match(/<title>([^<]+)<\/title>/i);
				if (match && match[1]) {
					resolve(match[1].trim());
				} else {
					resolve(isSsl ? "Secure HTTPS Page" : "Web Page");
				}
			});
		}).on("error", () => {
			resolve(isSsl ? "Secure HTTPS Page" : "Web Page");
		});
	});
}

export function checkServerStatus(url: string): Promise<string> {
	return new Promise((resolve) => {
		const isSsl = url.startsWith("https");
		const getter = isSsl ? https.get : http.get;
		const agent = isSsl ? new https.Agent({ rejectUnauthorized: false }) : undefined;

		const req = getter(url, { agent, timeout: 400 } as any, (res) => {
			res.on("error", () => {}); // Prevent unhandled stream crashes
			res.resume(); // Safely consume/discard stream to prevent memory leaks and ECONNRESET crashes
			resolve(`[+] Online (${res.statusCode} ${res.statusMessage || "OK"})`);
		});

		req.on("error", (err: any) => {
			if (err.code === "ECONNREFUSED") {
				resolve("[-] Offline (Connection Refused)");
			} else {
				resolve(`[-] Offline (${err.code || err.message})`);
			}
		});
	});
}
