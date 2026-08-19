// --- #230: retired workflow vocabulary does not survive in live guidance ---
//
// Two doc sweeps (#212, then this one) found the same class of drift: a term that
// named a real thing, kept naming it in the docs after the thing was deleted, and
// was read in good faith by the next agent. `git-snap`/`git-ship` (replaced by
// `git-checkpoint`), `post-merge-cleanup` (replaced by `pr-cleanup`), the
// `merge-checklist` skill (never existed on disk), `bin/merge` and the Pi `/merge`
// command (deleted in #201 and #226), and "Step 5 of the 5-step flow" (the whole
// flow was replaced by the TDD + PR flow).
//
// A sweep fixes the instances. This suite is what stops the class, so a third
// sweep is not needed.
//
// THE EXEMPTION RULE, and why it is shaped this way. History is worth keeping —
// "`git-snap` was replaced by `git-checkpoint`" is the single most useful sentence
// for someone holding an old command. So a retired term is allowed exactly where
// the prose says it is retired:
//
//   1. the line itself carries a historical marker (retired / replaced / removed /
//      no longer / used to / until #N / deleted in #N), or
//   2. the nearest preceding heading does (a "What was removed" table), or
//   3. the file is a dated record — docs/spec-NNN-*.md, docs/adr/* — which is a
//      snapshot of what was true then and must not be rewritten.
//
// That is a rule about honesty rather than about vocabulary: you may name a dead
// tool, you may not imply it is alive. An explicit path allowlist exists too, but
// every entry needs a reason written next to it — the point is to make hiding a
// violation cost more than fixing it.
//
// Run with: bun run test workflow-docs-terms

import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

let failures = 0;
let checks = 0;

function check(cond: boolean, label: string, detail = ""): void {
	checks++;
	if (cond) {
		console.log(`  ✅ ${label}`);
	} else {
		console.error(`  ❌ ${label}${detail ? `\n     ${detail.split("\n").join("\n     ")}` : ""}`);
		failures++;
	}
}

/** Terms that named something real and no longer do. */
const RETIRED: Array<{ term: RegExp; label: string; now: string }> = [
	{ term: /\bgit-snap\b/, label: "git-snap", now: "git-checkpoint" },
	{ term: /\bgit-ship\b/, label: "git-ship", now: "git-checkpoint" },
	{ term: /\bpost-merge-cleanup\b/, label: "post-merge-cleanup", now: "pr-cleanup" },
	{ term: /\bmerge-checklist\b/, label: "merge-checklist", now: "nothing — the skill never existed and pr-open does not gate on it" },
	{ term: /\bMERGE_BLOCKED\b/, label: "MERGE_BLOCKED", now: "pr-open's real gh output" },
	{ term: /\b5-step flow\b|\b5-Step\b|\bfive-step flow\b/, label: "the 5-step flow", now: "the TDD + PR flow" },
	{ term: /\bStep 5\b/, label: "Step 5", now: '"Code & Spec Approved" / the spec-reconcile step' },
	{ term: /\bbin\/merge\b/, label: "bin/merge", now: "pr-open" },
	{ term: /(?<![\w/])\/merge\b/, label: "the Pi /merge command", now: "pr-open (ADR 0004)" },
];

/** A line, or the heading above it, admitting the term is history. */
const HISTORICAL =
	/retired|replaced|removed|deleted|no longer|used to|superseded|until #\d+|in #\d+|was the|formerly|legacy|historical|dead|gone|never existed|never shipped|once;/i;

/**
 * Paths exempt wholesale. Each needs a reason — an allowlist without one is how a
 * violation gets parked instead of fixed.
 */
const ALLOWLIST = new Map<string, string>([
	// Its own runbook has numbered steps; "Step 5 — verify, per repo" is step five of
	// THAT procedure and has nothing to do with the retired commit flow.
	["docs/repo-gate-apply.md", "numbered steps of its own unrelated procedure"],
]);

