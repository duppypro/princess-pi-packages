// Every shipped script in bin/ answers `-h`/`--help` and `--version`, refuses an
// unknown flag, and reaches the network on none of those paths (#362).
//
// Why family-wide rather than a fix pinned to one script: `pr-threads` was the
// ONLY member of the pr-* family without `--help`, and it went unnoticed through
// #310 — the issue that added the flag everywhere else. A test naming
// `pr-threads` would close that one hole and let the next added script repeat it.
//
// WHY THIS RUNS IN A SANDBOX — this suite's own incident, worth keeping:
// the first version drove the real scripts in the real repo with live `gh` auth.
// A spec-reconcile auditor probing whether its assertions were vacuous ran
// `pr-reject --zzz-unknown`; `bin/pr-reject` had no `-*` guard, took the unknown
// flag as the close REASON, found the branch's PR and CLOSED it (PR #364, open
// for two seconds). The lesson is not "be careful with probes" — it is that a
// suite exercising argument handling on scripts that mutate GitHub must not be
// able to reach GitHub at all. So:
//
//   - `gh` is stubbed to LOG ITS ARGV AND FAIL. A help/version/usage path must
//     never invoke it, and the log being empty is asserted, not assumed. This
//     is the assertion the incident earns: it fails loudly if a help path ever
//     grows a `gh` call, instead of quietly closing someone's PR.
//   - the repo is a throwaway `git init` with NO `origin`, so a fall-through to
//     push/fetch dies locally rather than touching a real remote.
//   - proving this suite RED is therefore safe, which matters because the
//     unknown-flag assertions below were red by design until the `-*` guards
//     landed.
//
// Assertions are written to be non-vacuous. The earlier version's exit-0 checks
// passed for `git-overview`, `pr-open` and `pr-reject` even with their flag arms
// deleted — `git-overview` and `pr-open` because their `case` had no arm at all
// for an unmatched argument (it fell through and the script RAN), `pr-reject`
// because its `*) REASON="$1"` arm swallowed the flag as the close reason. The
// unknown-flag check is what distinguishes "answers --help" from "ignores every
// argument"; without it the rest of this file proves nothing for those three.
//
// Scope: executables directly in bin/, excluding `*.mjs` and `*.ts`. Discovered
// from disk and CROSS-CHECKED against install-workflow-tools' own SCRIPTS array,
// so drift in either direction fails here by name rather than silently shrinking
// the tested set.
//
// Run with: bun run test shipped-script-help

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(REPO_ROOT, "bin");
const INSTALLER = path.join(BIN, "install-workflow-tools");

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

/** Shipped scripts: executable, directly in bin/, not a generated or source file. */
function shippedScripts(): string[] {
	return fs
		.readdirSync(BIN)
		.filter((n) => !n.startsWith(".") && !n.endsWith(".mjs") && !n.endsWith(".ts"))
		.filter((n) => {
			const p = path.join(BIN, n);
			// lstat, not stat: stat follows symlinks and THROWS on a dangling one,
			// which would crash the suite instead of failing a check.
			const st = fs.lstatSync(p);
			if (st.isSymbolicLink()) return false;
			return st.isFile() && (st.mode & 0o111) !== 0;
		})
		.sort();
}

