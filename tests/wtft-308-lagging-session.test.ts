#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-308-lagging-session
 * @description A session .jsonl that does not exist YET is not "not found" (#308).
 *
 *   Claude Code knows the session id — and therefore the transcript path — at
 *   launch, but writes the first line only after the first real prompt (not a
 *   /command) completes. The daemon has waited for that file since #124/#129;
 *   the CLI still hard-failed with "does not exist" / exit 1. This suite pins
 *   the CLI's new contract on a path that is absent at the first call and
 *   appears later:
 *
 *   1. non-watch: exit 0, states the fact (log not written yet), no "not
 *      found" / "does not exist" copy, and the daemon it spawned is alive and
 *      waiting on the lease.
 *   2. once the session is written, a second non-watch run renders the chart.
 *   3. --watch on the absent path renders a waiting line (no 5 s clock-out),
 *      then renders the chart when the file appears; 'q' exits 0.
 *
 *   4. the startup reaper (#130) no longer treats "not written yet" as "gone":
 *      a daemon parked on an absent session survives another daemon's startup
 *      pass — before #308 it was SIGTERMed (and SIGTERMed itself), so the
 *      #124 "waiting for session .jsonl" state was unreachable by a live daemon.
 *      A session that once existed and was removed is still reaped.
 *
 *   Every wait in here is a poll on a real predicate with a generous ceiling —
 *   never a bare sleep standing in for a state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";
import { getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";

const SCRIPT = path.resolve(import.meta.dirname, "..", "wtft");
const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
async function pollUntil(pred: () => boolean, ceilingMs: number, stepMs = 100): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ceilingMs) {
		if (pred()) return true;
		await sleep(stepMs);
	}
	return pred();
}
function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
function readPid(pidPath: string): number {
	try { return parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10) || 0; } catch { return 0; }
}
/** Copy that must never appear for a path that is merely late. */
const FORBIDDEN = [/not found/i, /does not exist/i, /invalid/i];
const hasForbidden = (s: string) => FORBIDDEN.some(re => re.test(stripAnsi(s)));

// A Claude-style UUID basename — the daemon keys its lease on it (#155).
const SESSION_ID = "308c0de0-1a9b-4c3d-9e8f-000000000308";
const TS = Date.now();
function sessionLines(): string {
	return [
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant", id: "msg_308_001", model: "claude-sonnet-4-20250514",
				timestamp: new Date(TS - 600_000).toISOString(),
				usage: { input_tokens: 2000, output_tokens: 500 },
				content: [{ type: "tool_use", name: "write", input: { file_path: "src/main.ts" } }],
			},
		}),
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant", id: "msg_308_002", model: "claude-sonnet-4-20250514",
				timestamp: new Date(TS - 300_000).toISOString(),
				usage: { input_tokens: 500, output_tokens: 200 },
				content: [{ type: "tool_use", name: "bash", input: { command: "git diff --stat" } }],
			},
		}),
	].join("\n") + "\n";
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308-"));
const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
const pidPath = getDaemonPidPath(sessionPath);
try { fs.unlinkSync(pidPath); } catch {}
const spawnedPids = new Set<number>();
const cleanup = () => {
	for (const pid of spawnedPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	const pid = readPid(pidPath);
	if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} }
	try { fs.unlinkSync(pidPath); } catch {}
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);

