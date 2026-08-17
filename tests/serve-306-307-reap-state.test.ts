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
	getRegistryPath, registerServer, liveServers, readRegistry, verifyRecord, setRecordSubdomain, type ServerRecord,
} from "../extensions/lib/serve/registry.ts";
import { awaitServerUp, settleStartedServers } from "../extensions/lib/serve/process.ts";
import { skip } from "./lib/skips.ts";

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
console.log("A. classifyReapCandidate: probe is necessary, never sufficient; evidence is hostname+port bound");
{
	const H = "h1.princess-pi.dev", H2 = "h2.princess-pi.dev";
	const ev = (port: number, verdict: "live" | "dead" | "recycled", hostname: string | null = H) => [{ port, hostname, verdict }];
	const c = (port: number, probeLive: boolean, evidence?: any, hostname = H) => classifyReapCandidate({ port, hostname, probeLive, evidence });
	assert("port answers → keep (still serving), regardless of registry", c(1, true, []) === "keep-live");
	assert("port silent + registry says our process is DEAD → reap", c(1, false, ev(1, "dead")) === "reap");
	assert("port silent + registry says our PID was RECYCLED → reap (our process is gone)", c(1, false, ev(1, "recycled")) === "reap");
	assert("port silent + registry says our process is LIVE → keep (still starting)", c(1, false, ev(1, "live")) === "keep-starting");
	assert("port silent + NO registry record → keep-unverified (not something serve spawned)", c(1, false, []) === "keep-unverified");
	assert("evidence for a DIFFERENT port is not evidence", c(1, false, ev(2, "dead")) === "keep-unverified");
	assert("no evidence argument at all → keep-unverified (fail-safe for a legacy caller)", c(1, false) === "keep-unverified");
	// PR #318 review: a reused port must not let one tenant's death vouch for another's.
	assert("dead record for the SAME port but a DIFFERENT hostname is not evidence (port reuse)", c(1, false, ev(1, "dead", H2)) === "keep-unverified");
	assert("dead record with NO hostname (never published / pre-#318) is not evidence", c(1, false, ev(1, "dead", null)) === "keep-unverified");
	assert("mixed: dead record for H2 + live record for H on the same port → H is keep-starting", c(1, false, [...ev(1, "dead", H2), ...ev(1, "live", H)]) === "keep-starting");
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
	// The evidence adapter callers hand to reapOrphans: (port, hostname, verdict) from the raw registry.
	const evidence = readRegistry().map((r: ServerRecord) => ({ port: r.port, hostname: r.subdomain ? cf.subdomainToHostname(r.subdomain) : null, verdict: verifyRecord(r) }));
	assert("evidence adapter yields the dead published port for ITS hostname", classifyReapCandidate({ port: 59921, hostname: cf.subdomainToHostname("pub-preview"), probeLive: false, evidence }) === "reap");
	assert("…and not for another hostname on that port", classifyReapCandidate({ port: 59921, hostname: "other.princess-pi.dev", probeLive: false, evidence }) === "keep-unverified");
	// setRecordSubdomain: publish-after-start writes the fact reap will later need.
	const late = spawnSleeper(); await sleep(100);
	registerServer({ pid: late.pid!, port: 59923, dir: "/tmp/late", kind: "static", subdomain: null });
	setRecordSubdomain(59923, "late-pub");
	assert("setRecordSubdomain writes the sub-domain onto the port's record", readRegistry().some(r => r.port === 59923 && r.subdomain === "late-pub"));
	late.kill("SIGKILL"); await waitExit(late); liveServers();
	assert("…so the record now survives its process (it is published)", readRegistry().some(r => r.port === 59923));
	fs.rmSync(REGISTRY_PATH, { force: true });
}

