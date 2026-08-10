#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/spec-163-spec-reconcile.test.ts — companion gate for the spec-reconcile backtest (#163)
 *
 * WHY this suite exists, and what it deliberately does NOT do.
 *
 * The backtest itself cannot live here: it dispatches fresh-context auditor
 * processes, costs real tokens, and is scored by judgment. Running it is
 * `research/spec-reconcile-backtest/run-backtest.sh`.
 *
 * What CAN be gated is everything the backtest *record* depends on to stay
 * verifiable by a third party:
 *
 *   1. The corpus. `docs/spec-163-spec-reconcile-backtest.md` §9 cites four drifts at
 *      SHA 9b2a16e by file and content. If that tree stops containing them, the record
 *      becomes an unfalsifiable claim about a state nobody can reach.
 *   2. The load-bearing clauses. The backtest measured WHICH sentences in the skill
 *      reach WHICH fixture. Delete one and the skill silently regresses to the version
 *      that scored 2 of 4 — with no test failing, which is the exact landmine the skill
 *      is about.
 *   3. The two drifts this branch fixed, so they cannot rot back.
 *
 * This suite reads git and the filesystem only. No clock, no network, no daemon.
 *
 * Run: node --experimental-strip-types tests/spec-163-spec-reconcile.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const CORPUS_SHA = "9b2a16e";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail = "") {
	if (cond) {
		passed++;
		console.log(`  PASS  ${label}`);
	} else {
		failed++;
		console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

/** Read a file as it existed at the frozen corpus SHA. */
function atCorpus(relPath: string): string {
	return execFileSync("git", ["-C", REPO, "show", `${CORPUS_SHA}:${relPath}`], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
}

function readRepo(relPath: string): string {
	return fs.readFileSync(path.join(REPO, relPath), "utf8");
}

// ---
// 1. The corpus is still reachable and still contains all four fixtures.
//    Each assertion mirrors one row of research/spec-reconcile-backtest/RUBRIC.md.
// ---
console.log("\n— corpus fixtures at " + CORPUS_SHA);

let corpusReachable = true;
let renderer = "";
let manifest = "";
let titleTest = "";
try {
	renderer = atCorpus("extensions/lib/wtft-renderer.ts");
	manifest = atCorpus("docs/manifests/wtft-cmd.json");
	titleTest = atCorpus("tests/wtft-title-layout.test.ts");
} catch (err) {
	corpusReachable = false;
	console.log(`  (git show ${CORPUS_SHA} failed: ${(err as Error).message})`);
}
check(`corpus SHA ${CORPUS_SHA} is reachable from this clone`, corpusReachable);

// F1 — the ◆ docstring the renderer had already abandoned.
check(
	"F1: renderer docstring at corpus advertises the ◆ marker",
	renderer.includes("(---[colored]---◆---)"),
);
check(
	"F1: renderer at corpus in fact emits clock faces and moon bookends",
	renderer.includes("const CLOCK_FACES") && renderer.includes("${moon}${timelineBody}${moon}"),
);

// F2 — the omission. The hardest fixture: the manifest says nothing false.
check(
	"F2: manifest at corpus documents only <size><m|h|d|w>",
	manifest.includes("-i, --interval <size><m|h|d|w>"),
);
check(
	"F2: parseInterval at corpus nonetheless accepts t/turn/turns",
	renderer.includes("/^(\\d+)(?:t|turns?)$/"),
);
// Fixed at Code Approved (#163): the corpus manifest's tool DESCRIPTION uses "turn" twice
// in ordinary prose ("each turn's action", "every turn's cost") that has nothing to do with
// the --interval flag — a whole-file substring check false-failed on that prose. The
// fixture's actual claim is narrower: the `-i, --interval` FLAG ENTRY's own desc is silent
// on the turn unit. Scope the check to that entry instead of the whole file.
const intervalEntryMatch = /"flags":\s*"-i, --interval[^"]*"\s*,\s*"desc":\s*"([^"]*)"/.exec(
	manifest,
);
check(
	"F2: manifest at corpus has a recognisable -i/--interval usage entry",
	intervalEntryMatch !== null,
	"could not find the -i, --interval entry in the corpus manifest — its shape changed",
);
check(
	"F2: that entry's own desc never mentions a turn interval unit",
	intervalEntryMatch !== null && !/\bturns?\b/i.test(intervalEntryMatch[1]),
	"the -i/--interval desc itself now mentions turns — the omission fixture may have been fixed upstream",
);

// F3 — the test header that rotted in lockstep with its own assertions.
check(
	"F3: title-layout header at corpus asserts the ◆ invariant",
	titleTest.includes("Invariant: the SURGE timeline (---◆---)"),
);
check(
	"F3: its own assertions at corpus still check for ◆, so it agrees with itself",
	titleTest.includes('titleRow.includes("◆")'),
);

// F4 — the control: a docstring describing an entirely different function.
check(
	"F4: parseInterval at corpus carries a .jsonl file-parser docstring",
	/@param filePath[\s\S]{0,200}export function parseInterval/.test(renderer),
);

// ---
// 2. The vendored skill still carries the clauses the backtest measured.
//    Each string below is traceable to a fixture it was shown to reach; dropping one
//    regresses the skill to the version that scored 2 of 4.
// ---
console.log("\n— load-bearing clauses in the vendored skill");

const skill = readRepo("skills/spec-reconcile/SKILL.md");

const CLAUSES: Array<[string, string, string]> = [
	// [what it reaches, why, substring]
	["F2 (omission)", "§4 — omissions are invisible without this", "is silent on, or"],
	["F2 (omission)", "§4 — names the omission case concretely", "an accepted input that `--help`"],
	["F2 (scope)", "§1 — symbol-level scoping misses the manifest gap", "File-level, not symbol-level, is deliberate and load-bearing"],
	["F1 (triage loss)", "§4 — a word cap turns the audit into a ranking exercise", "Never drop a finding to fit a length"],
	["F1 (triage loss)", "§1 — bloated artifact sets drop small findings", "re-run it narrowed"],
	["F1/F4 (docstrings)", "§4 — forces navigation to comments nobody reads", "in file order"],
	["F4 (misattachment)", "§4 — a docstring bound to the wrong symbol reads correct in review", "attach to a different symbol than the author intended"],
	["F3 (test files)", "§4 variant — a test audited against itself has nothing to contradict", "is an ARTIFACT, not an authority"],
	["F3 (test files)", "§5 — 'the code' must exclude test code", "A test file is an artifact"],
	["Tier 3", "§4 — the glossary check is unreachable unless the prompt asks", "invent no terminology"],
	["§6 output", "auditors that fill in tables stop finding rows", "auditors return findings, not tables"],
	["durability", "the two copies fork silently without a stated direction", "is the **source of truth**"],
];

for (const [reaches, why, needle] of CLAUSES) {
	check(`clause present [${reaches}] ${why}`, skill.includes(needle), `missing: ${JSON.stringify(needle.slice(0, 48))}`);
}

check(
	"skill records the backtest result rather than only prescribing one",
	skill.includes("surfaced two of four"),
);

// ---
// 3. The vendored copy is the source of truth; the deploy copy must not have forked.
//    Skipped where the dotfile does not exist (CI, a fresh clone) — this gate is about
//    catching a fork on a machine that has both, not about requiring the deploy.
// ---
console.log("\n— repo copy vs deploy copy");

const deployed = path.join(os.homedir(), ".claude", "skills", "spec-reconcile", "SKILL.md");
if (fs.existsSync(deployed)) {
	check(
		"~/.claude deploy copy matches the repo source of truth",
		fs.readFileSync(deployed, "utf8") === skill,
		"repo copy wins — re-copy skills/spec-reconcile/SKILL.md to ~/.claude/skills/spec-reconcile/",
	);
} else {
	console.log("  SKIP  no ~/.claude deploy copy on this machine");
}

// ---
// 4. The two drifts this branch fixed, gated so they cannot rot back.
//    Both were surfaced BY the backtest and were still live on main.
// ---
console.log("\n— drifts fixed in this branch");

const rendererNow = readRepo("extensions/lib/wtft-renderer.ts");

check(
	"parseInterval no longer carries the .jsonl file-parser docstring",
	!/@param filePath[\s\S]{0,200}export function parseInterval/.test(rendererNow),
);
check(
	"parseInterval's docstring now documents the turn unit it accepts",
	rendererNow.includes("Parse an `--interval` argument") &&
		rendererNow.includes("`<n>t` / `<n>turn` / `<n>turns`"),
);

// The #158 fix landed the right text four declarations early, so every editor hover
// bound it to MOON_PHASES. Assert ADJACENCY, not mere presence — presence was already
// true while the bug existed, which is why nothing caught it.
const timelineDocIdx = rendererNow.indexOf("Build a 24-hour surge timeline string");
const timelineFnIdx = rendererNow.indexOf("export function buildTimelineString");
check(
	"buildTimelineString's docstring precedes the function at all",
	timelineDocIdx >= 0 && timelineFnIdx > timelineDocIdx,
);
const docCloseIdx = timelineDocIdx >= 0 ? rendererNow.indexOf("*/", timelineDocIdx) : -1;
check(
	"nothing declares between that docstring and the function it documents",
	docCloseIdx > 0 &&
		timelineFnIdx > docCloseIdx &&
		/^\s*$/.test(rendererNow.slice(docCloseIdx + 2, timelineFnIdx)),
	"a declaration sits in between — TypeScript will attach the docstring to it",
);

// ---
// 5. The harness the record points at is actually present.
// ---
console.log("\n— backtest harness");

for (const rel of [
	"research/spec-reconcile-backtest/run-backtest.sh",
	"research/spec-reconcile-backtest/RUBRIC.md",
	"research/spec-reconcile-backtest/prompts/round1-as-written/A1-renderer-faithful.txt",
	"research/spec-reconcile-backtest/prompts/round2-fixed/B1-renderer.txt",
	"research/spec-reconcile-backtest/prompts/round2-fixed/B3-title-layout-test.txt",
	"research/spec-reconcile-backtest/runs/round1-as-written/A1-renderer-faithful.md",
	"research/spec-reconcile-backtest/runs/round2-fixed/B1-renderer.md",
	"docs/spec-163-spec-reconcile-backtest.md",
]) {
	check(`present: ${rel}`, fs.existsSync(path.join(REPO, rel)));
}

check(
	"the harness pins the same corpus SHA the record cites",
	readRepo("research/spec-reconcile-backtest/run-backtest.sh").includes(CORPUS_SHA),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