/** The installer's own SCRIPTS array — the authoritative deploy set. */
function installerScripts(): string[] {
	const src = fs.readFileSync(INSTALLER, "utf8");
	const m = src.match(/^SCRIPTS=\(([\s\S]*?)\)$/m);
	if (!m) return [];
	return m[1]
		.split("\n")
		.map((l) => l.replace(/#.*$/, "").trim())
		.filter(Boolean)
		.flatMap((l) => l.split(/\s+/))
		.map((s) => s.replace(/^["']|["']$/g, ""))
		.filter(Boolean)
		.sort();
}

/**
 * A throwaway git repo with a stub `gh` on PATH that logs argv and FAILS.
 * No `origin` remote: a fall-through to fetch/push dies locally.
 */
function sandbox() {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "help-contract-")));
	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	execFileSync("git", ["init", "-q", "-b", "362-sandbox"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env: gitEnv });

	const binDir = path.join(dir, "stubbin");
	fs.mkdirSync(binDir);
	const ghLog = path.join(dir, "gh.log");
	fs.writeFileSync(ghLog, "");
	// Fails loudly. Any script that calls it on a help/version/usage path is a bug.
	fs.writeFileSync(
		path.join(binDir, "gh"),
		`#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\necho "stub gh: refusing (this path must not call gh)" >&2\nexit 1\n`,
		{ mode: 0o755 },
	);
	return { dir, binDir, ghLog };
}

const SB = sandbox();

function run(script: string, args: string[]) {
	return spawnSync(path.join(BIN, script), args, {
		encoding: "utf8",
		timeout: 15_000,
		cwd: SB.dir,
		env: {
			...process.env,
			PATH: `${SB.binDir}${path.delimiter}${process.env.PATH}`,
			// Unset, not empty: `gh` treats an empty GH_TOKEN as absent and falls
			// back to the keyring, and `[[ -v GH_TOKEN ]]` sees empty as PRESENT.
			// The repo's own convention is `env -u`, and this mirrors it.
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
		},
	});
}

function ghCalls(): string {
	return fs.readFileSync(SB.ghLog, "utf8").trim();
}

/**
 * The usage-error exit code each script uses.
 *
 * ONE documented exception, and it is policy rather than an accident (#366): the
 * split follows WHO RUNS THE SCRIPT. `install-workflow-tools` is the one script a
 * human runs from a shell, where `sysexits.h` `EX_USAGE` (64) is the local
 * convention; every other script here is agent-called and speaks the #224 table's
 * usage code, 2. `git-checkpoint` used to exit 1 — agent-called and in the family,
 * so #366 moved it to 2 and updated the spec row that documented the 1.
 *
 * Kept as a named allowlist rather than a loosened assertion (`status !== 0`): an
 * allowlist keeps the divergence countable, a loose check hides it.
 */
const EXIT2_EXEMPT: Record<string, number> = {
	"install-workflow-tools": 64,
};
const usageExit = (s: string): number => EXIT2_EXEMPT[s] ?? 2;

const SCRIPTS = shippedScripts();
const DECLARED = installerScripts();

console.log(`shipped-script help/version/usage contract (#362) — ${SCRIPTS.length} scripts`);

// The discovered set IS the installer's deploy set. Named-mismatch, not a floor:
// `>= 10` would still pass after deleting pr-threads and adding two unrelated files.
check(
	JSON.stringify(SCRIPTS) === JSON.stringify(DECLARED),
	"discovered bin/ set == install-workflow-tools' SCRIPTS array",
	`discovered: ${SCRIPTS.join(", ")}\ndeclared:   ${DECLARED.join(", ")}`,
);

for (const s of SCRIPTS) {
	for (const flag of ["-h", "--help"]) {
		const r = run(s, [flag]);
		const text = `${r.stdout || ""}${r.stderr || ""}`;
		check(r.status === 0, `${s} ${flag} → exit 0`,
			`got exit ${r.status}; stderr: ${(r.stderr || "").trim().slice(0, 160)}`);
		// stdout only: several scripts emit unrelated warnings on stderr, and
		// counting those toward "substantive help" let an error path satisfy it.
		const lines = (r.stdout || "").split("\n").filter((l) => l.trim() !== "");
		check(lines.length >= 2, `${s} ${flag} → prints substantive help on stdout (2+ lines)`,
			`got ${lines.length} non-empty stdout line(s): ${JSON.stringify((r.stdout || "").slice(0, 160))}`);
		check(text.includes("--version"), `${s} ${flag} → help documents --version`,
			"the flag is implemented but the script's own help never names it");
	}

	const v = run(s, ["--version"]);
	check(v.status === 0, `${s} --version → exit 0`,
		`got exit ${v.status}; stderr: ${(v.stderr || "").trim().slice(0, 160)}`);
	// The exact resolved path, not merely "something" — a weaker check would not
	// notice --version printing an unrelated string.
	check((v.stdout || "").trim() === fs.realpathSync(path.join(BIN, s)),
		`${s} --version → prints its own resolved path`,
		`got ${JSON.stringify((v.stdout || "").trim())}`);

	// The assertion that makes the rest non-vacuous: without it, "answers --help"
	// is indistinguishable from "ignores every argument".
	// Non-zero alone is NOT enough, and assuming it was is how this suite nearly
	// shipped vacuous a second time: in the sandbox `pr-open` exited 3 ("worktree
	// not clean") and `pr-cleanup` exited 4 ("no main worktree") — both failing
	// for reasons that have nothing to do with the flag, while still having no
	// `-*` guard. Require the #224 usage code AND the flag named in the message,
	// so the refusal is provably ABOUT the flag.
	const u = run(s, ["--zzz-unknown-flag"]);
	const utext = `${u.stdout || ""}${u.stderr || ""}`;
	const wantExit = usageExit(s);
	check(u.status === wantExit, `${s} --zzz-unknown-flag → exit ${wantExit}${wantExit === 2 ? " (usage, per #224)" : " (documented exception, #366)"}`,
		`got exit ${u.status}; a non-${wantExit} non-zero here means it failed for an unrelated ` +
		`reason and the flag still fell through. stderr: ${(u.stderr || "").trim().slice(0, 160)}`);
	check(utext.includes("--zzz-unknown-flag"), `${s} --zzz-unknown-flag → names the flag it refused`,
		`message never quotes the offending argument: ${JSON.stringify(utext.slice(0, 160))}`);
}

// The incident assertion. None of the paths above may reach GitHub.
check(ghCalls() === "", "no help/version/usage path invoked gh",
	`stub gh recorded:\n${ghCalls()}`);

// --- #367: argument handling, round 2 ----------------------------------------
// #362 closed the unknown-FLAG hole. Three adjacent holes stayed open, and each
// is the same shape as the incident above: an argument the caller typed being
// silently dropped or silently repurposed, with the script proceeding anyway.
//
// 1. POSITIONALS a script does not take were ignored. `pr-open some-other-branch`
//    opened the PR for the CURRENT branch — the #209 shape, acting on a different
//    target than the caller named.
// 2. OPTION VALUES were unguarded. `pr-reject -b --json` took "--json" as the
//    branch and went on to talk to GitHub with it.
// 3. The `--` escape took exactly ONE word, so a multi-word reason was truncated.
//
// Each assertion below names the offending argument as well as checking the exit
// code, for the same reason the unknown-flag check does: a script that refuses for
// an unrelated reason (no origin, dirty worktree) would otherwise satisfy it.

console.log("\n#367 argument handling — positionals, option values, -- escape");

// --- 1. unexpected positionals ------------------------------------------------
// Every script is listed. The two variadic ones carry an empty array WITH a reason,
// so "this script was never checked" cannot hide as "this script has no entry".
const UNEXPECTED_POSITIONAL: Record<string, string[]> = {
	"git-checkpoint": ["a message", "zzz-unexpected"], // a message is ONE argument; quote it
	"git-overview": ["zzz-unexpected"],
	"herdr-reap": ["zzz-unexpected"],
	"herdr-tab": ["/tmp", "a-label", "zzz-unexpected"],
	"iarts-mirror": ["zzz-unexpected"], // takes no arguments AT ALL, like pr-open
	"install-workflow-tools": ["zzz-unexpected"],
	"pr-cleanup": ["some-branch", "zzz-unexpected"],
	"pr-guard": ["some-branch", "zzz-unexpected"], // exactly one branch name
	"pr-merge": ["some-branch", "zzz-unexpected"],
	"pr-open": ["zzz-unexpected"], // takes no arguments AT ALL — the #209 shape
	"pr-review": ["zzz-unexpected"], // flags only; no positional arguments (#377)
	"pr-reject": [], // variadic: the reason is free text, joined — see section 3
	"pr-threads": ["1", "owner/repo", "zzz-unexpected"],
	"repo-gate": [], // variadic: an explicit list of repos to check
	"wt-new": ["1-a-slug", "zzz-unexpected"],
};
check(
	JSON.stringify(Object.keys(UNEXPECTED_POSITIONAL).sort()) === JSON.stringify(SCRIPTS),
	"every shipped script has a declared positional-arity case",
	`declared: ${Object.keys(UNEXPECTED_POSITIONAL).sort().join(", ")}\nshipped:  ${SCRIPTS.join(", ")}`,
);
for (const s of SCRIPTS) {
	const args = UNEXPECTED_POSITIONAL[s] ?? [];
	if (args.length === 0) continue;
	const r = run(s, args);
	const text = `${r.stdout || ""}${r.stderr || ""}`;
	check(r.status === usageExit(s), `${s} ${args.join(" ")} → exit ${usageExit(s)} (unexpected positional)`,
		`got exit ${r.status}; an ignored positional means the script acted on a target the caller did not name. ` +
		`stderr: ${(r.stderr || "").trim().slice(0, 160)}`);
	check(text.includes("zzz-unexpected"), `${s} → names the unexpected argument it refused`,
		`message never quotes the offending argument: ${JSON.stringify(text.slice(0, 200))}`);
}

// --- 1b. -h/--help/--version are terminal -------------------------------------
// `pr-cleanup --version extra-arg` printed the path and exited 0, ignoring the
// extra word — while bin/pr-cleanup's own header has called extra arguments a
// usage error since #221. Same silent-drop shape as 1, and the one instance #367
// names by script. Family-wide because "which flag happens to be checked first"
// is not a contract: every script's help/version path short-circuits, so every
// script had the hole.
for (const s of SCRIPTS) {
	for (const flag of ["--help", "--version"]) {
		const r = run(s, [flag, "zzz-unexpected"]);
		const text = `${r.stdout || ""}${r.stderr || ""}`;
		check(r.status === usageExit(s), `${s} ${flag} zzz-unexpected → exit ${usageExit(s)} (terminal flag)`,
			`got exit ${r.status}; exit 0 here means the extra argument was ignored. ` +
			`stdout: ${(r.stdout || "").trim().slice(0, 120)}`);
		check(text.includes("zzz-unexpected"), `${s} ${flag} zzz-unexpected → names the ignored argument`,
			`message never quotes it: ${JSON.stringify(text.slice(0, 200))}`);
	}
	// The `--` escape still reaches the value: a script whose argument may
	// legitimately read `--version` must stay usable.
	const esc = run(s, ["--", "--version"]);
	check(esc.status !== 0 || (esc.stdout || "").trim() !== fs.realpathSync(path.join(BIN, s)),
		`${s} -- --version → treats it as a value, not the flag`,
		"the terminal-flag scan must stop at `--`, or an escaped value is unreachable");
}

// --- 2. a flag's value that is itself a flag ----------------------------------
// Refused unless it follows `--`. `pr-threads --resolve` has guarded this since
// PR #314; the rest of the family did not. GitHub node ids, branch names, repo
// names and paths never start with a dash, so this cannot reject valid input.
const DASH_LEADING_VALUE: Array<[string, string[]]> = [
	["pr-reject", ["-b", "--json"]],
	["pr-reject", ["--branch", "--json"]],
	["pr-threads", ["5", "--resolve", "--json"]], // already green — guards the regression
	["repo-gate", ["--policy", "--json"]],
	["repo-gate", ["--remedy", "--json"]],
	["herdr-tab", ["/tmp", "--json"]], // the mirror asymmetry: cwd guarded, LABEL not
];
for (const [s, args] of DASH_LEADING_VALUE) {
	const r = run(s, args);
	const text = `${r.stdout || ""}${r.stderr || ""}`;
	check(r.status === usageExit(s), `${s} ${args.join(" ")} → exit ${usageExit(s)} (flag-shaped value)`,
		`got exit ${r.status}; a swallowed flag reaching a lookup is the #364 class. ` +
		`stderr: ${(r.stderr || "").trim().slice(0, 160)}`);
	check(text.includes("--json"), `${s} ${args[0]} → names the flag-shaped value it refused`,
		`message never quotes the offending value: ${JSON.stringify(text.slice(0, 200))}`);
}

// --- 2b. an EMPTY value is a missing value ------------------------------------
// macroscopeapp on PR #370, and it was right: the round-2 guards replaced each
// flag's emptiness check with an arity + dash-shape check and dropped the
// emptiness half. `pr-reject -b ""` then passed every guard, left BRANCH empty,
// and fell through to cwd discovery — closing the CURRENT branch's PR while the
// caller had explicitly named a branch. That is #209 and #364 in one, reintroduced
// by the fix for them. Verified live before this test existed, the expensive way:
// it closed PR #370.
//
// The empty string is the hole every "looks like a flag?" check has, because it
// looks like nothing at all. Checked family-wide rather than on the three scripts
// the reviewer named.
const EMPTY_VALUE: Array<[string, string[], string]> = [
	["pr-reject", ["-b", ""], "-b"],
	["pr-reject", ["--branch", ""], "--branch"],
	["repo-gate", ["--policy", ""], "--policy"],
	["repo-gate", ["--remedy", ""], "--remedy"],
	["pr-threads", ["5", "--resolve", ""], "--resolve"],
	["herdr-tab", ["", "a-label"], ""],
	["herdr-tab", ["/tmp", ""], ""],
	["git-overview", [""], ""],
	["pr-open", [""], ""],
	["pr-cleanup", [""], ""],
	["pr-merge", [""], ""],
	["wt-new", [""], ""],
];
for (const [s, args, flag] of EMPTY_VALUE) {
	const r = run(s, args);
	const shown = args.map((a) => (a === "" ? '""' : a)).join(" ");
	check(r.status === usageExit(s), `${s} ${shown} → exit ${usageExit(s)} (empty is missing)`,
		`got exit ${r.status}; an accepted empty value falls through to whatever the script ` +
		`discovers from cwd, which is the wrong-target shape. stderr: ${(r.stderr || "").trim().slice(0, 160)}`);
	if (flag) {
		const text = `${r.stdout || ""}${r.stderr || ""}`;
		check(text.includes(flag), `${s} ${flag} "" → names the flag whose value was empty`,
			`message never quotes it: ${JSON.stringify(text.slice(0, 160))}`);
	}
}

// --- 3. the reason survives whole ---------------------------------------------
// Asserted on the recorded `gh` argv, not on the script's own echo — the argv is
// what actually reaches the PR. Needs a gh that ANSWERS the two lookups before
// `gh pr close`, so this gets its own sandbox with its own log; the incident
// assertion above still governs SB, where gh must never be called at all.
function scriptedGhSandbox() {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "reason-argv-")));
	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	execFileSync("git", ["init", "-q", "-b", "367-sandbox"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env: gitEnv });
	const binDir = path.join(dir, "stubbin");
	fs.mkdirSync(binDir);
	const ghLog = path.join(dir, "gh.log");
	fs.writeFileSync(ghLog, "");
	// Answers `repo view` and `pr list` so the run REACHES `gh pr close`, records
	// every argv, and fails the close itself — the PR is never really touched, and
	// pr-reject exits 5 (remote failure) rather than 0. Still no network: the repo
	// has no origin and `gh` here is this stub.
	fs.writeFileSync(
		path.join(binDir, "gh"),
		`#!/usr/bin/env bash\n` +
			`printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\n` +
			`case "$1 $2" in\n` +
			`  "repo view") echo "test-owner"; exit 0 ;;\n` +
			`  "pr list")   echo "42"; exit 0 ;;\n` +
			`esac\n` +
			`echo "stub gh: close refused (test)" >&2\nexit 1\n`,
		{ mode: 0o755 },
	);
	return { dir, binDir, ghLog };
}
const RS = scriptedGhSandbox();
function rejectWith(args: string[]): string {
	fs.writeFileSync(RS.ghLog, "");
	spawnSync(path.join(BIN, "pr-reject"), args, {
		encoding: "utf8",
		timeout: 15_000,
		cwd: RS.dir,
		env: {
			...process.env,
			PATH: `${RS.binDir}${path.delimiter}${process.env.PATH}`,
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
		},
	});
	const lines = fs.readFileSync(RS.ghLog, "utf8").trim().split("\n").filter(Boolean);
	return lines[lines.length - 1] ?? "";
}

const WANT = "pr close 42 --comment -1, multi word reason";
// Quoted: one argv word. Green before #367 — this guards it.
check(rejectWith(["--", "-1, multi word reason"]) === WANT,
	'pr-reject -- "-1, multi word reason" → full reason reaches gh',
	`gh argv was ${JSON.stringify(rejectWith(["--", "-1, multi word reason"]))}`);
// Unquoted after `--`: four argv words. `REASON="${1:-}"` kept only "-1,".
check(rejectWith(["--", "-1,", "multi", "word", "reason"]) === WANT,
	"pr-reject -- -1, multi word reason → all words survive, joined",
	`gh argv was ${JSON.stringify(rejectWith(["--", "-1,", "multi", "word", "reason"]))}`);
// Unquoted with no `--`: the old `*) REASON="$1"` arm kept only the LAST word.
check(rejectWith(["multi", "word", "reason"]) === "pr close 42 --comment multi word reason",
	"pr-reject multi word reason → all words survive, joined",
	`gh argv was ${JSON.stringify(rejectWith(["multi", "word", "reason"]))}`);

fs.rmSync(RS.dir, { recursive: true, force: true });

fs.rmSync(SB.dir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "✅" : "❌"} shipped-script help/version/usage: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
