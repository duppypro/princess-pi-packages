import * as https from "node:https";
import * as http from "node:http";
import * as path from "node:path";
import { exec } from "node:child_process";
import { ServerInstance, getClientSlug } from "./domain.js";
import { hostnameForSlug } from "./cloudflare.js";

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

export function discoverServers(): Promise<ServerInstance[]> {
	return new Promise((resolve) => {
		exec("ps aux | grep -E 'http-server|run-live-server' | grep -v grep", async (error, stdout) => {
			if (error || !stdout) {
				resolve([]);
				return;
			}

			const servers: ServerInstance[] = [];
			const lines = stdout.split("\n").filter(l => l.trim().length > 0);
			const ip = await resolveIp();

			for (const line of lines) {
				const portMatch = line.match(/-p\s+(\d+)/) || line.match(/--port\s+(\d+)/);
				if (!portMatch) continue;
				const port = parseInt(portMatch[1], 10);

				if (servers.some(s => s.port === port)) continue;

				const parts = line.split(/\s+/);
				const httpServerIdx = parts.findIndex(p => p.includes("http-server") || p.includes("run-live-server"));
				if (httpServerIdx === -1) continue;

				// `ps aux` columns: USER(0) PID(1) ... — capture the PID here so the kill path
				// uses the SAME source as discovery, instead of a fragile second `lsof` lookup (#39).
				const parsedPid = Number.parseInt(parts[1], 10);
				const pid = Number.isNaN(parsedPid) ? undefined : parsedPid;

				let dir = "current";
				for (let i = httpServerIdx + 1; i < parts.length; i++) {
					const part = parts[i];
					if (part.startsWith("-")) {
						if (part === "-p" || part === "-C" || part === "-K" || part === "-a") {
							i++; // skip value
						}
						continue;
					}
					if (part.length > 0 && !part.includes("npx")) {
						dir = part;
						break;
					}
				}

				const isLive = line.includes("run-live-server");
				const localUrl = `http://127.0.0.1:${port}`;
				
				const absoluteDir = path.resolve(process.cwd(), dir);
				const clientSlug = getClientSlug(absoluteDir);
				const url = `https://${hostnameForSlug(clientSlug)}/`;

				let title = "Index Page";
				try {
					title = await fetchPageTitle(localUrl);
				} catch (e) {
					// ignore
				}

				servers.push({ port, dir, url, localUrl, title, isLive, clientSlug, pid });
			}

			resolve(servers);
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
	return confirmProcessKilled(pid);
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
