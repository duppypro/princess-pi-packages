// --- pr-merge / pr-reject: branch selection and PR lookup (#209) ---
//
// Drives the REAL bin/pr-merge and bin/pr-reject inside throwaway git repos,
// with a stub `gh` first on PATH that records its argv and answers `pr list`
// from a fixture. The recorded argv IS the assertion: these scripts exist to
// pick the right PR, so "which PR number did it act on" is the whole contract.
//
// Why a stub and not a mock of the scripts: every defect here is about argument
// handling in bash — `$1` being silently consumed as the wrong variable cannot
// be reproduced by anything that does not actually run bash.
//
// Run with: bun run test pr-scripts-args

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PR_MERGE = path.join(REPO_ROOT, "bin", "pr-merge");
const PR_REJECT = path.join(REPO_ROOT, "bin", "pr-reject");

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

// ---
// Fixtures
// ---

interface PrRow {
	number: number;
	headRefName: string;
	/** owner of the repo the head branch lives in — differs for fork PRs */
	headOwner: string;
}

/** Knobs for the sandbox's stubbed environment. Defaults describe a happy path. */
interface SandboxOpts {
	ownerLogin?: string;
	/** `gh pr list` fails — a network/auth error, not "no PR found". */
	failGhList?: boolean;
	/** `gh repo view` fails — a network/auth error before the PR is even looked up. */
	failGhRepoView?: boolean;
	/** `gh pr close` fails — e.g. permission denied, after the PR is selected. */
	failGhClose?: boolean;
	/**
	 * Exit status the stubbed `pr-threads` returns. Its contract (see
	 * bin/pr-threads' header): 0 = clean, 1 = checked and found a problem,
	 * anything else = the check itself could not run.
	 */
	threadsStatus?: number;
	threadsOutput?: string;
	/**
	 * headRefOid returned by successive `gh pr view` calls. pr-merge resolves
	 * the head TWICE — once before the pr-threads gate, once immediately
	 * before merging — and refuses when they differ (the #258 TOCTOU guard).
	 * One entry means a branch that never moved; two means it moved mid-verify.
	 */
	headOids?: string[];
}

/** A repo on `branch`, plus stub `gh` and `pr-threads` on PATH. */
function sandbox(branch: string, rows: PrRow[], opts: SandboxOpts = {}) {
	const {
		ownerLogin = "duppypro",
		failGhList = false,
		failGhRepoView = false,
		failGhClose = false,
		threadsStatus = 0,
		threadsOutput = "✅ 0 unresolved conversations (0 total)",
		headOids = ["a".repeat(40)],
	} = opts;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-args-"));
	execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir });
	execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
		cwd: dir,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});

	const binDir = path.join(dir, "stubbin");
	fs.mkdirSync(binDir);
	const argvLog = path.join(dir, "argv.log");
	fs.writeFileSync(argvLog, "");
	fs.writeFileSync(
		path.join(dir, "prlist.json"),
		JSON.stringify(
			rows.map((r) => ({
				number: r.number,
				headRefName: r.headRefName,
				headRepositoryOwner: { login: r.headOwner },
			})),
		),
	);

	// `gh pr view --json headRefOid` is answered from this file, one line per
	// call, last line repeating — so a single entry is a stable head and two
	// entries are a head that moved between pr-merge's two resolutions.
	const headOidFile = path.join(dir, "headoids");
	const headOidCounter = path.join(dir, "headoid.n");
	fs.writeFileSync(headOidFile, `${headOids.join("\n")}\n`);

	// The stub must behave like real gh in the two ways the scripts depend on:
	// filter by --head, and APPLY --jq to the result. Honouring --jq is not
	// optional — a stub that dumps raw JSON makes `--jq '.[0].number'` return a
	// whole array, and assertions like "acted on PR 7" then pass on a substring
	// of unrelated JSON rather than on the script's selection logic.
	const gh = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}
head=""
jqexpr=""
prev=""
for a in "$@"; do
  case "$prev" in
    --head) head="$a" ;;
    --jq|-q) jqexpr="$a" ;;
  esac
  prev="$a"
