/**
 * @module serve/registry
 * @description The server registry (#181) — `serve`'s record of the processes it started.
 *
 * WHY this module exists. Discovery used to ask `ps aux` which processes *looked like*
 * servers: `grep -E 'http-server|run-live-server'`. The container was fine — `ps` output is
 * headerless and column-addressable — but the *predicate* was a guess about identity from
 * free text. Nobody adding a wrapper or renaming a binary would call that a breaking change,
 * so it was never a contract. Its cost was asymmetric and destructive: any foreign process
 * whose cmdline happened to contain one of those substrings was listed as ours and SIGKILLed
 * by `serve --kill all`.
 *
 * We spawn every server we own, so identity is a fact we HAVE at spawn time. The `ps` scan
 * existed only because we threw that fact away and re-derived it. Here we keep it instead.
 *
 * WHY (pid, startTicks) and not pid alone. A bare-PID registry moves the bug rather than
 * fixing it: the kernel recycles PIDs, so a dead server's PID can land on an unrelated
 * process and the registry would then claim a stranger is ours — with `--kill` pointed at it.
 * The corroborating field has to be exact, not a name; checking the recycled PID's cmdline
 * against "http-server" would corroborate a declared fact with a guessed one, which is worse
 * than checking nothing because it looks rigorous. `/proc/<pid>/stat` field 22 (`starttime`,
 * clock ticks since boot) is kernel-assigned and a recycled PID cannot reproduce it.
 * `(pid, starttime)` is the canonical Linux "same process?" identity — what pidfd and systemd
 * use.
 *
 * See docs/spec-181-serve-process-registry.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---
// Layout — alongside the existing sub-domain map, same config dir.
// ---

const SERVE_CONFIG_DIR = path.join(os.homedir(), ".config", "princess-pi-packages", "serve");
const REGISTRY_PATH = path.join(SERVE_CONFIG_DIR, "servers.json");

/** Bumped only on a breaking shape change. Readers ignore files from a future version. */
const REGISTRY_VERSION = 1;

/** How a server serves — mirrors the two spawn paths, declared rather than sniffed. */
export type ServerKind = "live" | "static";

/**
 * One server `serve` started. Flat, stable keys, one record per process.
 *
 * `port`/`dir`/`kind`/`subdomain` were previously re-derived from cmdline text on every
 * discovery (a port regex, an index walk skipping flag values, a `--subdomain` regex). All
 * of that is gone: every one of these was known at spawn time.
 */
export interface ServerRecord {
	pid: number;
	/**
	 * `/proc/<pid>/stat` field 22 at registration. `null` where /proc is unavailable
	 * (non-Linux), in which case verification degrades to PID-existence alone — a known
	 * weaker mode, recorded rather than pretended away. This repo's target is a Linux VPS.
	 */
	startTicks: number | null;
	port: number;
	/** Absolute path of the served directory. */
	dir: string;
	kind: ServerKind;
	/** Sub-domain given at spawn via `--pub`; null for local-only. Publish-after-start
	 *  (#119) still lives in the sub-domain map, which outlives the process. */
	subdomain: string | null;
	/** ISO-8601 UTC. Diagnostic only — never used for identity. */
	startedAt: string;
}

/**
 * Three-way, because "recycled" deserves its own name: it is the exact failure the
 * startTicks field exists to catch, and it must never be confused with "alive".
 */
export type RecordVerdict = "live" | "dead" | "recycled";

/** A server-like process the registry has no memory of starting. Advisory only (#181). */
export interface UnclaimedProcess {
	pid: number;
	/** Parsed from `-p`/`--port` when present. null when the cmdline does not say. */
	port: number | null;
	/** The process's own command line, verbatim, for a human to identify it by. */
	command: string;
}

// ---
// Process identity
// ---

/**
 * Read `/proc/<pid>/stat` field 22 (`starttime`), in clock ticks since boot.
 *
 * Field 2 (`comm`) is parenthesised and may itself contain spaces AND parens — a process
 * named `foo (bar) baz` is legal — so the only safe split is after the LAST `)`. After that
 * cut, index 0 is field 3 (`state`), hence field N is at index N-3 and starttime is 19.
 *
 * Returns null if the process is gone or /proc is unavailable. Never throws.
 */