// ===========================================================================
// B2. #306 — reapOrphans commits ingress FIRST; a failed PUT tears nothing down
// ===========================================================================
// Cloudflare is stood in by a fetch mock that intercepts only api.cloudflare.com and
// throws on anything else, so no real call can leak. Needs cf.env for loadCfEnv (token is
// only ever placed in a header the mock ignores); absent → declared skip.
console.log("\nB2. reapOrphans: PUT first, teardown after; failed PUT leaves evidence, app and map intact");
{
	const CF_ENV = path.join(os.homedir(), ".config", "princess-pi", "cf.env"); // CONFIG_DIR in cloudflare.js
	if (!fs.existsSync(CF_ENV)) {
		skip("no cf.env on this host — reapOrphans ordering not exercised");
	} else {
		const H1 = "reap-h1.princess-pi.dev", H2 = "svc-h2.princess-pi.dev", P = 59941;
		const MAP = path.join(os.homedir(), ".config", "princess-pi-packages", "serve", "subdomains.json");
		const mapBackup = fs.existsSync(MAP) ? fs.readFileSync(MAP, "utf8") : null;
		const restoreMap = () => { try { if (mapBackup === null) fs.rmSync(MAP, { force: true }); else fs.writeFileSync(MAP, mapBackup, "utf8"); } catch {} };
		const realFetch = globalThis.fetch;
		const calls: string[] = [];
		let putShouldFail = true;
		const ingress = [
			{ hostname: H1, service: `http://127.0.0.1:${P}` },
			{ hostname: H2, service: `http://127.0.0.1:${P}` }, // a service tenant on a reused port — no record
			{ service: "http_status:404" },
		];
		const apps = [
			{ id: "app1", name: `serve reap-h1`, domain: H1 },
			{ id: "app2", name: `serve svc-h2`, domain: H2 },
		];
		const ok = (result: any) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
		globalThis.fetch = (async (input: any, init: any = {}) => {
			const url = String(input);
			if (!url.startsWith("https://api.cloudflare.com/")) throw new Error(`test fetch mock: unexpected URL ${url}`);
			const method = init.method || "GET";
			calls.push(`${method} ${url.replace(/^.*\/v4/, "")}`);
			if (/\/cfd_tunnel\/.*\/configurations$/.test(url) && method === "GET") return ok({ config: { ingress } });
			if (/\/cfd_tunnel\/.*\/configurations$/.test(url) && method === "PUT") {
				if (putShouldFail) return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "injected" }] }), { status: 500 });
				return ok({});
			}
			if (/\/access\/apps\?/.test(url) && method === "GET") return ok(apps);
			if (/\/access\/apps\/app\d+$/.test(url) && method === "DELETE") return ok({});
			throw new Error(`test fetch mock: unhandled ${method} ${url}`);
		}) as any;
		try {
			const evidence = [{ port: P, hostname: H1, verdict: "dead" }];
			fs.mkdirSync(path.dirname(MAP), { recursive: true });
			fs.writeFileSync(MAP, JSON.stringify({ [String(P)]: ["reap-h1"] }), "utf8");
			const reapedCb: string[] = [], unverified: string[] = [];
			// Run 1 — PUT fails.
			let threw = false;
			try { await cf.reapOrphans({ evidence, onReaped: (h: string) => reapedCb.push(h), onUnverified: (h: string) => unverified.push(h) }); }
			catch { threw = true; }
			assert("failed PUT propagates as an error (caller prints 'reap skipped')", threw);
			assert("H2 (service tenant, no record) reported unverified, not reaped", unverified.includes(H2) && !reapedCb.includes(H2), JSON.stringify({ unverified, reapedCb }));
			assert("failed PUT → onReaped never called (registry evidence intact)", reapedCb.length === 0, JSON.stringify(reapedCb));
			assert("failed PUT → no Access-app DELETE issued", !calls.some(c => c.startsWith("DELETE")), calls.join("\n"));
			assert("failed PUT → subdomain map untouched", JSON.parse(fs.readFileSync(MAP, "utf8"))[String(P)]?.[0] === "reap-h1");
			// Run 2 — PUT succeeds.
			calls.length = 0; putShouldFail = false;
			const reaped = await cf.reapOrphans({ evidence, onReaped: (h: string) => reapedCb.push(h), onUnverified: (h: string) => unverified.push(h) });
			assert("successful run reaps H1 only", reaped.length === 1 && reaped[0] === H1, JSON.stringify(reaped));
			const putIdx = calls.findIndex(c => c.startsWith("PUT")), delIdx = calls.findIndex(c => c.startsWith("DELETE"));
			assert("PUT is issued before any DELETE", putIdx >= 0 && delIdx > putIdx, calls.join("\n"));
			assert("onReaped called for H1 after the commit", reapedCb.length === 1 && reapedCb[0] === H1);
			assert("map entry for the reaped port removed", !JSON.parse(fs.readFileSync(MAP, "utf8"))[String(P)]);
		} finally {
			globalThis.fetch = realFetch;
			restoreMap();
		}
	}
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

	// bind race (PR #318 review): a FOREIGN listener already owns the port and our child dies
	// — the answering port must not be reported as our server being up.
	const FOREIGN = 59935;
	await listenOn(FOREIGN);
	const loser = spawn(process.execPath, ["-e", "process.exit(98)"], { stdio: "ignore" }); spawned.push(loser);
	await waitExit(loser);
	const r5 = await awaitServerUp({ port: FOREIGN, child: loser, ceilingMs: 5_000 });
	assert("port answers but OUR child is dead → exited, not up (bind race lost)", r5.state === "exited" && r5.exitCode === 98, JSON.stringify(r5));

	// signal: killed child → exited with the signal named.
	const sig = spawnSleeper(); sig.kill("SIGKILL"); await waitExit(sig);
	const r4 = await awaitServerUp({ port: 59934, child: sig, ceilingMs: 5_000 });
	assert("signal-killed child → exited naming the signal", r4.state === "exited" && r4.signalCode === "SIGKILL", JSON.stringify(r4));
}

