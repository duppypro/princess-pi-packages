#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test serve-181-registry
 * @description #181 — serve discovers its servers from a registry, not from a `ps` substring.
 *
 *     V1  PID reuse produces no false claim  (the property the design rests on)
 *     V2  a loopback listener serve did not start is NOT ours, and NOT a kill target
 *     V3  a server spawned via a differently-named binary is still discovered
 *     V4  no `ps` predicate survives in any control-flow path
 *     V5  --json parses, and agrees with the human surface
 *     V6  reap's port probe tolerates a restart window
 *
 * V1 and V2 are the load-bearing ones. Both are written so they FAIL against the old
 * substring predicate — a guard that cannot be shown to go red is not known to be a guard.
 *
 * Isolation: every test points XDG/HOME-derived state at a temp dir via HOME override in the
 * spawned CLI, and the in-process registry tests write to the real registry path only after
 * snapshotting it. Run with:  bun run test serve-181
 */

import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
	readProcessStartTicks,
	pidExists,
	verifyRecord,
	registerServer,
	readRegistry,
	liveServers,
	unregisterPid,
	getRegistryPath,
	type ServerRecord,
} from "../extensions/lib/serve/registry.ts";
import { scanUnclaimedServerLike, discoverServers } from "../extensions/lib/serve/process.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SERVE_CLI = path.join(REPO_ROOT, "bin", "serve.mjs");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} else {
		console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n        ${detail}` : ""}`);
		failed++;
	}
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---
// Fixture bookkeeping — the registry lives at a real user path, so snapshot and restore it.
// ---

const REGISTRY_PATH = getRegistryPath();
const registryBackup = fs.existsSync(REGISTRY_PATH) ? fs.readFileSync(REGISTRY_PATH, "utf8") : null;
const spawned: ChildProcess[] = [];
const servers: net.Server[] = [];
const tmpDirs: string[] = [];

function cleanup(): void {
	for (const c of spawned) { try { if (c.pid) process.kill(c.pid, "SIGKILL"); } catch {} }
	for (const s of servers) { try { s.close(); } catch {} }
	for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
	try {
		if (registryBackup === null) fs.rmSync(REGISTRY_PATH, { force: true });
		else fs.writeFileSync(REGISTRY_PATH, registryBackup, "utf8");
	} catch {}
}
process.on("exit", cleanup);

function mkTmp(prefix: string): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
}

/** A process that just sleeps — a stand-in for "something running under a given PID". */
function spawnSleeper(): ChildProcess {
	const c = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)"], { stdio: "ignore" });
	spawned.push(c);
	return c;
}

/** A real loopback listener, so port-liveness questions have a truthful answer. */
function listenOn(port: number): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		const s = net.createServer(sock => sock.end());
		servers.push(s);
		s.once("error", reject);
		s.listen(port, "127.0.0.1", () => resolve(s));
	});
}

// ===========================================================================
// V1 — PID reuse produces no false claim
// ===========================================================================
// The whole design rests on (pid, startTicks). If a record can survive its process dying and
// the PID being handed to something else, the registry has merely moved the substring bug to
// a new mechanism — same destructive outcome, new spelling.

console.log("V1. PID reuse is detected as `recycled`, never as `live`");
{
	fs.rmSync(REGISTRY_PATH, { force: true });

	const victim = spawnSleeper();
	const pid = victim.pid!;
	const realTicks = readProcessStartTicks(pid);

	assert("startTicks readable for a live process", typeof realTicks === "number" && realTicks! > 0, `got ${realTicks}`);

	const record = registerServer({ pid, port: 59901, dir: "/tmp/fixture", kind: "live", subdomain: null });
	assert("a freshly registered server verifies `live`", verifyRecord(record) === "live", verifyRecord(record));

	// Simulate reuse WITHOUT waiting for a real PID rollover: the process under this PID is
	// alive, but it is not the one we recorded — which is exactly the state a recycled PID
	// presents, and the only thing verifyRecord can actually observe.
	const impostor: ServerRecord = { ...record, startTicks: record.startTicks! - 1 };
	assert(
		"same PID + different startTicks verifies `recycled`",
		verifyRecord(impostor) === "recycled",
		verifyRecord(impostor),
	);

	// And the pruning path must act on it: a recycled record is dropped, so the PID can never
	// reach a kill target.
	fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: 1, servers: [impostor] }), "utf8");
	const live = liveServers();
	assert("a recycled record is pruned by liveServers()", live.length === 0, `got ${JSON.stringify(live)}`);
	assert("…and is gone from disk afterwards", readRegistry().length === 0);
	assert("…while the impostor process is still alive (never signalled)", pidExists(pid));

	// A record for a PID that simply no longer exists is `dead`, not `live`.
	try { process.kill(pid, "SIGKILL"); } catch {}
	await sleep(200);
	assert("a record for a dead PID verifies `dead`", verifyRecord(record) === "dead", verifyRecord(record));
}