done
case "$1 $2" in
  "repo view")
    ${failGhRepoView ? 'echo "gh: could not connect to api.github.com" >&2; exit 1' : ""}
    out='{"owner":{"login":"${ownerLogin}"},"nameWithOwner":"${ownerLogin}/princess-pi-packages"}'
    if [ -n "$jqexpr" ]; then printf '%s' "$out" | jq -r "$jqexpr"; else printf '%s\\n' "$out"; fi
    exit 0 ;;
  "pr list")
    ${failGhList ? 'echo "gh: could not connect to api.github.com" >&2; exit 1' : ":"}
    filtered=$(jq -c --arg h "$head" '[.[] | select($h == "" or .headRefName == $h)]' ${JSON.stringify(path.join(dir, "prlist.json"))})
    if [ -n "$jqexpr" ]; then printf '%s' "$filtered" | jq -r "$jqexpr"; else printf '%s\\n' "$filtered"; fi
    exit 0 ;;
  "pr close")
    ${failGhClose ? 'echo "gh: permission denied closing PR" >&2; exit 1' : ""}
    exit 0 ;;
  "pr view")
    # #349: pr-merge now also asks the server whether it will accept the merge.
    # That is a different --json request than headRefOid and must NOT consume a
    # headoid line, or a mergeability query would look like a head that moved.
    case "$*" in
      *mergeable*)
        out='{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
        if [ -n "$jqexpr" ]; then printf '%s' "$out" | jq -r "$jqexpr"; else printf '%s\\n' "$out"; fi
        exit 0 ;;
    esac
    n=$(cat ${JSON.stringify(headOidCounter)} 2>/dev/null || echo 0)
    n=$((n + 1))
    printf '%s' "$n" > ${JSON.stringify(headOidCounter)}
    oid=$(sed -n "\${n}p" ${JSON.stringify(headOidFile)})
    [ -n "$oid" ] || oid=$(tail -n1 ${JSON.stringify(headOidFile)})
    out="{\\"headRefOid\\":\\"$oid\\"}"
    if [ -n "$jqexpr" ]; then printf '%s' "$out" | jq -r "$jqexpr"; else printf '%s\\n' "$out"; fi
    exit 0 ;;
esac
exit 0
`;
	fs.writeFileSync(path.join(binDir, "gh"), gh);
	fs.chmodSync(path.join(binDir, "gh"), 0o755);

	// --- pr-threads stub (#279) ---------------------------------------------
	// pr-merge execs `pr-threads` by BARE NAME (bin/pr-merge:137), so without a
	// stub here it resolved to the host's ~/bin/pr-threads — a different binary
	// the gh stub never intercepts. That copy then queried the real GitHub API
	// for the fixture's PR #42, got "not found", exited 4, and pr-merge
	// correctly refused to merge blind. Every pr-merge case in this suite
	// aborted at the gate and asserted nothing about the branch selection it
	// was written for, while making a live network call on every run.
	const threadsLog = path.join(dir, "threads.log");
	fs.writeFileSync(threadsLog, "");
	// #349: pr-merge reads pr-threads --json to tell "unresolved threads" apart
	// from "stale review coverage" — one exit code covers both. The document
	// mirrors the real `pr-threads/list@1` shape and must follow this suite's
	// OWN threadsStatus fixture, not report clean unconditionally: exit 1 means
	// unresolved here, and exit 5 means pr-threads fell over before printing
	// anything, which is exactly the distinction pr-merge reads.
	// reviewedHead is a BOOLEAN in the real document (bin/pr-threads:652) — "does
	// a review cover the current head" — not the reviewed sha. Modelling it as a
	// sha here made pr-merge's sha comparison look correct (PR #354 finding).
	const threadsDoc =
		threadsStatus === 1
			? '{"schema":"pr-threads/list@1","unresolvedCount":2,"head":"deadbee","reviewedHead":false,"latestReviewCommit":"0ldc0de","threads":[]}'
			: '{"schema":"pr-threads/list@1","unresolvedCount":0,"head":"deadbee","reviewedHead":true,"latestReviewCommit":"deadbee","threads":[]}';
	const threads = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(threadsLog)}
for a in "$@"; do
  if [ "$a" = "--json" ]; then
    ${threadsStatus === 0 || threadsStatus === 1 ? `printf '%s\\n' ${JSON.stringify(threadsDoc)}` : 'printf "%s\\n" "pr-threads: could not determine review state" >&2'}
    exit ${threadsStatus}
  fi
done
printf '%s\\n' ${JSON.stringify(threadsOutput)}
exit ${threadsStatus}
`;
	fs.writeFileSync(path.join(binDir, "pr-threads"), threads);
	fs.chmodSync(path.join(binDir, "pr-threads"), 0o755);

	return { dir, binDir, argvLog, threadsLog };
}