/** Live guidance: what a reader reaches for an answer about how we work today. */
function liveGuidance(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			const r = path.relative(REPO, p);
			if (e.isDirectory()) {
				if (["node_modules", ".git", "research", "adr"].includes(e.name)) continue;
				walk(p);
			} else if (e.name.endsWith(".md")) {
				// Dated spec records: snapshots of what was true then.
				if (/^docs\/spec-\d+/.test(r)) continue;
				out.push(r);
			}
		}
	};
	walk(path.join(REPO, "docs"));
	walk(path.join(REPO, "skills"));
	out.push("README.md", "CLAUDE.md");
	return out.filter((r) => fs.existsSync(path.join(REPO, r)));
}

/**
 * The blank-line-delimited block containing line `i`, joined into one string.
 * Table rows are their own paragraph in practice (a table is a run of non-blank
 * lines), which is what lets a "What was removed" row exempt itself.
 */
function paragraphAt(lines: string[], i: number): string {
	let a = i;
	let b = i;
	while (a > 0 && lines[a - 1].trim() !== "") a--;
	while (b < lines.length - 1 && lines[b + 1].trim() !== "") b++;
	return lines.slice(a, b + 1).join(" ");
}

console.log("#230: retired workflow vocabulary in live guidance");

const violations: string[] = [];
let scanned = 0;

for (const rel of liveGuidance()) {
	if (ALLOWLIST.has(rel)) continue;
	scanned++;
	const lines = fs.readFileSync(path.join(REPO, rel), "utf8").split("\n");
	let heading = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^#{1,6}\s/.test(line) || /^\s*\|\s*(Retired|Removed|What)\b/i.test(line)) heading = line;

		// The exemption is evaluated over the whole PARAGRAPH, not the line. Prose
		// wraps, so "…a `merge-checklist` skill that never\nexisted on disk" would
		// otherwise fail on the first line and pass on the second — an author fixing
		// it correctly gets a red test and learns to reword for the regex instead of
		// for the reader. That happened twice while writing this suite, which is the
		// evidence for the shape. A paragraph admitting the term is history is an
		// honest paragraph regardless of where the line breaks fall.
		if (HISTORICAL.test(paragraphAt(lines, i)) || HISTORICAL.test(heading)) continue;

		for (const { term, label, now } of RETIRED) {
			if (term.test(line)) {
				violations.push(`${rel}:${i + 1}  ${label} → ${now}\n    ${line.trim().slice(0, 120)}`);
			}
		}
	}
}

check(scanned > 10, `scanned ${scanned} live-guidance files (the walk still finds them)`);
check(violations.length === 0,
	"no retired term is stated as current in live guidance",
	violations.join("\n"));

// The detector must still SEE a violation, or a regex that stopped matching would
// read as a clean codebase — the failure mode pi-merge-retired.test.ts hit first.
const PROBE = "Run `git-snap` to save your work, then finish at Step 5.";
const probeHits = RETIRED.filter((r) => r.term.test(PROBE)).length;
check(probeHits === 2, "the detector still catches a known-bad probe", `caught ${probeHits} of 2`);

// The paragraph rule itself: a marker on ANY line of the block exempts the block,
// and a block with no marker anywhere is not exempt.
const WRAPPED = ["The gate belonged to a `merge-checklist` skill that never", "existed on disk.", ""];
check(HISTORICAL.test(paragraphAt(WRAPPED, 0)),
	"a marker that wrapped onto the next line still exempts the term");
check(!HISTORICAL.test(paragraphAt(["Run `git-snap` first,", "then push.", ""], 0)),
	"a wrapped paragraph with no marker is still caught");
check(HISTORICAL.test("`git-snap` was replaced by `git-checkpoint`."),
	"a sentence that admits the term is history is exempt");
check(!HISTORICAL.test("Run `git-snap` to save your work."),
	"a sentence that presents it as current is NOT exempt");

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} #230 terms: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
