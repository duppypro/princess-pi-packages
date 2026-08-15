// ---
// research/149-cost-scope/256-negative-step.mjs — dissect the one downward residual step (#256)
//
// #256 reports a single -$0.27 step in session d8e0363d on 2026-08-11, and stops
// at the measurement because the data did not pick between two explanations:
//   1. Claude Code's `total_cost_usd` LAGS the transcript record the status line
//      was rendered with — a transient dip that recovers, no money lost.
//   2. `alignRecords` DEFERS a burst of interactions onto one aligned record, so
//      wtft's prefix sum jumps while Claude's counter does not.
//
// The two make different predictions, which is what this script tests:
//   - lag predicts the NEXT aligned record recovers the dip with FEW OR NO new
//     interactions in between (Claude catching up on work already priced);
//   - deferral predicts the dip coincides with a JUMP IN ALIGNED INTERACTION
//     INDEX (several interactions collapsing onto one record), and the recovery
//     needs new interactions to arrive.
//
// Usage: bun research/149-cost-scope/256-negative-step.mjs [sessionId]
// ---

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	readStatusLog,
	loadWtftInteractions,
	alignRecords,
} from "./paired-window-audit.mjs";

const LOG_DIR = path.join(os.homedir(), ".claude", "statusline-logs");
const MIN_STEP = 0.01;
const usd = (n) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(6)}`;

/** Aligned rows with the residual R and its delta, exactly as residualStaircase computes them. */
function rows(sessionId) {
	const records = readStatusLog(LOG_DIR, sessionId);
	if (records.length < 2) return null;
	const transcriptPath = records[0]?.transcript_path;
	if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

	const interactions = loadWtftInteractions(transcriptPath);
	const aligned = alignRecords(records, interactions);
	if (aligned.length < 2) return null;

	const a0 = aligned[0];
	let prevR = 0;
	let prevIdx = a0.index;
	return {
		interactions,
		rows: aligned.map((a) => {
			const R =
				a.record.cost.total_cost_usd -
				a0.record.cost.total_cost_usd -
				(a.wtftCum - a0.wtftCum);
			const row = {
				ts: a.record._ts,
				claudeCum: a.record.cost.total_cost_usd,
				wtftCum: a.wtftCum,
				R,
				dR: R - prevR,
				index: a.index,
				spanned: a.index - prevIdx,
			};
			prevR = R;
			prevIdx = a.index;
			return row;
		}),
	};
}

const argv = process.argv.slice(2);
const sessions = argv.length
	? argv
	: fs
			.readdirSync(LOG_DIR)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => f.replace(/\.jsonl$/, ""));

let found = 0;
for (const id of sessions) {
	let r;
	try {
		r = rows(id);
	} catch {
		continue;
	}
	if (!r) continue;

	const dips = r.rows.map((row, i) => ({ row, i })).filter(({ row }) => row.dR <= -MIN_STEP);
	if (dips.length === 0) continue;
	found++;

	console.log(`\n=== ${id} — ${dips.length} downward step(s), ${r.rows.length} aligned rows ===`);
	for (const { i } of dips) {
		// Two rows either side: the dip itself, what preceded it, and — the
		// discriminating part — how the residual behaves immediately after.
		const from = Math.max(0, i - 2);
		const to = Math.min(r.rows.length - 1, i + 3);
		console.log(`\n  window rows ${from}..${to} (dip at ${i}):`);
		console.log("    row  ts                    claudeCum   wtftCum       R           dR          idx  spanned");
		for (let k = from; k <= to; k++) {
			const w = r.rows[k];
			console.log(
				`    ${String(k).padStart(3)}  ${w.ts}  ${w.claudeCum.toFixed(6).padStart(9)}  ${w.wtftCum
					.toFixed(6)
					.padStart(9)}  ${usd(w.R).padStart(11)}  ${usd(w.dR).padStart(11)}  ${String(w.index).padStart(4)}  ${String(
					w.spanned,
				).padStart(7)}${k === i ? "   <-- DIP" : ""}`,
			);
		}

		const dip = r.rows[i];
		// Recovery: how many aligned rows, and how many INTERACTIONS, until R is
		// back at or above its pre-dip level. Lag recovers in few interactions.
		const before = r.rows[i - 1]?.R ?? 0;
		let recoveredAt = -1;
		let interactionsToRecover = 0;
		for (let k = i + 1; k < r.rows.length; k++) {
			if (r.rows[k].R >= before - 1e-9) {
				recoveredAt = k;
				interactionsToRecover = r.rows[k].index - dip.index;
				break;
			}
		}
		console.log(
			`\n    pre-dip R=${usd(before)}  dip R=${usd(dip.R)}  drop=${usd(dip.dR)}  interactions collapsed onto the dip row: ${dip.spanned}`,
		);
		console.log(
			recoveredAt < 0
				? "    NEVER recovers to the pre-dip residual in this session"
				: `    recovers at row ${recoveredAt} (+${recoveredAt - i} rows, +${interactionsToRecover} interactions)`,
		);

		// The interactions the dip row collapsed, priced individually. If one
		// of them dominates the drop, deferral is the mechanism; if the drop is
		// unrelated to their sizes, lag is.
		const lo = (r.rows[i - 1]?.index ?? -1) + 1;
		const hi = dip.index;
		console.log(`    interactions ${lo}..${hi} collapsed onto this row:`);
		for (let j = lo; j <= hi && j < r.interactions.length; j++) {
			const it = r.interactions[j];
			console.log(
				`      [${String(j).padStart(3)}] ${new Date(it.timestamp).toISOString()} ${String(it.model ?? "?").padEnd(18)} in=${String(
					it.inputTokens,
				).padStart(6)} out=${String(it.outputTokens).padStart(6)} cw=${String(it.cacheWriteTokens).padStart(7)} cr=${String(
					it.cacheReadTokens,
				).padStart(7)} usd=${(it.cost + (it.serverToolCost || 0)).toFixed(6)}`,
			);
		}
	}
}

if (found === 0) console.log("no downward steps on any logged session");
