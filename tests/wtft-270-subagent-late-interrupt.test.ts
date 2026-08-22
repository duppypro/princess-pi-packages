#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-270-subagent-late-interrupt
 * @description #270 review (Low/correctness, bin/wtft-daemon.ts) — the
 *   `interrupted` stamp was lost for a subagent turn whose interrupt marker
 *   arrived in a LATER poll than the turn it killed.
 *
 *   The parent path handles this: parseNewLines' onInterrupt falls back to
 *   `stampInterruptOnPending = true` because the killed turn may still be
 *   sitting unflushed in pendingItems. readNewSubagentLines' callback had no
 *   `else` at all, and subagent interactions are appended immediately, so a
 *   marker landing one poll later found the turn already written and immutable.
 *   `ir` was dropped for good, and an interrupted turn's whole cost is
 *   discarded work (#52 Phase 3) — reporting it as productive is a real error.
 *
 *   Closer: append ONLY an interrupt marker to a subagent transcript, a poll
 *   after the turn it kills was already written to the tag file; that turn
 *   reads back with interrupted === true, still as ONE interaction, at
 *   unchanged cost.
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

function turnLine(id: string, tsMs: number, inputTokens: number, outputTokens: number): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: new Date(tsMs).toISOString(),
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			content: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

/** The Claude Code user interrupt marker — a control entry, so it yields no
 *  interaction of its own and arrives in a batch that may be otherwise empty. */
function interruptMarkerLine(tsMs: number): string {
	return JSON.stringify({
		type: "user",
		timestamp: new Date(tsMs).toISOString(),
		message: { role: "user", content: "[Request interrupted by user]" },
	}) + "\n";
}

console.log("wtft daemon subagent late interrupt marker (#270 review)");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-interrupt-"));
fixtureDirs.push(dir);

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-interrupt", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");
const tagsDir = path.join(dir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
cleanupPidFiles.push(getDaemonPidPath(sessionPath));

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-interrupt1.jsonl");

const T0 = Date.now() - 60_000;
const KILLED_ID = "msg_270_killed_turn";

fs.writeFileSync(subagentPath, turnLine(KILLED_ID, T0, 5000, 200));

const tagPath = path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

try {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: "ignore",
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);

	// Poll window N: the turn is read and appended to the tag file, un-interrupted.
	let written: any[] = [];
	for (let i = 0; i < 24 && written.length === 0; i++) {
		await sleep(250);
		written = readClassifiedTagFile(tagPath).filter((int: any) => int.messageId === KILLED_ID);
	}
	assert("daemon writes the subagent turn before the marker arrives", written.length === 1);
	const costBefore = written.reduce((s: number, i: any) => s + i.cost, 0);
	assert("the turn is not yet flagged interrupted", written[0]?.interrupted !== true);

	// Poll window N+1: ONLY the interrupt marker. No new interaction rides with it.
	fs.appendFileSync(subagentPath, interruptMarkerLine(T0 + 3_000));

	let stamped = false;
	for (let i = 0; i < 24 && !stamped; i++) {
		await sleep(250);
		stamped = readClassifiedTagFile(tagPath)
			.some((int: any) => int.messageId === KILLED_ID && int.interrupted === true);
	}
	assert("a marker arriving a poll later still stamps the turn it killed", stamped);

	const after = readClassifiedTagFile(tagPath).filter((int: any) => int.messageId === KILLED_ID);
	assert(`the stamp does not duplicate the turn (${after.length} === 1)`, after.length === 1);
	const costAfter = after.reduce((s: number, i: any) => s + i.cost, 0);
	assert(
		`the stamp does not change the cost (\$${costAfter.toFixed(6)} === \$${costBefore.toFixed(6)})`,
		Math.abs(costAfter - costBefore) < 0.000001
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
