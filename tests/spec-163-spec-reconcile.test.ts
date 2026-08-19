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
 * verifiable by a third party — one numbered section below per item:
 *
 *   1. The corpus. `docs/spec-163-spec-reconcile-backtest.md` §9 cites four drifts at
 *      SHA 9b2a16e by file and content. If that tree stops containing them, the record
 *      becomes an unfalsifiable claim about a state nobody can reach.
 *   2. The load-bearing clauses. The backtest measured WHICH sentences in the skill
 *      reach WHICH fixture. Delete one and the skill silently regresses to the version
 *      that scored 2 of 4 — with no test failing, which is the exact landmine the skill
 *      is about.
 *   3. (Retired here, #345.) Repo-vs-deploy parity used to be asserted in this suite
 *      directly. `~/.claude/skills/` is shared by every worktree, branch, and main, so
 *      that assertion went red on every OTHER worktree the moment any one branch
 *      legitimately deployed an edit — a host-drift question has no correct answer
 *      inside a per-branch suite. It now lives in `bin/install-workflow-tools --check`
 *      (gated by tests/skills-deploy.test.ts), whose job is host drift.
 *   4. The two drifts this branch fixed, so they cannot rot back.
 *   5. The harness files the record points at, so the re-run instructions stay truthful.
 *
 * This suite reads git and the filesystem only. No clock, no network, no daemon.
 *
 * Run: node --experimental-strip-types tests/spec-163-spec-reconcile.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import * as os from "node:os";

const REPO = path.resolve(import.meta.dirname, "..");
const CORPUS_SHA = "9b2a16e";
/** F5 (#383) pins its own tree: the commit BEFORE #382 corrected the host doc. */
const F5_SHA = "bf4d104";

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

/** Read a file as it existed at an arbitrary frozen SHA. */
function atSha(sha: string, relPath: string): string {
	return execFileSync("git", ["-C", REPO, "show", `${sha}:${relPath}`], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
}

/** Read a file as it existed at the frozen F1–F4 corpus SHA. */
const atCorpus = (relPath: string): string => atSha(CORPUS_SHA, relPath);

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
// 1b. F5 (#383) — the Tier-4 fixture, which needs BOTH halves to stay true:
//     a frozen host document that is wrong, and a tree at F5_SHA in which every
//     TRACKED artifact is already right. The second half is what makes the
//     diff-scoped control's clean result evidence rather than an absence.
// ---
console.log(`\n— F5 host-scope fixture at ${F5_SHA} + frozen host doc`);

const HOST_DOC = "research/spec-reconcile-backtest/fixtures/host/git-projects-CLAUDE.md";

let f5Reachable = true;
let f5Hook = "";
let f5Spec = "";
try {
	f5Hook = atSha(F5_SHA, "hooks/block-dangerous-git.sh");
	f5Spec = atSha(F5_SHA, "docs/dev-workflow-spec.md");
} catch (err) {
	f5Reachable = false;
	console.log(`  (git show ${F5_SHA} failed: ${(err as Error).message})`);
}
check(`F5 corpus SHA ${F5_SHA} is reachable from this clone`, f5Reachable);

// Probe the hook's BEHAVIOUR at that SHA, not its banner comment. Verifying a comment as
// a proxy for behaviour is the exact drift class F5 exists to measure, so this suite must
// not do it (#383 review). The hook is materialised from the frozen tree and run for real.
function hookVerdictAtF5(command: string, branch: string): "allow" | "block" | "error" {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-probe-"));
	try {
		const hook = path.join(dir, "hook.sh");
		fs.writeFileSync(hook, atSha(F5_SHA, "hooks/block-dangerous-git.sh"));
		const repo = path.join(dir, "repo");
		fs.mkdirSync(repo);
		execFileSync("git", ["init", "-q", "-b", branch, repo]);
		const res = spawnSync("bash", [hook], {
			input: JSON.stringify({ tool_input: { command, cwd: repo } }),
			encoding: "utf8",
		});
		if (res.status === 0) return "allow";
		if (res.status === 2) return "block";
		return "error";
	} catch {
		return "error";
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

check(
	"F5: the hook at that SHA in fact ALLOWED a feature-branch push (measured, not read)",
	f5Reachable && hookVerdictAtF5("git push origin 42-feat", "42-feat") === "allow",
);
check(
	"F5: …and blocked a push whose destination was main — so the gate was on DESTINATION",
	f5Reachable && hookVerdictAtF5("git push origin main", "42-feat") === "block",
);
// The control's F5-clean result is only evidence if the claim was absent from the WHOLE
// tracked tree, not merely contradicted in one file. `git grep` at the frozen SHA is the
// check the old label promised and did not make.
let claimInTracked: string[] = [];
try {
	claimInTracked = execFileSync(
		"git",
		["-C", REPO, "grep", "-l", "-F", "intercept: `git push`", F5_SHA],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.filter(Boolean);
} catch {
	claimInTracked = []; // git grep exits 1 when nothing matches — the expected case
}
check(
	"F5: NO tracked file at that SHA carried the false claim — which is what makes the control's clean result evidence",
	claimInTracked.length === 0,
	`found in: ${JSON.stringify(claimInTracked)}`,
);
check(
	"F5: the tracked spec at that SHA said the opposite, in as many words",
	f5Spec.includes("destination-aware, not a flat block list"),
);

const hostDoc = fs.existsSync(path.join(REPO, HOST_DOC)) ? readRepo(HOST_DOC) : "";
check(`F5: the frozen host doc is committed at ${HOST_DOC}`, hostDoc.length > 0);
check(
	"F5: it still carries the false claim verbatim — softening the fixture is softening the score",
	hostDoc.includes("intercept: `git push`, `git reset --hard`"),
);
// The staged file must read like the live host document and nothing else. An earlier
// revision carried a provenance banner INSIDE it — "do not edit to make an auditor pass",
// "immediately BEFORE #381 corrected it" — which told the auditor a false claim was planted
// here and dated it. A real ~/git-projects/CLAUDE.md carries no such hint.
check(
	"F5: the fixture carries no provenance banner that would hint at the planted claim",
	!/FIXTURE|do not edit to make|scored against it/i.test(hostDoc),
	"provenance belongs in fixtures/README.md, which is never staged into the corpus",
);
// (§2 Tier 4 / RUBRIC "Absence declared") The round scores the auditor for SAYING that
// claude-CLAUDE.md and claude-settings.json are missing. That is only a fact about the
// corpus while this directory holds exactly one file.
const HOST_DIR = path.join(REPO, "research/spec-reconcile-backtest/fixtures/host");
const staged = fs.existsSync(HOST_DIR) ? fs.readdirSync(HOST_DIR).sort() : [];
check(
	"F5: fixtures/host holds exactly the one staged document the round expects",
	staged.length === 1 && staged[0] === "git-projects-CLAUDE.md",
	`found: ${JSON.stringify(staged)} — adding a file silently inverts the absence check`,
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
	// #383 — Tier 4. Each of these is what puts a host-scoped document in front of an
	// auditor at all; without them the skill regresses to a scope that provably cannot
	// reach F5, and no other test would notice.
	["F5 (reverse scope)", "§1 — a diff answers the wrong question for a tool change", 'who quotes\nthis tool\'s behaviour, anywhere?'],
	["F5 (trigger)", "§1 — names the paths that activate the tier", "The branch touches `hooks/`, `bin/`, `extensions/`, or `skills/`"],
	["F5 (why no diff works)", "§1 — the file is not gitignored, it is in no repo", "is **not a git repository at all**"],
	["F5 (enumeration)", "§2 Tier 4 — the set cannot be derived, so it must be listed", "enumerated because it cannot be derived"],
	["F5 (absence)", "§2 Tier 4 — a host check that finds no file must say so", "Check the ones present; declare the ones absent"],
	["F5 (pin)", "§2 Tier 4 — a reword is invisible to behaviour probes alone", "Pin the claim; do not merely edit the sentence"],
];

// Match with runs of whitespace collapsed, so a needle spanning a hard line wrap survives
// a cosmetic reflow of the paragraph. A reflow is not a skill regression, and reporting it
// as one is the false signal this array exists to avoid.
const flat = (t: string): string => t.replace(/\s+/g, " ");
const flatSkill = flat(skill);

for (const [reaches, why, needle] of CLAUSES) {
	check(
		`clause present [${reaches}] ${why}`,
		flatSkill.includes(flat(needle)),
		`missing: ${JSON.stringify(needle.slice(0, 48))}`,
	);
}

check(
	"skill records the backtest result rather than only prescribing one",
	skill.includes("surfaced two of four"),
);

// ---
// 3. Repo-vs-deploy parity moved out of this suite (#345).
//
//    ~/.claude/skills/ is ONE directory shared by every worktree, every branch,
//    and main — a host-drift assertion inside a per-branch suite has no correct
//    answer once more than one worktree exists: the moment any branch legitimately
//    edited spec-reconcile's SKILL.md and deployed it, every OTHER worktree
//    (including main) would fail THIS check for a reason that had nothing to do
//    with its own changes. It happened twice before this suite stopped asserting
//    it. That question now belongs to `bin/install-workflow-tools --check`, whose
//    entire job is host drift and which deploys skills to both harness targets
//    (tests/skills-deploy.test.ts is its gate).
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
	"research/spec-reconcile-backtest/fixtures/README.md",
	"research/spec-reconcile-backtest/prompts/round3-host-scope/FIXTURE_SHA",
	"research/spec-reconcile-backtest/prompts/round3-host-scope/STAGE_HOST",
	"research/spec-reconcile-backtest/runs/round3-host-scope/STATUS.tsv",
	"research/spec-reconcile-backtest/prompts/round3-host-scope/C1-guardrails-repo-only-control.txt",
	"research/spec-reconcile-backtest/prompts/round3-host-scope/C2-guardrails-host-scoped.txt",
	"research/spec-reconcile-backtest/runs/round3-host-scope/C1-guardrails-repo-only-control.md",
	"research/spec-reconcile-backtest/runs/round3-host-scope/C2-guardrails-host-scoped.md",
	HOST_DOC,
	"docs/spec-163-spec-reconcile-backtest.md",
]) {
	// Non-empty, not merely present: an auditor that timed out leaves a 0-byte
	// transcript behind, and "the file is there" would score that as a run.
	const abs = path.join(REPO, rel);
	const bytes = fs.existsSync(abs) ? fs.statSync(abs).size : -1;
	check(`present and non-empty: ${rel}`, bytes > 0, bytes === 0 ? "0 bytes" : "missing");
}

const safeRead = (rel: string): string =>
	fs.existsSync(path.join(REPO, rel)) ? readRepo(rel) : "";

const harness = safeRead("research/spec-reconcile-backtest/run-backtest.sh");
check("the harness pins the same corpus SHA the record cites", harness.includes(CORPUS_SHA));
check(
	"the harness reads each round's own FIXTURE_SHA — a fixture is a tree AND a question",
	harness.includes('PROMPT_DIR="$HERE/prompts/$ROUND"') &&
		harness.includes('$PROMPT_DIR/FIXTURE_SHA'),
);
check(
	"the harness stages the host doc, which `git archive` structurally cannot carry",
	harness.includes('cp -R "$HERE/fixtures/host/." "$WORK/host/"'),
);
check(
	"the overlay is gated PER ROUND, so rounds 1-2 still reproduce the 9b2a16e corpus",
	harness.includes('[ -f "$PROMPT_DIR/STAGE_HOST" ]'),
);
check(
	"round 3 carries the STAGE_HOST marker its prompts depend on",
	fs.existsSync(
		path.join(REPO, "research/spec-reconcile-backtest/prompts/round3-host-scope/STAGE_HOST"),
	),
);
check(
	"a mistyped ROUND is fatal, not a green run over zero auditors",
	harness.includes("no such round") && harness.includes("contains no *.txt prompts"),
);
check(
	"a non-zero auditor makes the whole run non-zero",
	harness.includes('exit "$worst"') && harness.includes("STATUS.tsv"),
);
check(
	"OUT defaults to the round directory the record scores",
	harness.includes('OUT="${OUT:-$HERE/runs/$ROUND}"'),
);
// (#383 review) A dead auditor emits zero findings, which scores identically to a clean
// control. The harness's own error path appends a marker to the transcript, so "non-empty"
// alone cannot tell the two apart — check the recorded exit status and the marker.
const R3 = "research/spec-reconcile-backtest/runs/round3-host-scope";
const statusPath = path.join(REPO, R3, "STATUS.tsv");
const statusText = fs.existsSync(statusPath) ? readRepo(`${R3}/STATUS.tsv`) : "";
const statusRows = statusText
	.trim()
	.split("\n")
	.filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("auditor\t"));
check(
	"round 3's STATUS.tsv records the corpus its transcripts came from",
	/^# round=round3-host-scope fixture_sha=bf4d104 /.test(statusText),
	statusText.split("\n")[0] ?? "(empty)",
);
check(
	"round 3 recorded a per-auditor exit status for both arms",
	statusRows.length === 2,
	`STATUS.tsv rows: ${statusRows.length}`,
);
check(
	"every round-3 auditor exited 0 — a killed auditor is not a result",
	statusRows.length > 0 && statusRows.every((r) => r.split("\t")[1]?.trim() === "0"),
	statusRows.join(" | "),
);
for (const arm of ["C1-guardrails-repo-only-control", "C2-guardrails-host-scoped"]) {
	const rel = `${R3}/${arm}.md`;
	const body = fs.existsSync(path.join(REPO, rel)) ? readRepo(rel) : "";
	check(
		`${arm}: transcript carries no harness failure marker`,
		body.length > 0 && !body.includes("is NOT a scoreable run"),
	);
}

// The manipulation between the two arms must be scope and nothing else. If they differ
// anywhere but the host-document block, the round measures prompt wording, not scope.
// The stated invariant is bidirectional — "byte-identical apart from one block" — so a
// one-directional membership test is not it: an instruction DELETED from C2, or added to
// C1 only, or a reordering, each turns the round into a measurement of prompt wording
// while a set-difference check stays green (#383 review).
const promptLines = (n: string): string[] =>
	safeRead(`research/spec-reconcile-backtest/prompts/round3-host-scope/${n}.txt`).split("\n");
const c1Lines = promptLines("C1-guardrails-repo-only-control");
const c2Lines = promptLines("C2-guardrails-host-scoped");
const isHostBlock = (l: string): boolean =>
	/host|artifact set is not the diff/i.test(l) || l.trim() === "";

// Delete C2's host block, then the two prompts must be identical LINE FOR LINE, in order.
const c2WithoutHostBlock: string[] = [];
{
	let i = 0;
	for (const line of c2Lines) {
		if (c1Lines[i] === line) {
			c2WithoutHostBlock.push(line);
			i++;
		} else if (isHostBlock(line)) {
			continue; // part of the enumeration block C2 is allowed to add
		} else {
			c2WithoutHostBlock.push(line);
		}
	}
}
const identical =
	c1Lines.length > 0 && JSON.stringify(c2WithoutHostBlock) === JSON.stringify(c1Lines);
check(
	"C1 and C2 are identical line-for-line once C2's host-enumeration block is removed",
	identical,
	identical
		? ""
		: `C1 has ${c1Lines.length} lines; C2-minus-host-block reduces to ${c2WithoutHostBlock.length}`,
);
check(
	"C2 does add the host-enumeration block — otherwise there is no manipulation at all",
	c2Lines.some((l) => l.includes("./host/git-projects-CLAUDE.md")),
);

check(
	`round 3 declares ${F5_SHA} as its corpus`,
	safeRead("research/spec-reconcile-backtest/prompts/round3-host-scope/FIXTURE_SHA").trim() ===
		F5_SHA,
);
const PROMPT_ROOT = path.join(REPO, "research/spec-reconcile-backtest/prompts");
const rounds = fs.existsSync(PROMPT_ROOT) ? fs.readdirSync(PROMPT_ROOT).sort() : [];
check(
	"every round directory declares its own corpus SHA — the rule RUBRIC states",
	rounds.length >= 3 &&
		rounds.every((r) => fs.existsSync(path.join(PROMPT_ROOT, r, "FIXTURE_SHA"))),
	`rounds without FIXTURE_SHA: ${JSON.stringify(rounds.filter((r) => !fs.existsSync(path.join(PROMPT_ROOT, r, "FIXTURE_SHA"))))}`,
);
check(
	"the harness refuses to overwrite a scored transcript set",
	harness.includes("refusing to overwrite it") && harness.includes('"${OVERWRITE:-0}"'),
);
check(
	"the harness ships an exit-code table and a --help that prints it",
	harness.includes("exit codes: 0 ok") && harness.includes("-h|--help"),
);
check(
	"an env FIXTURE_SHA that contradicts the round's marker is refused",
	harness.includes("contradicts round") && harness.includes("OVERRIDE_SHA"),
);

check(
	"RUBRIC records F5 and its own SHA, so the record stays third-party checkable",
	(() => {
		const r = safeRead("research/spec-reconcile-backtest/RUBRIC.md");
		return r.includes("## F5 —") && r.includes(F5_SHA);
	})(),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
