/**
 * #270 / #420 — the benchmark behind the "MEASURED, not assumed" block in
 * bin/wtft-daemon.ts.
 *
 * WHY this exists as a committed script: the original figures were produced by
 * an ad-hoc run that was never saved, so nobody could re-derive them — and a
 * PR review then caught that they did not reconcile with each other (a "max
 * per file" in milliseconds sitting beside a "largest file" in bytes as if the
 * two were the same transcript, and an interaction count with no antecedent).
 * Numbers that justify an "this is affordable" claim have to be reproducible
 * or they are decoration. Run this, paste the SUMMARY block.
 *
 * It mirrors the daemon's per-file work exactly (bin/wtft-daemon.ts, the
 * subagent re-parse loop): parseSessionFile → deduplicateInteractions →
 * serializeClassified → sha1 per line.
 *
 * Usage:  bun research/270-subagent-parse-bench.ts [--json]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { parseSessionFile, deduplicateInteractions, discoverSubagentSessionFiles } from "../extensions/lib/wtft-parser";
import { serializeClassified } from "../extensions/lib/wtft-daemon-lib";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

function allTranscripts(root: string, out: string[] = []): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = path.join(root, e.name);
		if (e.isDirectory()) allTranscripts(full, out);
		else if (e.name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

interface Row {
	file: string;
	bytes: number;
	ms: number;
	hashMs: number;
	interactions: number;
	lineBytes: number;
	hashBytes: number;
}

// SUBAGENT transcripts only — the population the daemon actually re-parses.
// A naive walk of ~/.claude/projects also sweeps up wtft's own tag files
// (`*.wtft-tag.*.jsonl`, one of which is 32MB here) and every main-session
// transcript, none of which this loop ever touches. Discovery uses the daemon's
// own predicate rather than a filename guess.
const sessionFiles = allTranscripts(PROJECTS).filter((f) => !f.includes(".wtft-tag."));
const files = [...new Set(sessionFiles.flatMap((f) => discoverSubagentSessionFiles(f)))];
const rows: Row[] = [];
// Files that fail stat or parse are excluded from `rows` — surface that count
// (PR review) instead of letting `rows.length` present the surviving
// population as if it were the full one, which would undercut the "MEASURED,
// not assumed" claim this script exists to back.
let skipped = 0;

for (const file of files) {
	let bytes: number;
	try {
		bytes = fs.statSync(file).size;
	} catch {
		skipped++;
		continue;
	}
	const t0 = performance.now();
	let deduped;
	try {
		deduped = deduplicateInteractions(parseSessionFile(file));
	} catch {
		skipped++;
		continue;
	}
	let lineBytes = 0;
	let hashBytes = 0;
	let hashMs = 0;
	for (const si of deduped) {
		const line = serializeClassified(si);
		lineBytes += Buffer.byteLength(line);
		const h0 = performance.now();
		const hash = createHash("sha1").update(line).digest("hex");
		hashMs += performance.now() - h0;
		hashBytes += Buffer.byteLength(hash);
	}
	rows.push({
		file,
		bytes,
		ms: performance.now() - t0,
		hashMs,
		interactions: deduped.length,
		lineBytes,
		hashBytes,
	});
}

const pct = (arr: number[], p: number): number =>
	arr.length === 0 ? 0 : [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))];

const times = rows.map((r) => r.ms);
const sizes = rows.map((r) => r.bytes);
const total = times.reduce((a, b) => a + b, 0);
const slowest = rows.reduce((a, b) => (b.ms > a.ms ? b : a), rows[0]);
const largest = rows.reduce((a, b) => (b.bytes > a.bytes ? b : a), rows[0]);
const interactions = rows.reduce((a, r) => a + r.interactions, 0);
const lineBytes = rows.reduce((a, r) => a + r.lineBytes, 0);
const hashBytes = rows.reduce((a, r) => a + r.hashBytes, 0);
const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)}MB`;

if (process.argv.includes("--json")) {
	console.log(
		JSON.stringify(
			{
				schema: "wtft-subagent-parse-bench/run@1",
				files: rows.length,
				filesSkipped: skipped,
				medianBytes: pct(sizes, 0.5),
				maxBytes: largest?.bytes ?? 0,
				medianMs: pct(times, 0.5),
				p90Ms: pct(times, 0.9),
				maxMs: slowest?.ms ?? 0,
				totalMs: total,
				interactions,
				lineBytes,
				hashBytes,
				slowest: slowest && { file: path.basename(slowest.file), bytes: slowest.bytes, ms: slowest.ms, hashMs: slowest.hashMs },
				largest: largest && { file: path.basename(largest.file), bytes: largest.bytes, ms: largest.ms, hashMs: largest.hashMs },
			},
			null,
			2,
		),
	);
} else {
	console.log("--- SUMMARY (paste into bin/wtft-daemon.ts) ---");
	console.log(`files:        ${rows.length} (median ${kb(pct(sizes, 0.5))} / max ${mb(largest?.bytes ?? 0)})${skipped > 0 ? ` — ${skipped} skipped (stat/parse failure)` : ""}`);
	console.log(`per file:     ${pct(times, 0.5).toFixed(2)}ms median, ${pct(times, 0.9).toFixed(2)}ms p90, ${(slowest?.ms ?? 0).toFixed(2)}ms max`);
	console.log(`all at once:  ${total.toFixed(1)}ms across ${interactions} interactions`);
	console.log(`hash vs line: ${kb(hashBytes)} vs ${mb(lineBytes)}`);
	console.log(`slowest file: ${path.basename(slowest?.file ?? "")} — ${mb(slowest?.bytes ?? 0)}, ${(slowest?.ms ?? 0).toFixed(2)}ms, hashing ${(slowest?.hashMs ?? 0).toFixed(2)}ms`);
	console.log(`largest file: ${path.basename(largest?.file ?? "")} — ${mb(largest?.bytes ?? 0)}, ${(largest?.ms ?? 0).toFixed(2)}ms, hashing ${(largest?.hashMs ?? 0).toFixed(2)}ms`);
	console.log(`same file?    ${slowest?.file === largest?.file ? "YES" : "NO — slowest and largest are different transcripts"}`);
}