// ---
// 1. Non-watch on an absent path: a fact, exit 0, daemon waiting.
// ---
console.log("1. Non-watch, session .jsonl not written yet");
{
	let out = "", code = 0;
	try {
		out = execSync(`${SCRIPT} -s '${sessionPath}' -l 5 --no-emoji 2>&1`, { encoding: "utf8", timeout: 15_000 });
	} catch (err: any) {
		out = `${err.stdout || ""}${err.stderr || ""}`;
		code = err.status ?? 1;
	}
	assert("exit 0", code === 0, `exit ${code}: ${stripAnsi(out).trim()}`);
	assert("no 'not found' / 'does not exist' / 'invalid' copy", !hasForbidden(out), stripAnsi(out).trim());
	assert("states the fact: log not written yet", /not written yet/i.test(stripAnsi(out)), stripAnsi(out).trim());
	assert("names the path it is waiting on", out.includes(sessionPath));

	const claimed = await pollUntil(() => readPid(pidPath) > 0 && isAlive(readPid(pidPath)), 5_000);
	const pid = readPid(pidPath);
	if (pid > 0) spawnedPids.add(pid);
	assert("daemon spawned and holds the lease while waiting", claimed, `pidPath=${pidPath} pid=${pid}`);
	assert("session file still absent (the CLI did not create it)", !fs.existsSync(sessionPath));
}

// ---
// 2. Session appears → the SAME waiting daemon parses it → chart renders.
// ---
console.log("\n2. Session written after the fact → chart");
{
	const pidBefore = readPid(pidPath);
	fs.writeFileSync(sessionPath, sessionLines());
	const tagsDir = path.join(dir, "wtft-tags");
	const gotData = await pollUntil(() => {
		try {
			return fs.readdirSync(tagsDir).some(f => {
				if (!f.startsWith(SESSION_ID)) return false;
				const c = fs.readFileSync(path.join(tagsDir, f), "utf8");
				return c.split("\n").some(l => l.trim() && !l.includes('"_hb"') && !l.includes('"_meta"'));
			});
		} catch { return false; }
	}, 10_000, 250);
	assert("waiting daemon classified the late-written session", gotData);
	assert("still the same daemon (no second spawn)", readPid(pidPath) === pidBefore, `before=${pidBefore} after=${readPid(pidPath)}`);

	let out = "", code = 0;
	try {
		out = execSync(`${SCRIPT} -s '${sessionPath}' -l 5 --no-emoji 2>&1`, { encoding: "utf8", timeout: 15_000 });
	} catch (err: any) {
		out = `${err.stdout || ""}${err.stderr || ""}`;
		code = err.status ?? 1;
	}
	assert("second run exits 0", code === 0, stripAnsi(out).trim());
	assert("second run renders bars", /[█░▒▓]/.test(out) || /\$\d/.test(stripAnsi(out)), stripAnsi(out).trim());
}

