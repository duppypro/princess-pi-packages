#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-270-session-summary-dedup
 * @description #270 review round 2 (Medium/contract, extensions/lib/session-selector.ts) —
 *   getSessionSummary() reimplements "collapse tag-file lines by message.id, keep max
 *   cost" by hand instead of calling the shared `dedupeClassifiedById`
 *   (extensions/lib/wtft-daemon-lib.ts), because session-selector.ts is a standalone
 *   module that deliberately does not import the daemon's internals (see the
 *   CONSTANTS comment at the top of session-selector.ts). Two independent
 *   implementations of the same rule with nothing pinning them together is exactly
 *   how they drift apart — this test is that pin.
 *
 *   Closer: over a synthetic tag file whose message.id "msg-A" is re-emitted at a
 *   higher cost in a later line (the growing-usage shape #270 exists to collapse),
 *   getSessionSummary()'s cost/turns must equal the cost/turns independently derived
 *   from readClassifiedTagFile() + dedupeClassifiedById() — the canonical collapse —
 *   over the same file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionSummary } from "../extensions/lib/session-selector.ts";
import { readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";
import { mkSandbox } from "./lib/sandbox";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}

const sandbox = mkSandbox(path.join(require("node:os").tmpdir(), "wtft-270-summary-dedup-"));
const sessionDir = sandbox;
const sessionBase = "session-summary-dedup-test.jsonl";
const sessionPath = path.join(sessionDir, sessionBase);
fs.writeFileSync(sessionPath, ""); // Tier-3 fallback only reads this if no tag file matches — unused here.

const tagsDir = path.join(sessionDir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
// Deliberately NOT session-selector's mirrored TAGGER_VERSION constant — an
// arbitrary version exercises the same Tier-2 "scan for any matching tag file"
// path getSessionSummary uses in practice, and keeps this test from silently
// going stale if that mirrored constant is ever corrected or bumped.
const tagPath = path.join(tagsDir, `${sessionBase}.wtft-tag.v9.9.9.jsonl`);

const lines = [
	{ t: 1000, c: 0.01, id: "msg-A" }, // msg-A, first (low-cost, partial) emission
	{ t: 1001, c: 0.02, id: "msg-B" },
	{ t: 1002, c: 0.05, id: "msg-A" }, // msg-A re-emitted later, growing usage — higher cost
	{ t: 1003, c: 0.03 },              // no message.id at all
	{ _hb: true },                     // heartbeat — every reader skips this
];
fs.writeFileSync(tagPath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");

console.log("1. getSessionSummary agrees with the canonical readClassifiedTagFile+dedupeClassifiedById collapse");

const summary = getSessionSummary(sessionPath);
const canonical = readClassifiedTagFile(tagPath);
const canonicalCost = canonical.reduce((sum, i) => sum + i.cost, 0);
const canonicalTurns = canonical.length;

assert(`tagVersion resolved via Tier-2 scan (got ${summary.tagVersion})`, summary.tagVersion === "9.9.9");
assert(`msg-A collapsed to its max cost, not summed (cost=${summary.cost}, expected ${canonicalCost})`, Math.abs(summary.cost - canonicalCost) < 1e-9);
assert(`turns match the canonical collapse (turns=${summary.turns}, expected ${canonicalTurns})`, summary.turns === canonicalTurns);
assert(`exactly 3 distinct interactions after collapse (msg-A once, msg-B, no-id)`, canonicalTurns === 3);
assert(`cost is 0.10 — 0.05 (msg-A max) + 0.02 (msg-B) + 0.03 (no id), not 0.11 (summed)`, Math.abs(summary.cost - 0.10) < 1e-9);

console.log(failed === 0 ? `\n${GREEN}${passed} passed${RESET}` : `\n${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed === 0 ? 0 : 1);
