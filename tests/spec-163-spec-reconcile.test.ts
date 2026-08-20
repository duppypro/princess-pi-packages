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

// --- shared readers. Declared here because several sections below consume them, and
//     a const arrow is not hoisted: first use must follow the declaration. ---
const safeRead = (rel: string): string =>
	fs.existsSync(path.join(REPO, rel)) ? readRepo(rel) : "";
const PROMPT_ROOT = path.join(REPO, "research/spec-reconcile-backtest/prompts");
const rounds = fs.existsSync(PROMPT_ROOT) ? fs.readdirSync(PROMPT_ROOT).sort() : [];
const roundSha = (round: string): string =>
	safeRead(`research/spec-reconcile-backtest/prompts/${round}/FIXTURE_SHA`).trim();


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
let f5Spec = "";
try {
	f5Spec = atSha(F5_SHA, "docs/dev-workflow-spec.md");
} catch (err) {
	f5Reachable = false;
	console.log(`  (git show ${F5_SHA} failed: ${(err as Error).message})`);
}
check(`F5 corpus SHA ${F5_SHA} is reachable from this clone`, f5Reachable);

// Probe the hook's BEHAVIOUR at that SHA, not its banner comment. Verifying a comment as
// a proxy for behaviour is the exact drift class F5 exists to measure, so this suite must
// not do it (#383 review). The hook is materialised from the frozen tree and run for real.
let f5ProbeError = "";
function hookVerdictAtF5(command: string, branch: string): "allow" | "block" | "error" {
	f5ProbeError = ""; // never carry a previous probe's cause into this one's detail
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
			// A frozen shell script against a scratch repo can hang on a prompt or an
			// inherited credential helper. run-backtest.sh wraps its subprocess in
			// `timeout 900` for the same reason; a stalled suite reports nothing at all.
			timeout: 30_000,
		});
		if (res.error) {
			// spawnSync also returns status null when the child could not be spawned at
			// all (bash missing, noexec tmpdir). Reporting that as a timeout points the
			// reader at the 30s ceiling and the frozen hook instead of the real cause.
			f5ProbeError = `probe could not run: ${res.error.message}`;
			return "error";
		}
		if (res.status === null) {
			f5ProbeError = `probe timed out or was killed: ${res.signal ?? "unknown signal"}`;
			return "error";
		}
		if (res.status === 0) return "allow";
		if (res.status === 2) return "block";
		f5ProbeError = `hook exited ${res.status}: ${(res.stderr || "").trim()}`;
		return "error";
	} catch (err) {
		// A probe that dies because git/bash/tmpdir is unusable must not read as a
		// behaviour regression in a 2026-era hook. Keep the cause.
		f5ProbeError = (err as Error).message;
		return "error";
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// Both destination probes are branch-INDEPENDENT, so they would still pass if the payload
// shape were wrong and the hook silently fell back to this process's own cwd. The pair
// below is branch-sensitive and fails loudly in that case — it proves the probe harness,
// not the hook.
// Capture each probe's own cause at the moment it ran. f5ProbeError is module-scoped and
// reset per call, so reading it later — or on a short-circuited `&&` — attributes some
// other probe's failure to this check (#383 review).
const probe = (cmd: string, branch: string): { verdict: string; why: string } => {
	const verdict = hookVerdictAtF5(cmd, branch);
	return { verdict, why: f5ProbeError };
};
const onMain = probe("git commit -m x", "main");
const onFeature = probe("git commit -m x", "42-feat");
check(
	"F5 probe harness: the injected cwd is honoured (commit blocked on main, allowed on a feature branch)",
	onMain.verdict === "block" && onFeature.verdict === "allow",
	[onMain.why, onFeature.why].filter(Boolean).join(" / ") ||
		`on main: ${onMain.verdict}, on feature: ${onFeature.verdict}`,
);
const pushFeature = f5Reachable
	? probe("git push origin 42-feat", "42-feat")
	: { verdict: "not-run", why: `corpus ${F5_SHA} unreachable` };
check(
	"F5: the hook at that SHA in fact ALLOWED a feature-branch push (measured, not read)",
	pushFeature.verdict === "allow",
	pushFeature.why || `verdict: ${pushFeature.verdict}`,
);
const pushMain = f5Reachable
	? probe("git push origin main", "42-feat")
	: { verdict: "not-run", why: `corpus ${F5_SHA} unreachable` };
check(
	"F5: …and blocked a push whose destination was main — so the gate was on DESTINATION",
	pushMain.verdict === "block",
	pushMain.why || `verdict: ${pushMain.verdict}`,
);
// The control's F5-clean result is only evidence if the claim was absent from the WHOLE
// tracked tree, not merely contradicted in one file. `git grep` at the frozen SHA is the
// check the old label promised and did not make.
// `git grep` exits 1 for "no match" and 2+ for a real failure (bad SHA, not a repo). A
// bare catch turns both into a PASS, which is a vacuous pass on the load-bearing evidence
// check — the check most worth breaking loudly (#383 review).
const grepRes = spawnSync(
	"git",
	["-C", REPO, "grep", "-l", "-F", "intercept: `git push`", F5_SHA],
	{ encoding: "utf8" },
);
const grepRan = grepRes.status === 0 || grepRes.status === 1;
const claimInTracked =
	grepRes.status === 0 ? grepRes.stdout.trim().split("\n").filter(Boolean) : [];
check(
	"F5: the tree-wide search actually ran (exit 0 or 1 — anything else is a broken check, not a clean one)",
	grepRan,
	`git grep exited ${grepRes.status}: ${(grepRes.stderr || "").trim()}`,
);
check(
	"F5: NO tracked file at that SHA carried the false claim — which is what makes the control's clean result evidence",
	grepRan && claimInTracked.length === 0,
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
	hostDoc.length > 0 && !/FIXTURE|do not edit to make|scored against it/i.test(hostDoc),
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
	// The Tier 3 lesson, applied to Tier 4: a tier the §4 dispatch never fans out to is a
	// tier that silently stops existing. This is the clause that makes Tier 4 reachable.
	["F5 (dispatch)", "§4 — a tier no auditor is dispatched for does not exist", "plus one host-scoped auditor whenever §1's reverse-scope trigger\nfired"],
	["F5 (dispatch)", "§4 — names the hazard by its precedent", "A tier that no auditor is dispatched for does not exist."],
	["F5 (no aiming)", "§4 — instructions aimed at the answer confound the measurement", "Those instructions aim the auditor at the answer"],
	["honesty", "§7 — the backtest replays frozen prompts and cannot see a weakened §4", "nothing catches a **weakening**"],
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
	"research/spec-reconcile-backtest/runs/round3-host-scope/SCORES.tsv",
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

const harness = safeRead("research/spec-reconcile-backtest/run-backtest.sh");
// The old form was `harness.includes(CORPUS_SHA)`, which the harness's own prose comments
// satisfy — a pin that a comment can keep green is not a pin. The SHA now lives in the
// round markers, so assert their VALUES (#383 review).
check(
	`rounds 1-2 declare the corpus SHA the #163 record cites (${CORPUS_SHA})`,
	roundSha("round1-as-written") === CORPUS_SHA && roundSha("round2-fixed") === CORPUS_SHA,
	`round1: ${roundSha("round1-as-written") || "(none)"}, round2: ${roundSha("round2-fixed") || "(none)"}`,
);
check(
	"the harness reads the marker rather than carrying a default of its own",
	harness.includes('ROUND_SHA="$(tr -d "[:space:]" < "$PROMPT_DIR/FIXTURE_SHA")"') &&
		harness.includes("must declare its own corpus") &&
		!/^[^#\n]*\b\w*SHA\w*="9b2a16e"/m.test(harness),
	"a hardcoded corpus SHA outside a comment would make the marker advisory",
);
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
const RUNS = "research/spec-reconcile-backtest/runs";
const PROMPTS_DIR = "research/spec-reconcile-backtest/prompts";

// Rounds 1-2 were scored on 2026-08-10, before STATUS.tsv and SCORES.tsv existed. Every
// LATER round must carry both, and their CONTENTS must hold up — an earlier revision bound
// every content check to round 3 by name, so a fabricated round 4 (bogus STATUS.tsv, no
// transcripts, invented counts) passed the whole suite. That is the failure mode this issue
// exists to close, reproduced inside its own gate.
const GRANDFATHERED = new Set(["round1-as-written", "round2-fixed"]);

interface RoundAudit {
	statusText: string;
	rows: string[][];
	scores: string[][];
	rowFor(arm: string): string[] | undefined;
}

function auditRound(round: string): RoundAudit {
	const statusText = safeRead(`${RUNS}/${round}/STATUS.tsv`);
	const rows = statusText
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("auditor\t"))
		.map((l) => l.split("\t"));
	const scores = safeRead(`${RUNS}/${round}/SCORES.tsv`)
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("arm\t"))
		.map((l) => l.split("\t"));
	return { statusText, rows, scores, rowFor: (arm) => rows.find((c) => c[0] === arm) };
}

const scoredRounds = rounds.filter((r) => !GRANDFATHERED.has(r));
check(
	"there is at least one non-grandfathered round to check — otherwise this section is vacuous",
	scoredRounds.length > 0,
);

for (const round of scoredRounds) {
	const a = auditRound(round);
	const promptCount = fs.existsSync(path.join(REPO, PROMPTS_DIR, round))
		? fs.readdirSync(path.join(REPO, PROMPTS_DIR, round)).filter((f) => f.endsWith(".txt")).length
		: 0;

	check(
		`${round}: STATUS.tsv header records round, corpus SHA, overlay and auditor count`,
		new RegExp(
			`^# round=${round} fixture_sha=\\S+ model=\\S+ host_overlay=(yes|no) auditors=\\d+$`,
			"m",
		).test(a.statusText),
		a.statusText.split("\n")[0] ?? "(empty)",
	);
	check(
		`${round}: STATUS.tsv's corpus SHA is the one the round's own marker declares`,
		a.statusText.includes(`fixture_sha=${roundSha(round)}`) && roundSha(round).length > 0,
	);
	check(
		`${round}: one STATUS row per prompt — a partial run must not read as a complete one`,
		promptCount > 0 && a.rows.length === promptCount,
		`${a.rows.length} rows, ${promptCount} prompts`,
	);
	check(
		`${round}: the header's declared auditor count matches the rows present`,
		a.rows.length === Number(/auditors=(\d+)/.exec(a.statusText)?.[1] ?? -1),
	);
	check(
		`${round}: every auditor exited 0 — a killed auditor is not a result`,
		a.rows.length > 0 && a.rows.every((c) => c[1] === "0"),
		a.rows.map((c) => c.join(":")).join(" | "),
	);
	for (const row of a.rows) {
		const rel = `${RUNS}/${round}/${row[0]}.md`;
		const onDisk = fs.existsSync(path.join(REPO, rel))
			? fs.statSync(path.join(REPO, rel)).size
			: -1;
		check(
			`${round}/${row[0]}: transcript exists, is worth scoring, and is the size recorded`,
			onDisk >= 200 && onDisk === Number(row[2]),
			`on disk ${onDisk}, recorded ${row[2]}`,
		);
	}
	check(
		`${round}: SCORES.tsv names only arms STATUS.tsv recorded, and covers every one`,
		a.scores.length > 0 &&
			a.scores.every((c) => a.rowFor(c[0]) !== undefined) &&
			a.rows.every((r) => a.scores.some((c) => c[0] === r[0])),
		`status arms ${JSON.stringify(a.rows.map((r) => r[0]))}, score arms ${JSON.stringify([...new Set(a.scores.map((c) => c[0]))])}`,
	);
	check(
		`${round}: every SCORES verdict is one of the three the file documents`,
		a.scores.every((c) => ["surfaced", "not-surfaced", "not-scored"].includes(c[2])),
		JSON.stringify(a.scores.map((c) => c[2])),
	);
	check(
		`${round}: SCORES counts are plausible — scoreable never exceeds labelled`,
		a.scores.every(
			(c) => Number(c[4]) > 0 && Number(c[3]) > 0 && Number(c[4]) <= Number(c[3]),
		),
		JSON.stringify(a.scores.map((c) => `${c[4]}/${c[3]}`)),
	);
}

const status3 = auditRound("round3-host-scope");
const statusRows = status3.rows.map((c) => c.join("\t"));
const statusFor = (arm: string): string[] | undefined => status3.rowFor(arm);
check(
	"round 3 staged the host overlay — F5's validity rests on it",
	status3.statusText.includes("host_overlay=yes"),
);

// The manipulation between the two arms must be scope and nothing else. If they differ
// anywhere but the host-document block, the round measures prompt wording, not scope.
// The stated invariant is bidirectional and positional — "byte-identical apart from one
// block". An exemption predicate ("any C2-only line mentioning host") is looser than that:
// it lets ANY instruction through as long as it contains the word, and cannot see a line
// deleted from C2 or a reordering. So compute the insertion positionally instead: strip the
// common prefix and the common suffix, and whatever is left in the middle IS the block —
// with C1 required to have nothing left over at all.
const promptLines = (n: string): string[] | null => {
	const rel = `research/spec-reconcile-backtest/prompts/round3-host-scope/${n}.txt`;
	return fs.existsSync(path.join(REPO, rel)) ? readRepo(rel).split("\n") : null;
};
const c1Lines = promptLines("C1-guardrails-repo-only-control");
const c2Lines = promptLines("C2-guardrails-host-scoped");

check(
	"both round-3 prompts are readable — a parity check over two missing files is vacuous",
	c1Lines !== null && c2Lines !== null && c1Lines.length > 1,
);

let insertion: string[] = [];
let parity = false;
if (c1Lines && c2Lines && c1Lines.length > 1) {
	let head = 0;
	while (head < c1Lines.length && c1Lines[head] === c2Lines[head]) head++;
	let tail = 0;
	while (
		tail < c1Lines.length - head &&
		c1Lines[c1Lines.length - 1 - tail] === c2Lines[c2Lines.length - 1 - tail]
	)
		tail++;
	// C1 fully consumed by the common prefix + suffix => C2 is C1 with ONE block inserted.
	parity = head + tail === c1Lines.length;
	insertion = c2Lines.slice(head, c2Lines.length - tail);
}
check(
	"C2 is C1 with exactly ONE contiguous block inserted — nothing deleted, nothing reordered",
	parity,
	parity ? "" : "the prompts diverge in more than one place; the round measures wording, not scope",
);
check(
	"that inserted block is the host-document enumeration and nothing else",
	parity &&
		insertion.length > 0 &&
		insertion.some((l) => l.includes("./host/git-projects-CLAUDE.md")) &&
		// RUBRIC's Bonus-signal row forbids an instruction aimed at the F5 sentence. A loose
		// /host/i predicate would let "report the exact verbatim sentence from ./host/..."
		// straight through, so match the block's known shape instead.
		insertion.every(
			(l) =>
				l.trim() === "" ||
				l.includes("artifact set is not the diff") ||
				/^\s*\.\/host\/\S+\s+\(.*\)\s*$/.test(l),
		) &&
		!/verbatim|exact sentence|quote the exact/i.test(insertion.join(" ")),
	JSON.stringify(insertion.filter((l) => l.trim() && !/host|artifact set is not the diff/i.test(l))),
);
check(
	`round 3 declares ${F5_SHA} as its corpus`,
	roundSha("round3-host-scope") === F5_SHA,
);
check(
	"every round directory declares its own corpus SHA — the rule RUBRIC states",
	rounds.length >= 3 &&
		rounds.every((r) => fs.existsSync(path.join(PROMPT_ROOT, r, "FIXTURE_SHA"))),
	`rounds without FIXTURE_SHA: ${JSON.stringify(rounds.filter((r) => !fs.existsSync(path.join(PROMPT_ROOT, r, "FIXTURE_SHA"))))}`,
);
check(
	"the harness refuses to overwrite a completed run",
	harness.includes("already holds a completed run") && harness.includes('"${OVERWRITE:-0}"'),
);
check(
	"the harness ships an exit-code table and a --help that prints it",
	harness.includes("# exit codes:") && harness.includes("-h|--help") && harness.includes("#   4  refused"),
);
check(
	"a round with no FIXTURE_SHA marker is refused rather than run against a guessed corpus",
	harness.includes("a round must declare its own corpus"),
);
check(
	"a round with transcripts but no STATUS.tsv is a LEGACY RECORD, not wreckage to delete",
	harness.includes("Legacy record iff transcripts are present") &&
		harness.includes("holds a legacy completed run"),
);
check(
	"a run interrupted mid-way cannot masquerade as complete — the header declares the count",
	harness.includes("auditors=%s") && harness.includes('-eq "$declared"'),
);
check(
	"output-setup failures report as a corpus problem, not as 'an auditor failed'",
	harness.includes("could not create the output directory") && harness.includes("could not write $STATUS"),
);
check(
	"the refusal says what the predicate actually tests — a completed run, not a scored one",
	harness.includes("Whether anyone SCORED it lives in SCORES.tsv") &&
		!harness.includes("already holds a SCORED record"),
);
check(
	"a malformed exit column counts as a failed row, not a clean auditor",
	harness.includes('$2 !~ /^[0-9]+$/'),
);
check(
	"replacing a round clears SCORES.tsv too, so no verdict outlives its transcripts",
	harness.includes('rm -f "$OUT"/*.md "$OUT"/STATUS.tsv "$OUT"/SCORES.tsv'),
);
check(
	"an unreadable transcript is recorded as a failed auditor rather than aborting the loop",
	harness.includes("produced no readable transcript"),
);
check(
	"overlay staging failures report as a corpus problem (exit 3), not as an auditor failure",
	harness.includes("could not stage the host overlay"),
);
check(
	"git archive's own diagnosis survives, rather than being replaced by a guess",
	harness.includes('cat "$WORK/archive.err"'),
);
check(
	"whether OUT holds a record is decided by STATUS.tsv, never by grepping transcript text",
	harness.includes("holds_record()") && !harness.includes("grep -rlq"),
);
check(
	"the corpus extraction is checked, and reports a corpus failure rather than tar's own code",
	harness.includes("git archive $FIXTURE_SHA failed") && harness.includes("could not extract the corpus"),
);
check(
	"an auditor that exits 0 having written almost nothing is recorded as a failure",
	harness.includes("not a scoreable transcript") &&
		harness.includes("wrote fewer than 200 bytes"),
);
check(
	"the corpus is archived from the clone the prompts live in, not the caller's cwd",
	harness.includes('git -C "$HERE" rev-parse --show-toplevel'),
);
check(
	"an env FIXTURE_SHA that contradicts the round's marker is refused",
	harness.includes("contradicts round") && harness.includes("OVERRIDE_SHA"),
);

// (Agent-First Output, #383 review) The per-fixture verdict was prose only, so a rescoring
// or a miscount was invisible to `bun run test`. SCORES.tsv is the structured surface; this
// asserts it agrees with the prose that quotes it.
const scoresText = safeRead(`${R3}/SCORES.tsv`);
const scoreRows = status3.scores;
const scoreOf = (arm: string, fixture: string): string[] | undefined =>
	scoreRows.find((c) => c[0] === arm && c[1] === fixture);

const missingArtifacts = scoredRounds.filter(
	(r) =>
		!fs.existsSync(path.join(REPO, `${RUNS}/${r}/STATUS.tsv`)) ||
		!fs.existsSync(path.join(REPO, `${RUNS}/${r}/SCORES.tsv`)),
);
check(
	"every non-grandfathered round ships both STATUS.tsv and SCORES.tsv",
	missingArtifacts.length === 0,
	`rounds missing them: ${JSON.stringify(missingArtifacts)}`,
);

check(
	"round 3 publishes a machine-readable per-fixture verdict",
	scoreRows.length >= 2 && scoresText.includes("round=round3-host-scope"),
);
check(
	"SCORES.tsv: the host-scoped arm surfaced F5",
	scoreOf("C2-guardrails-host-scoped", "F5")?.[2] === "surfaced",
);
check(
	"SCORES.tsv: the control did NOT — which is the result, not a miss",
	scoreOf("C1-guardrails-repo-only-control", "F5")?.[2] === "not-surfaced",
);
{
	// The counts RUBRIC quotes in prose must be the counts SCORES.tsv publishes — per arm
	// AND as the cross-arm totals, since a total is a third place the numbers can drift.
	const rubric = safeRead("research/spec-reconcile-backtest/RUBRIC.md");
	const c1 = scoreOf("C1-guardrails-repo-only-control", "F5");
	const c2 = scoreOf("C2-guardrails-host-scoped", "F5");
	check(
		"RUBRIC's prose counts match SCORES.tsv, so a rescoring cannot drift from the record",
		!!c1 &&
			!!c2 &&
			rubric.includes(`${c1[4]} scoreable findings`) &&
			rubric.includes(`${c2[4]} scoreable findings`) &&
			rubric.includes(`${c1[3]} labelled`) &&
			rubric.includes(`${c2[3]} labelled`),
		`SCORES: C1 ${c1?.[4]}/${c1?.[3]}, C2 ${c2?.[4]}/${c2?.[3]}`,
	);
	check(
		"RUBRIC's cross-arm total is the LABELLED total, computed from SCORES.tsv",
		!!c1 && !!c2 && rubric.includes(`${Number(c1[3]) + Number(c2[3])} labelled findings across both arms`),
		`expected ${Number(c1?.[3]) + Number(c2?.[3])} labelled across both arms`,
	);
	// The skill quotes the control's pair too. Whitespace-collapsed, because a reflow of
	// that paragraph is not a regression — the same reason the CLAUSES loop uses flat().
	check(
		"the skill's quoted counts match SCORES.tsv as well",
		!!c1 && flatSkill.includes(flat(`${c1[4]} scoreable findings (${c1[3]} labelled)`)),
		`skill must carry "${c1?.[4]} scoreable findings (${c1?.[3]} labelled)"`,
	);
}

check(
	"RUBRIC records F5 and its own SHA, so the record stays third-party checkable",
	(() => {
		const r = safeRead("research/spec-reconcile-backtest/RUBRIC.md");
		return r.includes("## F5 —") && r.includes(F5_SHA);
	})(),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