function run(
	script: string,
	branch: string,
	rows: PrRow[],
	args: string[],
	opts: SandboxOpts = {},
): { code: number; out: string; argv: string[]; threadsArgv: string[] } {
	const { dir, binDir, argvLog, threadsLog } = sandbox(branch, rows, opts);
	let code = 0;
	let out = "";
	try {
		out = execFileSync("bash", [script, ...args], {
			cwd: dir,
			encoding: "utf8",
			// PR_MERGE_RETRY_SLEEP=0 (#349): the mergeability re-query backs off by
			// seconds in real use. Nothing here exercises the retry, so paying the
			// wall-clock for it only makes the suite slow.
			env: {
				...process.env,
				PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
				PR_MERGE_RETRY_SLEEP: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: any) {
		code = err?.status ?? -1;
		out = `${err?.stdout || ""}${err?.stderr || ""}`;
	}
	const argv = fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean);
	const threadsArgv = fs.readFileSync(threadsLog, "utf8").trim().split("\n").filter(Boolean);
	return { code, out, argv, threadsArgv };
}

/** The `gh pr merge <N> …` / `gh pr close <N> …` line the script actually issued. */
function actedOn(argv: string[], verb: string): string | undefined {
	return argv.find((l) => l.startsWith(`pr ${verb} `));
}

const OURS = (n: number, b: string): PrRow => ({ number: n, headRefName: b, headOwner: "duppypro" });
const FORK = (n: number, b: string): PrRow => ({ number: n, headRefName: b, headOwner: "someone-else" });

// ---
// pr-merge
// ---

console.log("pr-merge / pr-reject: branch selection and PR lookup (#209)");
console.log("\npr-merge:");

// 1. The advertised `pr-merge <branch>` form, run from main.
{
	const { code, out, argv } = run(PR_MERGE, "main", [OURS(42, "42-some-feature")], ["42-some-feature"]);
	check(code === 0, "pr-merge <branch> from main → exits 0", `got ${code}, output:\n${out}`);
	check(
		actedOn(argv, "merge")?.includes("42") === true,
		"pr-merge <branch> from main → merges that branch's PR",
		`gh calls:\n${argv.join("\n")}`,
	);
}

// 2. No argument on a feature branch still uses the current branch.
{
	const { code, argv } = run(PR_MERGE, "42-some-feature", [OURS(42, "42-some-feature")], []);
	check(code === 0, "pr-merge (no args) on a feature branch → exits 0", `got ${code}`);
	check(
		actedOn(argv, "merge")?.includes("42") === true,
		"pr-merge (no args) → merges the current branch's PR",
		argv.join("\n"),
	);
}

// 3. Bare `pr-merge` on main is still an error — there is nothing to infer.
{
	const { code, out } = run(PR_MERGE, "main", [OURS(42, "42-some-feature")], []);
	check(code !== 0, "pr-merge (no args) on main → non-zero", `got ${code}`);
	check(/pr-merge <branch>/.test(out), "pr-merge on main → hint names the form that now works", out);
}

// 4. A fork PR sharing the branch name must never be picked.
{
	const { code, out, argv } = run(
		PR_MERGE,
		"fix",
		[FORK(99, "fix"), OURS(7, "fix")],
		[],
	);
	check(code === 0, "same branch name on a fork → still exits 0", `got ${code}, out:\n${out}`);
	check(
		actedOn(argv, "merge")?.includes("7") === true,
		"same branch name on a fork → merges OUR PR (#7), not the fork's (#99)",
		argv.join("\n"),
	);
}

// 5. Only a fork PR matches → refuse rather than merge a stranger's branch.
{
	const { code, out, argv } = run(PR_MERGE, "fix", [FORK(99, "fix")], []);
	check(code !== 0, "only a fork PR matches → non-zero", `got ${code}`);
	check(actedOn(argv, "merge") === undefined, "only a fork PR matches → merges nothing", argv.join("\n"));
	check(/no open PR/i.test(out), "only a fork PR matches → says no PR found", out);
}

// 6. Two of OUR OWN open PRs on one branch name → ambiguous, refuse and name both.
{
	const { code, out, argv } = run(PR_MERGE, "fix", [OURS(7, "fix"), OURS(8, "fix")], []);
	check(code !== 0, "ambiguous match → non-zero", `got ${code}`);
	check(actedOn(argv, "merge") === undefined, "ambiguous match → merges nothing", argv.join("\n"));
	check(/\b7\b/.test(out) && /\b8\b/.test(out), "ambiguous match → names both candidates", out);
}

// 6b. A failed lookup must not masquerade as "no PR found" — the user would go
//     hunting for a missing PR instead of seeing the network/auth error.
{
	const { code, out, argv } = run(PR_MERGE, "fix", [OURS(7, "fix")], [], { failGhList: true });
	check(code !== 0, "gh pr list fails → non-zero", `got ${code}`);
	check(actedOn(argv, "merge") === undefined, "gh pr list fails → merges nothing", argv.join("\n"));
	check(
		/failed/i.test(out) && !/no open PR found/i.test(out),
		"gh pr list fails → reports the failure, not 'no open PR found'",
		out,
	);
}

// ---
// The pr-threads merge gate (#258), reachable for the first time now that
// pr-threads is stubbed (#279). Every case above merged only because the gate
// returned 0; these drive the two refusal paths, which had no coverage at all
// while the host's pr-threads was answering for a fixture PR that never existed.
// ---

console.log("\npr-merge — the pr-threads gate (#258):");

// 6c. The gate is actually consulted, with the PR number pr-merge resolved.
//     This is also the proof that the stub — not the host's ~/bin/pr-threads —
//     answered: a real one would need the argv AND the network.
{
	const { threadsArgv } = run(PR_MERGE, "main", [OURS(42, "42-some-feature")], ["42-some-feature"]);
	check(threadsArgv.length === 1, "pr-merge calls pr-threads exactly once", threadsArgv.join("\n"));
	// `--json` since #349: the human-readable exit code cannot separate
	// "unresolved threads" from "stale review coverage", and only the first
	// blocks. The PR NUMBER is what this case is really pinning.
	check(
		threadsArgv[0]?.trim() === "42 --json",
		"pr-merge passes the resolved PR number to pr-threads",
		threadsArgv.join("\n"),
	);
}

// 6d. pr-threads exit 1 = "checked, and found a problem". Refuse with 6, and
//     say what to fix — this is the branch that gets the actionable framing.
{
	const { code, out, argv } = run(PR_MERGE, "main", [OURS(42, "42-some-feature")], ["42-some-feature"], {
		threadsStatus: 1,
		threadsOutput: "❌ 2 unresolved conversations (3 total)",
	});
	check(code === 6, "unresolved threads → exit 6 (safety gate refused)", `got ${code}, out:\n${out}`);
	check(actedOn(argv, "merge") === undefined, "unresolved threads → merges nothing", argv.join("\n"));
	// Wording changed with #349: the refusal now names the condition it actually
	// found (unresolved conversations) instead of the generic "not clear to merge",
	// which used to cover a stale review too.
	check(
		/unresolved review conversation/i.test(out),
		"unresolved threads → names unresolved conversations as the reason",
		out,
	);
	check(out.includes("2 unresolved conversations"), "unresolved threads → relays pr-threads' own output", out);
}

// 6e. Any OTHER non-zero from pr-threads means the check itself could not run.
//     That is 5, not 6 — "I could not check" and "I checked and it says no" are
//     different answers, and #224 exists because collapsing them loses the one
//     distinction an agent needs. 4 is the status the host's pr-threads was
//     really returning throughout this bug, which makes it the honest fixture.
{
	const { code, out, argv } = run(PR_MERGE, "main", [OURS(42, "42-some-feature")], ["42-some-feature"], {
		threadsStatus: 4,
		threadsOutput: "pr-threads: duppypro/princess-pi-packages #42 not found.",
	});
	check(code === 5, "pr-threads itself fails → exit 5 (state undetermined), not 6", `got ${code}, out:\n${out}`);
	check(actedOn(argv, "merge") === undefined, "pr-threads itself fails → merges nothing", argv.join("\n"));
	check(/could not verify/i.test(out), "pr-threads itself fails → says it could not verify, not 'unresolved'", out);
	check(
		!/unresolved review conversation/i.test(out),
		"pr-threads itself fails → does NOT use the found-a-problem framing",
		out,
	);
}

// 6f. TOCTOU guard: the head moves between the gate and the merge call. The
//     sha about to be merged is one pr-threads never saw, so refuse (6).
{
	const moved = ["a".repeat(40), "b".repeat(40)];
	const { code, out, argv } = run(PR_MERGE, "main", [OURS(42, "42-some-feature")], ["42-some-feature"], {
		headOids: moved,
	});
	check(code === 6, "head moves during verification → exit 6", `got ${code}, out:\n${out}`);
	check(actedOn(argv, "merge") === undefined, "head moves during verification → merges nothing", argv.join("\n"));
	check(out.includes("aaaaaaa") && out.includes("bbbbbbb"), "head moves → names both shas", out);
}

// 6g. …and a head that does NOT move still merges, so 6f is testing the guard
//     rather than the stub's ability to return two values.
{
	const stable = ["c".repeat(40), "c".repeat(40)];
	const { code, argv } = run(PR_MERGE, "main", [OURS(42, "42-some-feature")], ["42-some-feature"], {
		headOids: stable,
	});
	check(code === 0, "head unchanged across both resolutions → exit 0", `got ${code}`);
	check(actedOn(argv, "merge")?.includes("42") === true, "head unchanged → merges", argv.join("\n"));
}

// ---
// Sandbox completeness (#279). The bug this suite hit was not a wrong
// assertion — it was an incomplete stub environment: pr-merge grew a call to
// one of OUR OWN scripts, that script was not stubbed, and the bare name
// resolved to the host's ~/bin copy. Nothing failed loudly; the suite just
// quietly stopped testing what it claimed to and started using the network.
//
// So assert the environment, not just the outcomes: every bin/ script these
// two scripts invoke in command position must exist in the sandbox's stub dir.
// Adding a helper call without stubbing it now fails here, by name.
// ---

console.log("\nsandbox completeness (#279):");
{
	const BIN_DIR = path.join(REPO_ROOT, "bin");
	const OUR_SCRIPTS = fs.readdirSync(BIN_DIR).filter((f) => !f.endsWith(".mjs") && !f.endsWith(".ts"));
	const { binDir } = sandbox("main", [OURS(1, "main")]);
	const stubbed = new Set(fs.readdirSync(binDir));

	for (const script of [PR_MERGE, PR_REJECT]) {
		const name = path.basename(script);
		// Comment lines only — an inline `#` inside a quoted string is not a
		// comment, and stripping those would corrupt the very echo lines that
		// make the false-positive analysis below work.
		const code = fs
			.readFileSync(script, "utf8")
			.split("\n")
			.filter((l) => !/^\s*#/.test(l))
			.join("\n");

		for (const helper of OUR_SCRIPTS) {
			if (helper === name) continue;
			const esc = helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			// COMMAND position specifically: start of line, or after a pipe /
			// separator / `$(` / backtick / if / then / do / `!`. Matching the
			// bare name anywhere would fire on every prose mention inside an
			// echo — bin/pr-merge names pr-threads six times in its error text.
			const called = new RegExp(
				`(?:^|[;&|(]|\\$\\(|\`|\\bif\\s+|\\bthen\\s+|\\bdo\\s+|!\\s+)\\s*${esc}(?=\\s|$|")`,
				"m",
			).test(code);
			if (!called) continue;
			check(
				stubbed.has(helper),
				`${name} invokes '${helper}' → the sandbox stubs it`,
				`${name} execs '${helper}' by bare name, so it resolves from PATH.\nWithout a stub in ${binDir} it reaches ~/bin/${helper} — the host's copy,\nwhich the gh stub cannot intercept and which will use the network.`,
			);
		}
	}
}

// ---
// pr-reject
// ---

console.log("\npr-reject:");

// 7. The headline defect: the branch argument was silently eaten as the reason.
{
	const { code, out, argv } = run(
		PR_REJECT,
		"main",
		[OURS(42, "42-some-feature")],
		["-b", "42-some-feature", "wrong approach"],
	);
	check(code === 0, "pr-reject -b <branch> <reason> → exits 0", `got ${code}, out:\n${out}`);
	const line = actedOn(argv, "close");
	check(line?.includes("42") === true, "pr-reject -b <branch> → closes THAT branch's PR", argv.join("\n"));
	check(
		line?.includes("wrong approach") === true,
		"pr-reject -b <branch> <reason> → comment is the reason, not the branch name",
		argv.join("\n"),
	);
	check(
		line?.includes("42-some-feature --comment") !== true,
		"pr-reject → branch name never becomes the comment",
		argv.join("\n"),
	);
}

// 8. Back-compat: a bare reason on a feature branch still works.
{
	const { code, argv } = run(PR_REJECT, "42-some-feature", [OURS(42, "42-some-feature")], ["not now"]);
	check(code === 0, "pr-reject <reason> on a feature branch → exits 0", `got ${code}`);
	const line = actedOn(argv, "close");
	check(line?.includes("42") === true, "pr-reject <reason> → closes the current branch's PR", argv.join("\n"));
	check(line?.includes("not now") === true, "pr-reject <reason> → reason is the comment", argv.join("\n"));
}

// 9. No reason at all — closes without a comment.
{
	const { code, argv } = run(PR_REJECT, "42-some-feature", [OURS(42, "42-some-feature")], []);
	check(code === 0, "pr-reject (no args) on a feature branch → exits 0", `got ${code}`);
	check(
		actedOn(argv, "close")?.includes("--comment") !== true,
		"pr-reject (no args) → closes with no comment",
		argv.join("\n"),
	);
}

// 10b. pr-reject inherits the same fail-loudly rule — and it's a determined
//      remote/API failure (#224 code 5), not a bare non-zero.
{
	const { code, out, argv } = run(PR_REJECT, "fix", [OURS(7, "fix")], ["nope"], { failGhList: true });
	check(code === 5, "pr-reject: gh pr list fails → exit 5 (remote/API failure)", `got ${code}, out:\n${out}`);
	check(actedOn(argv, "close") === undefined, "pr-reject: gh pr list fails → closes nothing", argv.join("\n"));
	check(
		/failed/i.test(out) && !/no open PR found/i.test(out),
		"pr-reject: gh pr list fails → reports the failure",
		out,
	);
}

// 11. `-b` with no branch name → usage error (#224 code 2).
{
	const { code, out, argv } = run(PR_REJECT, "42-some-feature", [OURS(42, "42-some-feature")], ["-b"]);
	check(code === 2, "pr-reject -b <nothing> → exit 2 (usage error)", `got ${code}, out:\n${out}`);
	check(actedOn(argv, "close") === undefined, "pr-reject -b <nothing> → closes nothing", argv.join("\n"));
	check(/-b needs a branch name/i.test(out), "pr-reject -b <nothing> → says so", out);
}

// 12. On main/master with nothing to discover otherwise (no -b given, so the
//     branch was DISCOVERED from cwd) → precondition not met (#224 code 3).
{
	const { code, out, argv } = run(PR_REJECT, "main", [OURS(42, "42-some-feature")], []);
	check(code === 3, "pr-reject on main (no -b) → exit 3 (precondition not met)", `got ${code}, out:\n${out}`);
	check(actedOn(argv, "close") === undefined, "pr-reject on main → closes nothing", argv.join("\n"));
	check(/on main/i.test(out), "pr-reject on main → says so", out);
}

// 12b. `-b main` NAMES the protected branch explicitly (#224 code 2 — usage
//      error, per the shared table: "a protected branch named explicitly" is
//      2, distinct from 3's "nothing to discover from cwd"). Run from a
//      feature branch so a bare code-3 fallback (checking only cwd) cannot
//      accidentally produce the right-looking number.
{
	const { code, out, argv } = run(PR_REJECT, "42-some-feature", [OURS(42, "42-some-feature")], [
		"-b",
		"main",
		"wrong branch",
	]);
	check(code === 2, "pr-reject -b main → exit 2 (usage error, named explicitly)", `got ${code}, out:\n${out}`);
	check(actedOn(argv, "close") === undefined, "pr-reject -b main → closes nothing", argv.join("\n"));
	check(/main/i.test(out), "pr-reject -b main → says so", out);
}

// 12c. `-b master` — same explicit-naming path, other protected name.
{
	const { code, argv } = run(PR_REJECT, "42-some-feature", [OURS(42, "42-some-feature")], ["-b", "master"]);
	check(code === 2, "pr-reject -b master → exit 2 (usage error, named explicitly)", `got ${code}`);
	check(actedOn(argv, "close") === undefined, "pr-reject -b master → closes nothing", argv.join("\n"));
}

// 13. No open PR at all for the branch → not found (#224 code 4).
{
	const { code, out, argv } = run(PR_REJECT, "fix", [FORK(99, "fix")], ["nope"]);
	check(code === 4, "pr-reject: no open PR for branch → exit 4 (not found)", `got ${code}, out:\n${out}`);
	check(actedOn(argv, "close") === undefined, "pr-reject: no open PR → closes nothing", argv.join("\n"));
	check(/no open PR found/i.test(out), "pr-reject: no open PR → says so", out);
}

// 14. Two of OUR OWN open PRs share the branch name → ambiguous, refuse
//     rather than guess (#224 code 6 — safety gate refused).
{
	const { code, out, argv } = run(PR_REJECT, "fix", [OURS(7, "fix"), OURS(8, "fix")], ["nope"]);
	check(code === 6, "pr-reject: ambiguous PR selection → exit 6 (safety gate refused)", `got ${code}, out:\n${out}`);
	check(actedOn(argv, "close") === undefined, "pr-reject: ambiguous → closes nothing", argv.join("\n"));
	check(/\b7\b/.test(out) && /\b8\b/.test(out), "pr-reject: ambiguous → names both candidates", out);
}

// 10. pr-reject inherits the same fork guard.
{
	const { code, out, argv } = run(PR_REJECT, "fix", [FORK(99, "fix"), OURS(7, "fix")], ["nope"]);
	check(code === 0, "pr-reject with a fork twin → exits 0", `got ${code}, out:\n${out}`);
	check(
		actedOn(argv, "close")?.includes("7") === true,
		"pr-reject with a fork twin → closes OUR PR (#7), not the fork's (#99)",
		argv.join("\n"),
	);
}

// ---
// pr-reject: no code should ever leak `set -e`'s raw underlying exit status.
// Every external command whose failure is reachable must be mapped onto the
// #224 table (2/3/4/5/6) explicitly — never let bash's default propagate.
// ---

// 15. `gh repo view` fails (auth/network) before the PR is even looked up →
//     remote/API failure (#224 code 5), same treatment pr-merge already gives
//     this exact call. Before the fix this leaked gh's raw status (1).
{
	const { code, out, argv } = run(PR_REJECT, "fix", [OURS(7, "fix")], ["nope"], { failGhRepoView: true });
	check(code === 5, "pr-reject: gh repo view fails → exit 5 (remote/API failure)", `got ${code}, out:\n${out}`);
	check(actedOn(argv, "close") === undefined, "pr-reject: gh repo view fails → closes nothing", argv.join("\n"));
	check(/failed/i.test(out), "pr-reject: gh repo view fails → reports the failure", out);
}

// 16. `gh pr close` itself fails (e.g. permission denied) after the PR was
//     already selected → remote/API failure (#224 code 5). Before the fix
//     this leaked gh's raw status (1) straight out of `set -e`.
{
	const { code, out } = run(PR_REJECT, "fix", [OURS(7, "fix")], ["nope"], { failGhClose: true });
	check(code === 5, "pr-reject: gh pr close fails → exit 5 (remote/API failure)", `got ${code}, out:\n${out}`);
	check(/failed/i.test(out), "pr-reject: gh pr close fails → reports the failure", out);
}

// 17. Run outside any git repository at all — `git branch --show-current`
//     itself fails (fatal: not a git repository, real exit 128) before a
//     branch can even be discovered from cwd. #224 code 2 covers this case
//     by name ("not run inside a git repository at all"). Before the fix
//     this leaked git's raw status (128) straight out of `set -e`.
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-reject-nogit-"));
	let code = 0;
	let out = "";
	try {
		out = execFileSync("bash", [PR_REJECT, "nope"], {
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: any) {
		code = err?.status ?? -1;
		out = `${err?.stdout || ""}${err?.stderr || ""}`;
	}
	check(code === 2, "pr-reject outside a git repo → exit 2 (usage error)", `got ${code}, out:\n${out}`);
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---

console.log(
	`\n${failures === 0 ? "✅" : "❌"} pr-merge / pr-reject args: ${checks - failures} of ${checks} checks passed.`,
);
process.exit(failures > 0 ? 1 : 0);