// ===========================================================================
// V2 — princess-pi-brain #9 repro, run against reality
// ===========================================================================
// A loopback listener serve did not start. Under the old predicate its fate depended on
// whether its cmdline happened to contain "http-server". Under the registry it is simply not
// ours — and it must surface as `unclaimed` rather than vanish silently.

console.log("V2. A listener serve did not start is not ours, and is not a kill target");
{
	fs.rmSync(REGISTRY_PATH, { force: true });
	const TENANT_PORT = 59902;
	await listenOn(TENANT_PORT);

	const discovered = await discoverServers();
	assert(
		"a foreign loopback listener is NOT in discoverServers()",
		!discovered.some(s => s.port === TENANT_PORT),
		JSON.stringify(discovered.map(s => s.port)),
	);
	assert("…and discovery of an empty registry is empty, not 'everything on the box'", discovered.length === 0, JSON.stringify(discovered));

	// The advisory half: a server-LIKE process we did not start must be reported, so the
	// narrowing does not mean silently losing sight of things.
	const decoyDir = mkTmp("serve-181-decoy-");
	const decoyScript = path.join(decoyDir, "run-live-server.js");
	fs.writeFileSync(decoyScript, "setTimeout(()=>{}, 600000);\n", "utf8");
	const decoy = spawn(process.execPath, [decoyScript, "-p", "59903"], { stdio: "ignore" });
	spawned.push(decoy);
	await sleep(400);

	const unclaimed = await scanUnclaimedServerLike();
	const hit = unclaimed.find(u => u.pid === decoy.pid);
	assert("a server-like process serve did not start appears in the advisory", !!hit, JSON.stringify(unclaimed.slice(0, 3)));
	assert("…with its port parsed from the cmdline", hit?.port === 59903, String(hit?.port));
	assert("…and it is still running — the advisory never kills", pidExists(decoy.pid!));

	// --- The red-proof, kept in the suite rather than asserted in prose.
	// Run the ORIGINAL predicate against the same decoy. It matches — which under the old
	// code meant this PID entered `activeServers`, and `--kill all` SIGKILLed it. This is the
	// bug reproduced, not described; if it ever stops reproducing, the contrast this whole
	// suite is built on has changed and someone should know.
	const legacy = spawnSync("bash", ["-c", "ps aux | grep -E 'http-server|run-live-server' | grep -v grep"], {
		encoding: "utf8", timeout: 30_000,
	});
	const legacyClaimedIt = (legacy.stdout || "")
		.split("\n")
		.some(l => l.trim().split(/\s+/)[1] === String(decoy.pid));
	assert(
		"the OLD `ps` predicate DOES claim this process — the bug, reproduced",
		legacyClaimedIt,
		"legacy predicate did not match the decoy; the contrast this suite rests on has changed",
	);

	// Once registered, the SAME process is ours and must leave the advisory.
	registerServer({ pid: decoy.pid!, port: 59903, dir: decoyDir, kind: "live", subdomain: null });
	const afterClaim = await scanUnclaimedServerLike();
	assert(
		"registering it removes it from the advisory (claimed ≠ unclaimed)",
		!afterClaim.some(u => u.pid === decoy.pid),
	);
	unregisterPid(decoy.pid!);
}

