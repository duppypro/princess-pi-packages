#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test serve-306-307-reap-state
 * @description Two clocks in `serve` that stood in for state (#306, #307 — the 2026-08-17
 *   race-sleep audit):
 *
 *   #306 — reap-on-start deleted a serve-owned tunnel ingress rule when 3 TCP probes over
 *   ~1.5 s failed. The probe stays as a NECESSARY condition; it is no longer SUFFICIENT.
 *   Reap now also needs a second, non-clock fact from the #181 registry: a record for that
 *   port whose process is verifiably gone (`dead` / `recycled`). No record → not a server
 *   `serve` spawned → could be a service tenant mid-restart → left published and reported
 *   as unverified. A record whose process is LIVE but not answering → still starting → kept.
 *   The decision is a pure function (`classifyReapCandidate`) so it is testable without
 *   Cloudflare; `reapOrphans` takes the registry evidence by injection because
 *   `cloudflare.js` must stay plain-node importable (run-live-server.js loads it).
 *
 *   #307 — after `spawn`, `serve` slept a flat 1200 ms and then read the registry to print
 *   the summary. Now `awaitServerUp({port, child, ceilingMs})` polls state: port answers →
 *   `up`; child exited → `exited` (with code/signal); ceiling with the child alive and the
 *   port silent → `pending`, reported as such, never as failure or as success.
 *
 *   The registry pruning rule changed to make #306's evidence survive: `liveServers()` no
 *   longer drops a dead record that carries a `subdomain` — reap consumes it. Unpublished
 *   dead records prune as before.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	getRegistryPath, registerServer, liveServers, readRegistry, verifyRecord, type ServerRecord,
} from "../extensions/lib/serve/registry.ts";
import { awaitServerUp } from "../extensions/lib/serve/process.ts";

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function pollUntil(pred: () => boolean, ceilingMs: number, stepMs = 50): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ceilingMs) { if (pred()) return true; await sleep(stepMs); }
	return pred();
}

// Registry lives at a real user path — snapshot and restore.
const REGISTRY_PATH = getRegistryPath();
const registryBackup = fs.existsSync(REGISTRY_PATH) ? fs.readFileSync(REGISTRY_PATH, "utf8") : null;
const spawned: ChildProcess[] = [];
const servers: net.Server[] = [];
function cleanup(): void {
	for (const c of spawned) { try { if (c.pid) process.kill(c.pid, "SIGKILL"); } catch {} }
	for (const s of servers) { try { s.close(); } catch {} }
	try {
		if (registryBackup === null) fs.rmSync(REGISTRY_PATH, { force: true });
		else fs.writeFileSync(REGISTRY_PATH, registryBackup, "utf8");
	} catch {}
}
process.on("exit", cleanup);
function spawnSleeper(): ChildProcess {
	const c = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)"], { stdio: "ignore" });
	spawned.push(c); return c;
}
function listenOn(port: number): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		const s = net.createServer(sock => sock.end());
		servers.push(s);
		s.once("error", reject);
		s.listen(port, "127.0.0.1", () => resolve(s));
	});
}
const waitExit = (c: ChildProcess) => new Promise<void>(res => { if (c.exitCode !== null || c.signalCode !== null) res(); else c.once("exit", () => res()); });

const cf: any = await import("../extensions/lib/serve/cloudflare.js");
const { classifyReapCandidate } = cf;

// ===========================================================================
// A. #306 — the reap decision needs registry evidence, not just a silent port
// ===========================================================================
console.log("A. classifyReapCandidate: probe is necessary, never sufficient");
{
	const ev = (port: number, verdict: "live" | "dead" | "recycled") => [{ port, verdict }];
	assert("port answers → keep (still serving), regardless of registry", classifyReapCandidate({ port: 1, probeLive: true, evidence: [] }) === "keep-live");
	assert("port silent + registry says our process is DEAD → reap", classifyReapCandidate({ port: 1, probeLive: false, evidence: ev(1, "dead") }) === "reap");
	assert("port silent + registry says our PID was RECYCLED → reap (our process is gone)", classifyReapCandidate({ port: 1, probeLive: false, evidence: ev(1, "recycled") }) === "reap");
	assert("port silent + registry says our process is LIVE → keep (still starting)", classifyReapCandidate({ port: 1, probeLive: false, evidence: ev(1, "live") }) === "keep-starting");
	assert("port silent + NO registry record → keep-unverified (not something serve spawned)", classifyReapCandidate({ port: 1, probeLive: false, evidence: [] }) === "keep-unverified");
	assert("evidence for a DIFFERENT port is not evidence", classifyReapCandidate({ port: 1, probeLive: false, evidence: ev(2, "dead") }) === "keep-unverified");
	assert("no evidence argument at all → keep-unverified (fail-safe for a legacy caller)", classifyReapCandidate({ port: 1, probeLive: false }) === "keep-unverified");
}

