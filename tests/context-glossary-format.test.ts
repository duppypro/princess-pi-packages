#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/context-glossary-format.test.ts — every glossary term in CONTEXT.md carries an
 * _Avoid_ list (#162)
 *
 * The `_Avoid_:` list is what makes a `## Language — <Tool>` section mechanically
 * enforceable by the spec-reconcile skill, rather than a glossary a human has to remember
 * to consult. This test enforces the format generically across every `## Language — <Tool>`
 * section in CONTEXT.md (so it also covers `## Language — Serve`, which already followed
 * the convention, and any future section added the same way) — not just the new WTFT one —
 * and then pins the specific terms #162 asked for and the daemon/bin-bucket rulings the
 * issue required to be resolved one way, not left ambiguous.
 *
 * Run: node --experimental-strip-types tests/context-glossary-format.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTEXT_PATH = path.join(REPO_ROOT, "CONTEXT.md");
const content = fs.readFileSync(CONTEXT_PATH, "utf8");

// A term header is a line that is ENTIRELY the bolded term (optionally with a parenthetical
// qualifier) followed by a colon — e.g. "**Daemon**:" or "**Surge (window / pricing)**:".
// This deliberately excludes bold text embedded mid-sentence elsewhere in a definition body
// (e.g. "...overhead → **Ovrhd** (`CATEGORY_STYLE`..." does not end the line in ":", so it
// does not false-positive as a second header).
const HEADER_RE = /^\*\*.+:$/;
const AVOID_RE = /^_Avoid_:/;

// ---
// TEST 1: every "## Language — <Tool>" section has 1:1 header-to-_Avoid_ correspondence
// ---
console.log("--- TEST 1: every glossary term has exactly one _Avoid_ list, in every Language section ---");

const sectionStarts = [...content.matchAll(/^## Language — (.+)$/gm)];
check(sectionStarts.length >= 2, `at least 2 "## Language — <Tool>" sections exist (found ${sectionStarts.length})`);

for (let i = 0; i < sectionStarts.length; i++) {
	const name = sectionStarts[i][1];
	const start = sectionStarts[i].index!;
	const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1].index! : content.length;
	const sectionText = content.slice(start, end);

	const headers = sectionText.split("\n").filter(line => HEADER_RE.test(line));
	const avoids = sectionText.split("\n").filter(line => AVOID_RE.test(line));

	check(headers.length > 0, `"Language — ${name}" has at least one glossary term`);
	check(
		headers.length === avoids.length,
		`"Language — ${name}": every term header has exactly one _Avoid_ list (${headers.length} headers, ${avoids.length} _Avoid_ lines)`
	);
}

// ---
// TEST 2: #162's minimum required terms are pinned in "## Language — WTFT"
// ---
console.log("\n--- TEST 2: #162's minimum required terms are present ---");

const wtftMatch = sectionStarts.find(m => m[1] === "WTFT");
check(!!wtftMatch, `"## Language — WTFT" section exists`);

if (wtftMatch) {
	const start = wtftMatch.index!;
	const idx = sectionStarts.indexOf(wtftMatch);
	const end = idx + 1 < sectionStarts.length ? sectionStarts[idx + 1].index! : content.length;
	const wtftSection = content.slice(start, end);

	// Required pins from #162's "Candidate terms to pin" list, each checked as its own header.
	const requiredTerms = [
		"Daemon", "Interval", "Bin", "Bucket", "Cumulative", "Session", "Sidechain",
		"Subagent session", "Tag file", "Tags dir", "Surge", "Category", "Thinking level",
		"Thinking budget", "Harness", "Widget", "CLI", "Pager", "Watch mode",
	];
	for (const term of requiredTerms) {
		const re = new RegExp(`^\\*\\*${term}\\b`, "m");
		check(re.test(wtftSection), `"${term}" has its own glossary entry`);
	}

	// The overhead/waste/compaction trio is pinned as a group (they are one comparison, not
	// three independent terms).
	check(
		/^\*\*Overhead vs\. waste vs\. compaction\*\*/m.test(wtftSection),
		`"Overhead vs. waste vs. compaction" trio is pinned`
	);

	// ---
	// TEST 3: the daemon/log-parser ruling is resolved, not left open
	// ---
	console.log("\n--- TEST 3: daemon vs. log parser ruling is resolved one way ---");

	const daemonParagraph = wtftSection.split(/\n\n+/).find(p => p.startsWith("**Daemon**:"));
	check(!!daemonParagraph, `"Daemon" entry exists as its own paragraph`);
	if (daemonParagraph) {
		check(
			/_Avoid_:.*log parser/is.test(daemonParagraph),
			`"Daemon"'s _Avoid_ list includes "log parser" — the ruling from #162 (measured: daemon dominates code/filenames, log parser survives only in user-facing text)`
		);
	}

	// The reverse must NOT exist — there must be no "**Log parser**:" header competing with Daemon.
	check(
		!/^\*\*Log [Pp]arser\*\*:/m.test(wtftSection),
		`No competing "Log parser" glossary entry exists — the ruling picked one winner, not both`
	);

	// ---
	// TEST 4: the bin/bucket distinction is resolved, not conflated
	// ---
	console.log("\n--- TEST 4: bin vs. bucket ruling is resolved, not conflated ---");

	// Paragraph-based extraction (split on blank lines) rather than a single multi-line regex —
	// robust to how long or short a given entry's body/_Avoid_ text is, since it doesn't need
	// to guess where the prose ends.
	const paragraphs = wtftSection.split(/\n\n+/);
	const binParagraph = paragraphs.find(p => p.startsWith("**Bin**:"));
	const bucketParagraph = paragraphs.find(p => p.startsWith("**Bucket (mode)**:"));

	check(!!binParagraph, `"Bin" entry exists as its own paragraph`);
	check(!!bucketParagraph, `"Bucket (mode)" entry exists as its own paragraph`);

	if (binParagraph) {
		check(
			/_Avoid_:.*bucket/is.test(binParagraph),
			`"Bin"'s paragraph calls out "bucket" (in its _Avoid_ text) as the reserved-elsewhere term, rather than treating them as synonyms`
		);
	}
	if (bucketParagraph) {
		check(
			/_Avoid_:.*\bbin\b/is.test(bucketParagraph),
			`"Bucket (mode)"'s _Avoid_ list includes "bin" — the split is pinned in both directions`
		);
	}
}

// ---
// RESULT
// ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error("❌ CONTEXT GLOSSARY FORMAT TEST FAILED");
	process.exit(1);
}
console.log("✅ CONTEXT GLOSSARY FORMAT TEST PASSED — every glossary term is mechanically enforceable!");
