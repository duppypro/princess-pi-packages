#!/usr/bin/env -S npx tsx
/**
 * @package princess-pi-packages
 * @research #52 sub-turn cost attribution experiment
 * @description Runs three costing strategies over real sessions and prints
 *   per-category $ tables side by side:
 *     baseline — production latest-stage-wins, whole message → one category
 *     assay    — Assay-Grade (minimalist): split only meter-proven slices
 *                (recache + compaction signatures → overhead buckets; output
 *                by char share with prompt carve); cache_read stays whole
 *     ledger   — Causal/Context Ledger (synthesis of three ledger proposals):
 *                cache_read as rent on ledger composition, cache_write as
 *                deposits, output by block shares, overhead + residual honest
 *
 *   Every strategy conserves cost exactly: per-message meter splits are
 *   normalized to the message's real cost, so all three tables sum to the
 *   same session total.
 */

import { extractSession, type MessageFeatures } from "./extract-features.ts";
import { lookupModelPricing } from "../../extensions/lib/wtft-cost.ts";
import type { Category } from "../../extensions/lib/wtft-parser.ts";

type Vec = Partial<Record<string, number>>;

const add = (v: Vec, k: string, x: number) => { if (x > 0) v[k] = (v[k] || 0) + x; };
const sum = (v: Vec) => Object.values(v).reduce((s, x) => s + (x || 0), 0);

// ---
// Per-meter $ decomposition for one message, normalized to its real cost.
// Rates come from the pricing registry; unknown models fall back to Anthropic
// rate RATIOS (in 1 : out 5 : cacheRead 0.1 : cacheWrite 1.25) — only the
// ratios matter because the vector is rescaled to interaction cost anyway.
// ---
function meterDollars(f: MessageFeatures): { input: number; output: number; cacheRead: number; cacheWrite: number } {
	let r: any = null;
	try { r = f.model ? lookupModelPricing(f.model) : null; } catch {}
	const rates = r
		? { input: r.input ?? 1, output: r.output ?? 5, cacheRead: r.cacheRead ?? 0.1, cacheWrite: r.cacheWrite ?? 1.25 }
		: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
	const raw = {
		input: f.meters.input * rates.input,
		output: f.meters.output * rates.output,
		cacheRead: f.meters.cacheRead * rates.cacheRead,
		cacheWrite: f.meters.cacheWrite * rates.cacheWrite,
	};
	const rawSum = raw.input + raw.output + raw.cacheRead + raw.cacheWrite;
	const scale = rawSum > 0 ? f.cost / rawSum : 0;
	return {
		input: raw.input * scale, output: raw.output * scale,
		cacheRead: raw.cacheRead * scale, cacheWrite: raw.cacheWrite * scale,
	};
}

/** Char shares of a message's blocks by category (tool_use → its category,
 *  text/thinking → prompt). Returns null when nothing has chars. */
function outputShares(f: MessageFeatures): Vec | null {
	const shares: Vec = {};
	let total = 0;
	for (const b of f.blocks) {
		const cat = b.kind === "tool_use" ? b.category : "prompt";
		add(shares, cat, b.chars);
		total += b.chars;
	}
	if (total === 0) return null;
	for (const k of Object.keys(shares)) shares[k]! /= total;
	return shares;
}

// ---
// STRATEGY 1: baseline — production behavior, all-or-nothing.
// ---
function runBaseline(features: MessageFeatures[]): Vec {
	const out: Vec = {};
	for (const f of features) add(out, f.baselineCategory, f.cost);
	return out;
}

// ---
// STRATEGY 2: assay — split only what the meters prove (minimalist proposal).
// ---
function runAssay(features: MessageFeatures[]): Vec {
	const out: Vec = {};
	let prevCtx = 0; // input + cacheRead + cacheWrite of previous main-chain message

	for (const f of features) {
		const $ = meterDollars(f);
		const ctx = f.meters.input + f.meters.cacheRead + f.meters.cacheWrite;

		// cache_write: compaction / recache signatures → overhead buckets (T1 exact)
		if (f.afterCompaction) {
			add(out, "compaction", $.cacheWrite);
		} else if (
			f.meters.cacheWrite > 30_000 &&
			f.e1h === f.meters.cacheWrite &&
			f.meters.input <= 16 &&
			f.meters.cacheRead < 0.2 * (f.meters.cacheRead + f.meters.cacheWrite) &&
			prevCtx > 0 && Math.abs(ctx - prevCtx) < 0.15 * prevCtx &&
			f.iterations <= 1
		) {
			add(out, "recache", $.cacheWrite);
		} else {
			add(out, f.baselineCategory, $.cacheWrite);
		}

		// output: char split with redaction guard (T2)
		const shares = outputShares(f);
		const visibleChars = f.blocks.reduce((s, b) => s + b.chars, 0);
		if (!shares || visibleChars / 4 < 0.5 * f.meters.output * 0 + 0) {
			// no blocks with chars — whole meter to turn category
			add(out, f.baselineCategory, $.output);
		} else if (visibleChars / 4 < 0.5 * f.meters.output && f.meters.output > 200) {
			// redaction guard: billed output not present in log (hidden thinking) → T0
			add(out, f.baselineCategory, $.output);
		} else {
			for (const [k, s] of Object.entries(shares)) add(out, k, $.output * (s || 0));
		}

		// cache_read + input: never split (T0)
		add(out, f.baselineCategory, $.cacheRead + $.input);

		if (!f.isSidechain) prevCtx = ctx;
	}
	return out;
}