export function readProcessStartTicks(pid: number): number | null {
	try {
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = raw.lastIndexOf(")");
		if (close === -1) return null;
		const fields = raw.slice(close + 1).trim().split(/\s+/);
		const ticks = Number(fields[19]);
		return Number.isFinite(ticks) ? ticks : null;
	} catch {
		return null;
	}
}

/**
 * True if the PID currently exists. Signal 0 sends nothing; it throws ESRCH when the process
 * is gone and EPERM when it exists but we may not signal it (still alive — a different user's).
 */
export function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM";
	}
}

/**
 * Is this record still the process we registered?
 *
 * `recycled` is the whole point: PID alive but started at a different time means the kernel
 * handed our old PID to someone else. Treated as dead for bookkeeping AND as untouchable for
 * signalling — callers must never kill a recycled PID.
 */
export function verifyRecord(record: ServerRecord): RecordVerdict {
	if (!pidExists(record.pid)) return "dead";
	// No ticks recorded (non-Linux): PID existence is all we have. Documented weaker mode.
	if (record.startTicks === null) return "live";
	const current = readProcessStartTicks(record.pid);
	// Ticks unreadable for a live PID (permissions, /proc gone) — cannot prove recycling,
	// so do not claim it. Fail toward "not ours" rather than toward a kill target.
	if (current === null) return "recycled";
	return current === record.startTicks ? "live" : "recycled";
}

// ---
// Persistence
// ---

function readRaw(): ServerRecord[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
		if (!parsed || parsed.version !== REGISTRY_VERSION) return [];
		return Array.isArray(parsed.servers) ? parsed.servers : [];
	} catch {
		return []; // absent or corrupt — an empty registry is the safe reading
	}
}

/**
 * Atomic write: temp file + rename. Two `serve` invocations can race (the widget ticks every
 * 4 s while a CLI kill runs), and a torn registry is worse than a stale one — a half-written
 * record is a PID we might act on.
 */
function writeRaw(servers: ServerRecord[]): void {
	try {
		fs.mkdirSync(SERVE_CONFIG_DIR, { recursive: true });
		const tmp = `${REGISTRY_PATH}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ version: REGISTRY_VERSION, servers }, null, 1), "utf8");
		fs.renameSync(tmp, REGISTRY_PATH);
	} catch { /* best-effort: a registry write must never take the server down with it */ }
}

/** Every record on file, unverified. Use `liveServers()` unless you specifically want the raw set. */
export function readRegistry(): ServerRecord[] {
	return readRaw();
}

export function getRegistryPath(): string {
	return REGISTRY_PATH;
}

/**
 * Record a server we just spawned. Reads startTicks here — immediately after spawn, while the
 * PID is unambiguously still ours.
 */
export function registerServer(entry: {
	pid: number;
	port: number;
	dir: string;
	kind: ServerKind;
	subdomain?: string | null;
}): ServerRecord {
	const record: ServerRecord = {
		pid: entry.pid,
		startTicks: readProcessStartTicks(entry.pid),
		port: entry.port,
		dir: entry.dir,
		kind: entry.kind,
		subdomain: entry.subdomain ?? null,
		startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
	};
	// Drop any stale record for the same PID or port before appending — a reused port means
	// the previous occupant is gone.
	const kept = readRaw().filter(r => r.pid !== record.pid && r.port !== record.port);
	writeRaw([...kept, record]);
	return record;
}

export function unregisterPid(pid: number): void {
	const all = readRaw();
	const kept = all.filter(r => r.pid !== pid);
	if (kept.length !== all.length) writeRaw(kept);
}

export function unregisterPort(port: number): void {
	const all = readRaw();
	const kept = all.filter(r => r.port !== port);
	if (kept.length !== all.length) writeRaw(kept);
}

/**
 * The servers that are ours AND running, with dead/recycled records pruned from disk.
 *
 * This is the single source of truth for discovery. It answers the identity question from
 * what we declared at spawn, and the liveness question from the kernel — neither from text
 * written for humans.
 */
export function liveServers(): ServerRecord[] {
	const all = readRaw();
	const live = all.filter(r => verifyRecord(r) === "live");
	if (live.length !== all.length) writeRaw(live);
	return live;
}