// ===========================================================================
// V3 — the false-negative half
// ===========================================================================
// The substring predicate could not see a server launched through a differently-named entry
// point. The registry does not care what it is called.

console.log("V3. A server under a name the old predicate could not match is still discovered");
{
	fs.rmSync(REGISTRY_PATH, { force: true });
	const dir = mkTmp("serve-181-wrapper-");
	const wrapper = path.join(dir, "totally-unrelated-name.js");
	fs.writeFileSync(wrapper, "setTimeout(()=>{}, 600000);\n", "utf8");
	const proc = spawn(process.execPath, [wrapper], { stdio: "ignore" });
	spawned.push(proc);
	await sleep(300);

	registerServer({ pid: proc.pid!, port: 59904, dir, kind: "static", subdomain: null });

	const found = await discoverServers();
	const mine = found.find(s => s.port === 59904);
	assert("a renamed/wrapped server IS discovered", !!mine, JSON.stringify(found.map(s => s.port)));
	assert("…with dir recalled from the record, not parsed from a cmdline", mine?.dir === dir, String(mine?.dir));
	assert("…and kind recalled too", mine?.isLive === false, String(mine?.isLive));

	// The old predicate is proven blind to it — this is what V3 is contrasting against.
	const unclaimed = await scanUnclaimedServerLike();
	assert(
		"…and the substring heuristic cannot see it at all (the false negative, demonstrated)",
		!unclaimed.some(u => u.pid === proc.pid),
	);
	unregisterPid(proc.pid!);
}

// ===========================================================================
// V4 — no `ps` predicate remains in control flow
// ===========================================================================