// ---
// 3. --watch on an absent path: waits on state, renders when the file appears.
// ---
console.log("\n3. --watch, session .jsonl not written yet");
{
	const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308w-"));
	const SESSION_ID_2 = "308c0de0-1a9b-4c3d-9e8f-000000000309";
	const sessionPath2 = path.join(dir2, `${SESSION_ID_2}.jsonl`);
	const pidPath2 = getDaemonPidPath(sessionPath2);
	try { fs.unlinkSync(pidPath2); } catch {}

	let output = "";
	let exitCode: number | null = null;
	const s = spawn("script", ["-q", "-c", `${SCRIPT} --watch -s '${sessionPath2}' -l 5 --no-emoji 2>&1`, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
	s.stdout.on("data", (d: Buffer) => { output += d.toString(); });
	s.stderr.on("data", (d: Buffer) => { output += d.toString(); });
	s.on("exit", (code) => { exitCode = code; });

	// Past the old 5 s clock: still running, still waiting, no failure copy.
	const waiting = await pollUntil(() => /waiting for session/i.test(stripAnsi(output)), 4_000);
	assert("renders a waiting line while the session is absent", waiting, stripAnsi(output).slice(-400));
	await pollUntil(() => exitCode !== null, 6_500); // deliberately outlast the retired 5 s ceiling
	assert("still running after 6.5 s (no clock-out)", exitCode === null, `exit=${exitCode} ${stripAnsi(output).slice(-400)}`);
	assert("no 'not found' / 'did not create' failure copy", !hasForbidden(output) && !/did not create/i.test(output), stripAnsi(output).slice(-400));

	fs.writeFileSync(sessionPath2, sessionLines());
	const charted = await pollUntil(() => /[█░▒▓]/.test(output), 15_000, 250);
	assert("chart renders once the session is written", charted, stripAnsi(output).slice(-600));

	s.stdin.write("q");
	const exited = await pollUntil(() => exitCode !== null, 5_000);
	if (!exited) s.kill();
	assert("'q' exits 0", exitCode === 0, `exit=${exitCode}`);

	const pid2 = readPid(pidPath2);
	if (pid2 > 0) { try { process.kill(pid2, "SIGTERM"); } catch {} }
	try { fs.unlinkSync(pidPath2); } catch {}
	try { fs.rmSync(dir2, { recursive: true, force: true }); } catch {}
}

// ---
// 4. Reaper: "not written yet" is not "gone"; "was written, now removed" still is.
// ---
console.log("\n4. Startup reaper distinguishes never-written from removed");
{
	const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
	const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308r-"));
	const pathA = path.join(dirA, "308c0de0-1a9b-4c3d-9e8f-00000000030a.jsonl"); // never written
	const pathB = path.join(dirA, "308c0de0-1a9b-4c3d-9e8f-00000000030b.jsonl"); // written, then removed
	const pathC = path.join(dirA, "308c0de0-1a9b-4c3d-9e8f-00000000030c.jsonl"); // the newcomer whose startup reaps
	const pids: number[] = [];
	const spawnDaemon = (p: string) => {
		const c = spawn(process.execPath, [DAEMON, "--session", p], { detached: true, stdio: "ignore" });
		c.unref();
		if (c.pid) pids.push(c.pid);
		return c;
	};
	const leaseOf = (p: string) => readPid(getDaemonPidPath(p));

	const a = spawnDaemon(pathA);
	fs.writeFileSync(pathB, sessionLines());
	const b = spawnDaemon(pathB);
	assert("A (never-written) claims its lease", await pollUntil(() => leaseOf(pathA) > 0 && isAlive(leaseOf(pathA)), 5_000));
	assert("B (written) claims its lease", await pollUntil(() => leaseOf(pathB) > 0 && isAlive(leaseOf(pathB)), 5_000));
	// B must have parsed something — that is the "session existed" evidence the reaper reads.
	const tagsDir = path.join(dirA, "wtft-tags");
	assert("B classified its session", await pollUntil(() => {
		try {
			return fs.readdirSync(tagsDir).some(f => f.startsWith(path.basename(pathB)) &&
				fs.readFileSync(path.join(tagsDir, f), "utf8").split("\n").some(l => l.trim() && !l.includes('"_hb"') && !l.includes('"_meta"')));
		} catch { return false; }
	}, 10_000, 250));
	fs.unlinkSync(pathB); // B's session is now genuinely gone
	const pidA = leaseOf(pathA), pidB = leaseOf(pathB);

	// Newcomer C: its startup reapAndWarn() sweeps every lease.
	fs.writeFileSync(pathC, sessionLines());
	spawnDaemon(pathC);
	assert("C claims its lease (its startup reap ran)", await pollUntil(() => leaseOf(pathC) > 0 && isAlive(leaseOf(pathC)), 5_000));
	const bGone = await pollUntil(() => !isAlive(pidB), 5_000);
	assert("B (session removed) was reaped", bGone, `pidB=${pidB}`);
	assert("A (session never written) survived the reap", isAlive(pidA) && leaseOf(pathA) === pidA, `pidA=${pidA} lease=${leaseOf(pathA)}`);
	assert("A's own exit code is still open (it did not SIGTERM itself)", a.exitCode === null && a.signalCode === null, `exit=${a.exitCode} sig=${a.signalCode}`);
	void b;

	for (const p of [pathA, pathB, pathC]) { const pid = leaseOf(p); if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } try { fs.unlinkSync(getDaemonPidPath(p)); } catch {} }
	for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	try { fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