// ===========================================================================
// C2. settleStartedServers — concurrent ceiling; an exited PUBLISHED server is unpublished
// ===========================================================================
console.log("\nC2. settleStartedServers: ceiling bounds the whole start; exited+published → unpublish then retire; unpublish failure keeps the record");
{
	// Concurrency: three alive-but-silent children with a 600 ms ceiling must settle in ~600 ms, not ~1800.
	const trio = [59951, 59952, 59953].map(port => ({ port, child: spawnSleeper(), dir: `/tmp/d${port}`, subdomain: null }));
	const t0 = Date.now();
	const outs = await settleStartedServers(trio, 600);
	const took = Date.now() - t0;
	assert("three pending servers settle in about one ceiling, not three", took < 1_300, `${took}ms`);
	assert("…each reported pending", outs.every(o => o.result.state === "pending"), JSON.stringify(outs.map(o => o.result.state)));

	const CF_ENV = path.join(os.homedir(), ".config", "princess-pi", "cf.env");
	if (!fs.existsSync(CF_ENV)) {
		skip("no cf.env on this host — unpublish-on-exit not exercised");
	} else {
		const realFetch = globalThis.fetch;
		const calls: string[] = [];
		let unpublishShouldFail = false;
		const ok = (result: any) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
		const H = "early-exit.princess-pi.dev";
		globalThis.fetch = (async (input: any, init: any = {}) => {
			const url = String(input); const method = init.method || "GET";
			if (!url.startsWith("https://api.cloudflare.com/")) throw new Error(`test fetch mock: unexpected URL ${url}`);
			calls.push(`${method} ${url.replace(/^.*\/v4/, "")}`);
			if (/\/configurations$/.test(url) && method === "GET") return ok({ config: { ingress: [{ hostname: H, service: "http://127.0.0.1:59961" }, { service: "http_status:404" }] } });
			if (/\/configurations$/.test(url) && method === "PUT") return unpublishShouldFail ? new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "injected" }] }), { status: 500 }) : ok({});
			if (/\/access\/apps\?/.test(url) && method === "GET") return ok([{ id: "appX", name: "serve early-exit", domain: H }]);
			if (/\/access\/apps\/appX$/.test(url) && method === "DELETE") return ok({});
			throw new Error(`test fetch mock: unhandled ${method} ${url}`);
		}) as any;
		try {
			fs.rmSync(REGISTRY_PATH, { force: true });
			// (1) published, child dies before binding, unpublish succeeds → record retired
			const dead1 = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" }); spawned.push(dead1); await sleep(50);
			registerServer({ pid: dead1.pid!, port: 59961, dir: "/tmp/e1", kind: "static", subdomain: "early-exit" });
			await waitExit(dead1);
			const [o1] = await settleStartedServers([{ port: 59961, child: dead1, dir: "/tmp/e1", subdomain: "early-exit" }], 2_000);
			assert("exited + published + unpublish ok → unpublish 'done'", o1.result.state === "exited" && o1.unpublish === "done", JSON.stringify(o1));
			assert("…ingress PUT and Access DELETE were issued", calls.some(c => c.startsWith("PUT")) && calls.some(c => c.startsWith("DELETE")), calls.join("\n"));
			assert("…record retired", !readRegistry().some(r => r.port === 59961), JSON.stringify(readRegistry()));
			// (2) published, child dies, unpublish FAILS → record kept as reap evidence
			calls.length = 0; unpublishShouldFail = true;
			const dead2 = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" }); spawned.push(dead2); await sleep(50);
			registerServer({ pid: dead2.pid!, port: 59961, dir: "/tmp/e2", kind: "static", subdomain: "early-exit" });
			await waitExit(dead2);
			const [o2] = await settleStartedServers([{ port: 59961, child: dead2, dir: "/tmp/e2", subdomain: "early-exit" }], 2_000);
			assert("exited + published + unpublish FAILS → unpublish 'failed' with the error", o2.unpublish === "failed" && /injected/.test(o2.unpublishError || ""), JSON.stringify(o2));
			assert("…record KEPT (reap's hostname-bound evidence for the next run)", readRegistry().some(r => r.port === 59961 && r.subdomain === "early-exit"), JSON.stringify(readRegistry()));
			// (3) unpublished child dies → simply retired, no CF traffic
			calls.length = 0;
			const dead3 = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" }); spawned.push(dead3); await sleep(50);
			registerServer({ pid: dead3.pid!, port: 59962, dir: "/tmp/e3", kind: "static", subdomain: null });
			await waitExit(dead3);
			const [o3] = await settleStartedServers([{ port: 59962, child: dead3, dir: "/tmp/e3", subdomain: null }], 2_000);
			assert("exited + unpublished → retired, no Cloudflare calls", o3.unpublish === "not-published" && calls.length === 0 && !readRegistry().some(r => r.port === 59962), JSON.stringify({ o3, calls }));
			fs.rmSync(REGISTRY_PATH, { force: true });
		} finally { globalThis.fetch = realFetch; }
	}
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
	assert("bin/serve.ts settles server state instead (concurrently)", /settleStartedServers\(/.test(serveTs));
	assert("extensions/serve.ts settles server state instead (concurrently)", /settleStartedServers\(/.test(extTs));
	assert("bin/serve.ts hands reap the registry evidence", /reapOrphans\(\{\s*evidence/.test(serveTs));
	assert("extensions/serve.ts hands reap the registry evidence", /reapOrphans\(\{\s*evidence/.test(extTs));
	assert("reapOrphans routes the decision through classifyReapCandidate", /classifyReapCandidate\(\{/.test(cfJs) && /export async function reapOrphans\(\{/.test(cfJs));
}

console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);
