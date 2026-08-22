#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-270-subagent-state-eviction
 * @description #270 review (Low/contract, bin/wtft-daemon.ts) —
 *   discoveredSubagentFiles gained an entry for every subagent transcript ever
 *   discovered and never dropped one, unlike the bounded, self-clearing
 *   pendingClaudeCommands beside it.
 *
 *   Only ONE eviction rule is safe, and it is not "the subagent finished".
 *   discoverSubagentSessionFiles re-lists every transcript on disk every poll,
 *   so a finished subagent is re-discovered on the very next poll: evicting on
 *   quiet would re-read it from offset 0 forever, appending the whole transcript
 *   again each time. Entries whose FILE IS GONE cannot be re-discovered, so
 *   those are the ones that can go — and their offset is meaningless anyway,
 *   because a file that reappears under the same name is a new file that must be
 *   read from zero.
 *
 *   Closer: delete a subagent transcript the daemon has read, recreate it LARGER
 *   under the same name, and the daemon reads the new file from byte zero — the
 *   first turn of the replacement is counted. A retained stale offset would skip
 *   past it into the middle of a line.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
	getDaemonPidPath,
	readClassifiedTagFile,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const cleanupPids: number[] = [];
const cleanupPidFiles: string[] = [];
const fixtureDirs: string[] = [];

function turnLine(id: string, tsMs: number, outputTokens: number, padding = ""): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: new Date(tsMs).toISOString(),
			usage: {
				input_tokens: 5000,
				output_tokens: outputTokens,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			content: [{ type: "text", text: `turn ${id}${padding}` }],
		},
	}) + "\n";
}

console.log("wtft daemon subagent state eviction (#270 review)");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-evict-"));
fixtureDirs.push(dir);

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-evict", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");
const tagsDir = path.join(dir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
cleanupPidFiles.push(getDaemonPidPath(sessionPath));

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const goneAgentPath = path.join(subagentDir, "agent-evict-gone.jsonl");
// A second subagent that never goes away — proves eviction is targeted, not a
// wholesale clear that would re-read every live transcript from zero.
const stayAgentPath = path.join(subagentDir, "agent-evict-stays.jsonl");

const T0 = Date.now() - 60_000;
const FIRST_ID = "msg_270_evict_first";
const REPLACEMENT_ID = "msg_270_evict_replacement";
const STAYS_ID = "msg_270_evict_stays";

fs.writeFileSync(goneAgentPath, turnLine(FIRST_ID, T0, 200));
fs.writeFileSync(stayAgentPath, turnLine(STAYS_ID, T0, 100));

const tagPath = path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

function rawTagLinesFor(messageId: string): number {
	try {
		return fs.readFileSync(tagPath, "utf8").split("\n")
			.filter(l => l.trim() && (() => { try { return JSON.parse(l).id === messageId; } catch { return false; } })())
			.length;
	} catch { return 0; }
}

try {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: "ignore",
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);

	let sawFirst = false;
	for (let i = 0; i < 24 && !sawFirst; i++) {
		await sleep(250);
		const ids = readClassifiedTagFile(tagPath).map((int: any) => int.messageId);
		sawFirst = ids.includes(FIRST_ID) && ids.includes(STAYS_ID);
	}
	assert("daemon reads both subagent transcripts", sawFirst);

	// The transcript disappears. Give the daemon polls to notice.
	fs.unlinkSync(goneAgentPath);
	await sleep(2000);

	// A NEW transcript appears under the same name, LARGER than the old one — so
	// a retained offset would not look like truncation and would not self-heal.
	fs.writeFileSync(goneAgentPath,
		turnLine(REPLACEMENT_ID, T0 + 5_000, 300, "y".repeat(4096)));

	let sawReplacement = false;
	for (let i = 0; i < 24 && !sawReplacement; i++) {
		await sleep(250);
		sawReplacement = readClassifiedTagFile(tagPath).some((int: any) => int.messageId === REPLACEMENT_ID);
	}
	assert("a transcript that vanished and came back is read from byte zero", sawReplacement);

	// The surviving subagent must not have been re-read from zero as collateral —
	// that would put a second raw line for the same turn in the tag file.
	assert(
		`the still-present transcript is not re-read from zero (${rawTagLinesFor(STAYS_ID)} raw line(s))`,
		rawTagLinesFor(STAYS_ID) === 1
	);
} finally {
	for (const pid of cleanupPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
	await sleep(200);
	for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);