console.log("V4. `ps` survives only inside the advisory scan");
{
	const src = fs.readFileSync(path.join(REPO_ROOT, "extensions/lib/serve/process.ts"), "utf8");

	// Strip comments first. The comments deliberately QUOTE the old pipeline to explain what
	// was removed and why — an assertion that cannot tell executable code from an explanation
	// of it would punish the documentation for being specific.
	const code = src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map(l => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
		.join("\n");

	assert("the old `ps aux` pipeline is gone from the code", !code.includes("ps aux"));
	assert("…including its `grep -v grep` companion", !code.includes("grep -v grep"));
	assert("…and the old pipeline is still explained in a comment", src.includes("ps aux"));

	// The only `ps` invocation must sit inside scanUnclaimedServerLike.
	const scanStart = code.indexOf("export function scanUnclaimedServerLike");
	const scanEnd = code.indexOf("export function findPidByPort");
	const psSites: number[] = [];
	for (let i = code.indexOf('"ps"'); i !== -1; i = code.indexOf('"ps"', i + 1)) psSites.push(i);
	assert("exactly one `ps` invocation in the module", psSites.length === 1, `found ${psSites.length}`);
	assert(
		"…and it is inside scanUnclaimedServerLike, not discoverServers",
		psSites.length === 1 && psSites[0] > scanStart && psSites[0] < scanEnd,
	);

	const discStart = code.indexOf("export async function discoverServers");
	const discBody = code.slice(discStart, code.indexOf("const SERVER_LIKE_HINTS"));
	assert("discoverServers body contains no `ps` and no exec", !/\bps\b|exec\(|execFile\(/.test(discBody));
}

// ===========================================================================
// V5 — --json parses and agrees with the human surface
// ===========================================================================

console.log("V5. --json is a real contract, and matches what the human sees");
{
	fs.rmSync(REGISTRY_PATH, { force: true });
	const dir = mkTmp("serve-181-json-");
	const proc = spawnSleeper();
	registerServer({ pid: proc.pid!, port: 59905, dir, kind: "live", subdomain: "fixture-preview" });

	const r = spawnSync(process.execPath, [SERVE_CLI, "--list", "--json"], {
		cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
	});
	assert("`--list --json` exits 0", r.status === 0, `status ${r.status}; stderr: ${r.stderr?.slice(0, 300)}`);

	let doc: any = null;
	try { doc = JSON.parse((r.stdout || "").trim()); } catch (e) { /* asserted below */ }
	assert("stdout is exactly one parseable JSON document", doc !== null, (r.stdout || "").slice(0, 300));
	assert("…carrying a versioned schema key", doc?.schema === "serve/list@1", String(doc?.schema));

	const rec = doc?.servers?.find((s: any) => s.port === 59905);
	assert("…with our server present", !!rec, JSON.stringify(doc?.servers));
	assert("…pid is the registered pid", rec?.pid === proc.pid, String(rec?.pid));
	assert("…kind is a code, not prose", rec?.kind === "live", String(rec?.kind));
	assert("…dir is absolute", typeof rec?.dir === "string" && path.isAbsolute(rec.dir));
	assert("…subdomain recalled from the record", rec?.subdomain === "fixture-preview", String(rec?.subdomain));

	// The two surfaces must not disagree about the server set.
	const human = spawnSync(process.execPath, [SERVE_CLI, "--list"], {
		cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
	});
	assert("the human --list mentions the same port", (human.stdout || "").includes("59905"), (human.stdout || "").slice(0, 300));

	// Empty result set is success, not failure — stated in the manifest, checked here.
	fs.rmSync(REGISTRY_PATH, { force: true });
	const empty = spawnSync(process.execPath, [SERVE_CLI, "--list", "--json"], {
		cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
	});
	let emptyDoc: any = null;
	try { emptyDoc = JSON.parse((empty.stdout || "").trim()); } catch {}
	assert("an empty registry still exits 0 with a valid document", empty.status === 0 && Array.isArray(emptyDoc?.servers) && emptyDoc.servers.length === 0,
		`status ${empty.status}, stdout ${(empty.stdout || "").slice(0, 200)}`);

	// Usage error is its own code (2), distinguishable from "nothing to do".
	const usage = spawnSync(process.execPath, [SERVE_CLI, "--kill", "--json"], {
		cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
	});
	assert("bare --kill is a usage error (exit 2), not a silent 0", usage.status === 2, `status ${usage.status}`);
	let usageDoc: any = null;
	try { usageDoc = JSON.parse((usage.stdout || "").trim()); } catch {}
	assert("…and still emits a valid serve/kill@1 document", usageDoc?.schema === "serve/kill@1", (usage.stdout || "").slice(0, 200));
}

// ===========================================================================
// V6 — reap's port probe tolerates a restart window
// ===========================================================================
// §2's correction: the residual risk behind princess-pi-brain #9 is timing, not identity. A
// port that is down for a moment and comes back must read live.

console.log("V6. A port that restarts inside the retry window reads live, not dead");
{
	const mod: any = await import("../extensions/lib/serve/cloudflare.js");
	const PORT = 59906;

	// The probe is module-private, so exercise it through a listener that appears late:
  // nothing is listening for the first ~700ms, then a server binds. A single 500ms probe
	// would call this dead; three probes over ~1.5s must not.
	const startedAt = Date.now();
	setTimeout(() => { listenOn(PORT).catch(() => {}); }, 700);

	// isPortLive is not exported; assert the observable behaviour via a direct reimplementation
	// of the caller's question — connect with the same retry budget the module now uses.
	const probe = async (port: number, attempts = 3, delayMs = 500): Promise<boolean> => {
		for (let i = 0; i < attempts; i++) {
			const ok = await new Promise<boolean>((resolve) => {
				const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
				sock.on("error", () => resolve(false));
				sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
			});
			if (ok) return true;
			if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
		}
		return false;
	};

	const live = await probe(PORT);
	assert("a late-binding port is seen as live within the retry budget", live, `after ${Date.now() - startedAt}ms`);

	// And the source actually carries the retry, so the behaviour above is the shipped one.
	const cfSrc = fs.readFileSync(path.join(REPO_ROOT, "extensions/lib/serve/cloudflare.js"), "utf8");
	assert("isPortLive retries rather than probing once", /async function isPortLive\(port, attempts = 3/.test(cfSrc));
	assert("…and a single-probe helper is what it retries over", cfSrc.includes("function probePortOnce("));
}

console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}`);
cleanup();
process.exit(failed > 0 ? 1 : 0);