// ---
// STRATEGY 3: ledger — rent-on-deposits (synthesis of causal/context/char ledgers).
//   H: resident-context composition per category (tokens).
//   pending: material that entered context since last assistant message.
//   overhead: first-call prefix (system prompt/tool schemas/CLAUDE.md).
// ---
function runLedger(features: MessageFeatures[]): Vec {
	const out: Vec = {};
	const H: Vec = {};
	let first = true;
	let prevOutVec: Vec | null = null; // previous message's output token vector

	for (const f of features) {
		const $ = meterDollars(f);

		// Build pending vector (tokens ≈ chars/4) from prev output + incoming results/user text
		const pending: Vec = {};
		if (prevOutVec) for (const [k, v] of Object.entries(prevOutVec)) add(pending, k, v || 0);
		for (const r of f.incomingResults) add(pending, r.category, r.chars / 4);

		// Bootstrap: first call's context is the harness prefix
		if (first) {
			add(H, "overhead", f.meters.cacheRead + (f.meters.cacheWrite || 0) || f.meters.input);
			first = false;
		}

		// Compaction: wipe ledger; summary deposit belongs to compaction
		if (f.afterCompaction) {
			for (const k of Object.keys(H)) delete H[k];
			add(H, "compaction", f.meters.cacheWrite);
			add(H, "overhead", f.meters.cacheRead);
			add(out, "compaction", $.cacheWrite);
		} else {
			// cache_write: deposits. Split by pending; excess beyond 2×pending is
			// history re-entering cache → split by H (rebuild case).
			const P = sum(pending);
			const cw = f.meters.cacheWrite;
			const cwVec: Vec = {};
			if (cw > 0) {
				if (P > 0 && cw <= 2 * P) {
					for (const [k, v] of Object.entries(pending)) add(cwVec, k, (cw * (v || 0)) / P);
				} else if (P > 0) {
					for (const [k, v] of Object.entries(pending)) add(cwVec, k, v || 0);
					const excess = cw - P;
					const hSum = sum(H);
					if (hSum > 0) for (const [k, v] of Object.entries(H)) add(cwVec, k, (excess * (v || 0)) / hSum);
					else add(cwVec, "other", excess);
				} else {
					const hSum = sum(H);
					if (hSum > 0) for (const [k, v] of Object.entries(H)) add(cwVec, k, (cw * (v || 0)) / hSum);
					else add(cwVec, "other", cw);
				}
				const cwSum = sum(cwVec);
				for (const [k, v] of Object.entries(cwVec)) {
					add(out, k, $.cacheWrite * ((v || 0) / cwSum));
					add(H, k, v || 0);
				}
			} else if (P > 0) {
				// Implicit-caching providers (Pi/gemini: cacheWrite always 0) —
				// pending material still enters the resident context and must
				// deposit into H, or the bootstrap prefix collects all rent forever.
				for (const [k, v] of Object.entries(pending)) add(H, k, v || 0);
			}
		}

		// cache_read: rent split by resident composition
		const hSum = sum(H);
		if (hSum > 0) for (const [k, v] of Object.entries(H)) add(out, k, ($.cacheRead + $.input) * ((v || 0) / hSum));
		else add(out, f.baselineCategory, $.cacheRead + $.input);

		// output: block char shares (hidden thinking rides pro-rata via normalization)
		const shares = outputShares(f);
		if (shares) for (const [k, s] of Object.entries(shares)) add(out, k, $.output * (s || 0));
		else add(out, f.baselineCategory, $.output);

		// carry this message's output vector into next pending
		prevOutVec = {};
		if (shares) for (const [k, s] of Object.entries(shares)) add(prevOutVec, k, f.meters.output * (s || 0));
		else add(prevOutVec, f.baselineCategory, f.meters.output);
	}
	return out;
}

// ---
// Comparison table
// ---
const CATS = [
	"plan", "spec", "research", "web", "grep", "code", "tests", "git", "agents",
	"prompt", "compaction", "interrupted", "recache", "overhead", "other",
];

async function main() {
	const sessions = process.argv.slice(2);
	if (sessions.length === 0) {
		console.error("usage: run-comparison.ts <session.jsonl> [...]");
		process.exit(1);
	}
	for (const s of sessions) {
		const features = await extractSession(s);
		const results = {
			baseline: runBaseline(features),
			assay: runAssay(features),
			ledger: runLedger(features),
		};
		const total = sum(results.baseline);
		console.log(`\n== ${s.split("/").pop()}  (${features.length} msgs, $${total.toFixed(2)})`);
		console.log("category      baseline        assay         ledger");
		for (const c of CATS) {
			const row = [results.baseline[c] || 0, results.assay[c] || 0, results.ledger[c] || 0];
			if (row.every(x => x < 0.005)) continue;
			const fmt = (x: number) => `$${x.toFixed(2)} ${String((100 * x / total).toFixed(1)).padStart(5)}%`.padStart(14);
			console.log(c.padEnd(12) + row.map(fmt).join(" "));
		}
		const totals = [sum(results.baseline), sum(results.assay), sum(results.ledger)];
		console.log("TOTAL       " + totals.map(t => `$${t.toFixed(2)}`.padStart(14)).join(" ") + "   (conservation check)");
	}
}

await main();