// ===========================================================================
// B. #306 — the evidence survives until reap reads it
// ===========================================================================
console.log("\nB. A published server's dead record is kept by liveServers(); an unpublished one is pruned");
{
	fs.rmSync(REGISTRY_PATH, { force: true });
	const pub = spawnSleeper(), unpub = spawnSleeper();
	await sleep(100);
	registerServer({ pid: pub.pid!, port: 59921, dir: "/tmp/pub", kind: "static", subdomain: "pub-preview" });
	registerServer({ pid: unpub.pid!, port: 59922, dir: "/tmp/unpub", kind: "static", subdomain: null });
	pub.kill("SIGKILL"); unpub.kill("SIGKILL");
	await waitExit(pub); await waitExit(unpub);
	const live = liveServers();
	assert("neither dead server is reported live", live.length === 0, JSON.stringify(live));
	const raw = readRegistry();
	assert("the PUBLISHED dead record survives on disk (reap's evidence)", raw.some(r => r.port === 59921), JSON.stringify(raw));
	assert("the UNPUBLISHED dead record is pruned as before", !raw.some(r => r.port === 59922), JSON.stringify(raw));
	assert("…and verifyRecord still calls the survivor dead", raw.filter(r => r.port === 59921).every(r => verifyRecord(r) !== "live"));
	// The evidence adapter callers hand to reapOrphans: (port, verdict) pairs from the raw registry.
	const evidence = readRegistry().map((r: ServerRecord) => ({ port: r.port, verdict: verifyRecord(r) }));
	assert("evidence adapter yields the dead published port", classifyReapCandidate({ port: 59921, probeLive: false, evidence }) === "reap");
	fs.rmSync(REGISTRY_PATH, { force: true });
}

// ===========================================================================
// C. #307 — awaitServerUp: state, not a stopwatch
// ===========================================================================
console.log("\nC. awaitServerUp resolves on port-up, child-exit, or a bounded pending");
{
	// up: a late-binding listener (700 ms) is seen as up — the old sleep(1200) happened to
	// cover this; the poll covers it by asking, not by waiting a fixed span.
	const PORT = 59931;
	const child = spawnSleeper();
	setTimeout(() => { listenOn(PORT).catch(() => {}); }, 700);
	const t0 = Date.now();
	const r1 = await awaitServerUp({ port: PORT, child, ceilingMs: 5_000 });
	assert("late-binding port → up", r1.state === "up", JSON.stringify(r1));
	assert("…resolved by asking, well under a fixed 1200 ms + slack", Date.now() - t0 < 1_500, `${Date.now() - t0}ms`);

	// exited: the child dies before binding → exited with its code, promptly.
	const dead = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" }); spawned.push(dead);
	const t1 = Date.now();
	const r2 = await awaitServerUp({ port: 59932, child: dead, ceilingMs: 5_000 });
	assert("child exits before binding → exited", r2.state === "exited", JSON.stringify(r2));
	assert("…carrying the exit code", r2.exitCode === 3, JSON.stringify(r2));
	assert("…without waiting out the ceiling", Date.now() - t1 < 2_000, `${Date.now() - t1}ms`);

	// pending: child alive, port silent, ceiling hit → pending (a fact, not a verdict).
	const slow = spawnSleeper();
	const r3 = await awaitServerUp({ port: 59933, child: slow, ceilingMs: 400 });
	assert("child alive + port silent past the ceiling → pending", r3.state === "pending", JSON.stringify(r3));

	// signal: killed child → exited with the signal named.
	const sig = spawnSleeper(); sig.kill("SIGKILL"); await waitExit(sig);
	const r4 = await awaitServerUp({ port: 59934, child: sig, ceilingMs: 5_000 });
	assert("signal-killed child → exited naming the signal", r4.state === "exited" && r4.signalCode === "SIGKILL", JSON.stringify(r4));
}

// ===========================================================================
// D. Source-level pins — the shipped code carries these shapes
// ===========================================================================
console.log("\nD. The shipped code carries the change");
{
	const REPO_ROOT = path.resolve(import.meta.dirname, "..");
	const serveTs = fs.readFileSync(path.join(REPO_ROOT, "bin/serve.ts"), "utf8");
	const extTs = fs.readFileSync(path.join(REPO_ROOT, "extensions/serve.ts"), "utf8");
	const cfJs = fs.readFileSync(path.join(REPO_ROOT, "extensions/lib/serve/cloudflare.js"), "utf8");
	assert("bin/serve.ts no longer sleeps 1200 ms after spawn", !/setTimeout\(r, 1200\)/.test(serveTs));
	assert("extensions/serve.ts no longer sleeps 1200 ms after spawn", !/setTimeout\(r, 1200\)/.test(extTs));
	assert("bin/serve.ts awaits server state instead", /awaitServerUp\(/.test(serveTs));
	assert("extensions/serve.ts awaits server state instead", /awaitServerUp\(/.test(extTs));
	assert("bin/serve.ts hands reap the registry evidence", /reapOrphans\(\{\s*evidence/.test(serveTs));
	assert("extensions/serve.ts hands reap the registry evidence", /reapOrphans\(\{\s*evidence/.test(extTs));
	assert("reapOrphans routes the decision through classifyReapCandidate", /classifyReapCandidate\(\{/.test(cfJs) && /export async function reapOrphans\(\{/.test(cfJs));
}

console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);
