// --- pr-merge: the #258 gate on pr-threads before the network call ---
//
// pr-merge is human-only, so this suite is the ONLY place its gate ever gets
// proven — nobody exercises it live in an agent session. Same harness as
// tests/pr-cleanup-safety.test.ts: real bin/pr-merge, a stub `gh` on PATH for
// PR selection, and (new here) a stub `pr-threads` on PATH standing in for
// the real merge gate.
//
// The three states under test map directly onto pr-threads' own exit
// contract (documented in bin/pr-threads' header):
//   exit 1  → "checked, and it says no" (unresolved threads and/or an
//             uncovered review head) → pr-merge refuses, prints the details,
//             never calls `gh pr merge`.
//   exit 0  → clean → pr-merge proceeds exactly as before #258.
//   anything else (2/4/5/nonexistent binary) → the CHECK failed, not the
//             review → pr-merge aborts with different wording ("could not
//             verify"), still never calls `gh pr merge`. This is the #210
//             fail-closed requirement: a broken gate must not be read as a
//             passing one.
//
// "Never calls `gh pr merge`" is asserted by making the stub `gh`'s `pr
// merge` arm write a sentinel file — if it's absent afterward, the merge
// never happened.
//
// Run with: bun run test pr-merge-gate

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PR_MERGE = path.join(REPO_ROOT, "bin", "pr-merge");

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

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...GIT_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

interface Sandbox {
	root: string;
	worktree: string;
	binDir: string;
	mergedFlag: string;
	branch: string;
	/** every `gh api -X PUT repos/.../pulls/<n>/update-branch` call logs `<n>` here, one per line */
	apiCallsLog: string;
}

/** #332: the just-merged PR's other-open-PR fixture, for the post-merge refresh. */
interface OtherPr {
	number: number;
	base?: string;
	draft?: boolean;
}

interface SandboxOpts {
	/** stub `pr-threads`: "clean" (exit 0), "unresolved" (exit 1), "broken" (exit 5), or "missing" (no such command on PATH) */
	threadState?: "clean" | "unresolved" | "broken" | "missing";
	/** stub `gh pr list` finds zero open PRs for the branch */
	noPr?: boolean;
	/** stub `gh pr list` itself fails (outage / expired auth) */
	failGhList?: boolean;
	/** stub `gh pr list` finds MORE THAN ONE open PR sharing the branch's head — ambiguous selection */
	multiPr?: boolean;
	/**
	 * stub `gh pr view --json headRefOid` reports a DIFFERENT sha on the second
	 * call than the first — simulates a push landing between the pr-threads
	 * gate and the merge call (#258 TOCTOU guard, macroscopeapp finding on PR
	 * #267). First call is always "sha0000head", second is "sha1111moved".
	 */
	headMovesBetweenGateAndMerge?: boolean;
	/** stub `gh pr view` itself fails (outage / expired auth) */
	failGhView?: boolean;
	/** #332: base branch of the just-merged PR (#42). Default "main". */
	mergedBase?: string;
	/** #332: every OTHER open PR on the repo, as `gh pr list --state open` (no --head) would report them. */
	otherOpenPRs?: OtherPr[];
	/** #332: per-PR-number outcome for `gh api -X PUT .../update-branch`. Default "ok" for any PR not listed. */
	updateBranchOutcome?: Record<number, "ok" | "conflict" | "hardfail">;
	/** #332 review: make `gh pr merge` itself fail, so the merge does NOT happen. */
	failGhMerge?: boolean;
}

/** A real git repo with a feature branch — pr-merge only needs `git branch --show-current` to work. */
function makeSandbox(branch: string, opts: SandboxOpts = {}): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-merge-"));
	const worktree = path.join(root, "wt");
	fs.mkdirSync(worktree);
	git(worktree, ["init", "-q", "-b", branch]);
	fs.writeFileSync(path.join(worktree, "f.txt"), "work\n");
	git(worktree, ["add", "-A"]);
	git(worktree, ["commit", "-q", "-m", "feature work"]);

	const binDir = path.join(root, "stubbin");
	fs.mkdirSync(binDir);
	const mergedFlag = path.join(root, "merged.flag");
	const apiCallsLog = path.join(root, "api-calls.log");
	fs.writeFileSync(apiCallsLog, "");

	// --- stub gh: repo view / pr list / pr view / pr merge / api (#332) ---
	const noPr = opts.noPr ?? false;
	const multiPr = opts.multiPr ?? false;
	const mergedBase = opts.mergedBase ?? "main";
	// `gh pr list --head "$BRANCH" ...` — the #209 branch-selection fixture, now
	// carrying baseRefName too so pr-merge can read the just-merged PR's base
	// straight out of the same JSON without a second gh call.
	const prJson = opts.failGhList
		? ""
		: noPr
			? "[]"
			: multiPr
				? JSON.stringify([
						{ number: 42, headRepositoryOwner: { login: "duppypro" }, baseRefName: mergedBase },
						{ number: 43, headRepositoryOwner: { login: "duppypro" }, baseRefName: mergedBase },
					])
				: JSON.stringify([{ number: 42, headRepositoryOwner: { login: "duppypro" }, baseRefName: mergedBase }]);
	// `gh pr list --state open ...` with NO --head — #332's post-merge "every
	// other open PR" listing. Excludes #42 (the just-merged PR) by construction;
	// callers supply exactly the OTHER PRs they want visible.
	const otherPrsJson = JSON.stringify(
		(opts.otherOpenPRs ?? []).map((p) => ({
			number: p.number,
			baseRefName: p.base ?? mergedBase,
			isDraft: p.draft ?? false,
		})),
	);
	const outcomeEntries = Object.entries(opts.updateBranchOutcome ?? {});
	const hardfailNums = outcomeEntries.filter(([, v]) => v === "hardfail").map(([k]) => k);
	const conflictNums = outcomeEntries.filter(([, v]) => v === "conflict").map(([k]) => k);
	const headCallCounter = path.join(root, "prview-callcount");
	fs.writeFileSync(headCallCounter, "0");
	const gh = `#!/usr/bin/env bash
# --- #332: gh api -X PUT repos/.../pulls/<n>/update-branch ---
if [ "$1" = "api" ]; then
  shift
  url=""
  for a in "$@"; do
    case "$a" in
      repos/*/pulls/*/update-branch) url="$a" ;;
    esac
  done
  n=$(printf '%s' "$url" | sed -E 's#.*/pulls/([0-9]+)/update-branch#\\1#')
  printf '%s\\n' "$n" >> ${JSON.stringify(apiCallsLog)}
  case ",${hardfailNums.join(",")}," in
    *",$n,"*) echo "gh: permission denied updating PR #$n" >&2; exit 1 ;;
  esac
  case ",${conflictNums.join(",")}," in
    *",$n,"*) echo '{"message":"There are no new commits on the base branch.","status":"422"}' >&2; exit 1 ;;
  esac
  echo "Updating pull request branch."
  exit 0
fi

# generic --jq extractor, mirroring tests/pr-scripts-args.test.ts's stub
jqexpr=""
head=""
prev=""
for a in "$@"; do
  case "$prev" in
    --jq|-q) jqexpr="$a" ;;
    --head) head="$a" ;;
  esac
  prev="$a"
done
emit() {
  if [ -n "$jqexpr" ]; then printf '%s' "$1" | jq -r "$jqexpr"; else printf '%s\\n' "$1"; fi
}

case "$1 $2" in
  "repo view")
    emit '{"owner":{"login":"duppypro"},"nameWithOwner":"duppypro/princess-pi-packages"}'
    ;;
  "pr list")
    if [ -n "$head" ]; then
      ${opts.failGhList ? 'echo "gh: could not connect to api.github.com" >&2; exit 1' : `emit ${JSON.stringify(prJson)}`}
    else
      emit ${JSON.stringify(otherPrsJson)}
    fi
    ;;
  "pr view")
    ${
			opts.failGhView
				? 'echo "gh: could not connect to api.github.com" >&2; exit 1'
				: opts.headMovesBetweenGateAndMerge
					? `n=$(cat ${JSON.stringify(headCallCounter)}); echo $((n + 1)) > ${JSON.stringify(headCallCounter)}; if [ "$n" -eq 0 ]; then echo "sha0000head"; else echo "sha1111moved"; fi`
					: 'echo "sha0000head"'
		}
    ;;
  "pr merge") ${opts.failGhMerge ? 'echo "gh: pull request is not mergeable" >&2; exit 1' : `touch ${JSON.stringify(mergedFlag)}`} ;;
  *) exit 0 ;;
esac
`;
	fs.writeFileSync(path.join(binDir, "gh"), gh);
	fs.chmodSync(path.join(binDir, "gh"), 0o755);

	// --- stub pr-threads: the #258 gate under test ---
	if (opts.threadState && opts.threadState !== "missing") {
		const exitCode = { clean: 0, unresolved: 1, broken: 5 }[opts.threadState];
		const message = {
			clean: "✅ duppypro/princess-pi-packages #42 — 0 unresolved conversations (2 total, all resolved)",
			unresolved:
				"❌ duppypro/princess-pi-packages #42 — 2 unresolved conversation(s):\n  macroscopeapp  bin/pr-merge\n    https://github.com/o/r/pull/42#discussion_r1",
			broken: "pr-threads: gh api graphql failed for duppypro/princess-pi-packages #42:\ngh: could not connect to api.github.com",
		}[opts.threadState];
		const prThreads = `#!/usr/bin/env bash
echo ${JSON.stringify(message)}
exit ${exitCode}
`;
		fs.writeFileSync(path.join(binDir, "pr-threads"), prThreads);
		fs.chmodSync(path.join(binDir, "pr-threads"), 0o755);
	}
	// "missing" → deliberately do not create a pr-threads stub; PATH has none.

	return { root, worktree, binDir, mergedFlag, branch, apiCallsLog };
}

// Deliberately NOT `${sb.binDir}:${process.env.PATH}` — this host already has a
// REAL pr-threads deployed to ~/bin (install-workflow-tools' whole job), and
// prepending would only WIN the lookup when the sandbox supplies its own
// stub. The "missing" case supplies none, so without this the test would
// silently fall through to the real, live pr-threads instead of proving
// pr-merge's fail-closed behavior. A minimal system PATH plus the sandbox
// bin dir gives git/jq/bash without leaking any host-installed workflow tool.
const ISOLATED_PATH = `${path.dirname(execFileSync("which", ["bash"], { encoding: "utf8" }).trim())}${path.delimiter}/usr/bin${path.delimiter}/bin`;

function runPrMerge(sb: Sandbox, extraArgs: string[] = []): { code: number; out: string } {
	try {
		const out = execFileSync("bash", [PR_MERGE, ...extraArgs], {
			cwd: sb.worktree,
			encoding: "utf8",
			env: { ...process.env, ...GIT_ENV, PATH: `${sb.binDir}${path.delimiter}${ISOLATED_PATH}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}

function merged(sb: Sandbox): boolean {
	return fs.existsSync(sb.mergedFlag);
}

/** #332: PR numbers `gh api -X PUT .../update-branch` was actually called for, in call order. */
function apiCalls(sb: Sandbox): string[] {
	return fs
		.readFileSync(sb.apiCallsLog, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean);
}

// ---
// Cases
// ---

console.log("pr-merge: gated on pr-threads before the network call (#258)");

// 1. Unresolved threads: refuse, print the details, never touch `gh pr merge`.
console.log("\nunresolved threads:");
{
	const sb = makeSandbox("42-feature", { threadState: "unresolved" });
	const { code, out } = runPrMerge(sb);
	// Pinned to the #224 exit-code table, not just "non-zero" (post-#258
	// finding: regex-only assertions on stderr prose would stay green even if
	// 5 and 6 were swapped, or if the wording changed under the reader).
	check(code === 6, "unresolved threads → exit 6 (safety gate refused)", `got ${code}, output:\n${out}`);
	check(!merged(sb), "unresolved threads → gh pr merge never called", out);
	check(out.includes("bin/pr-merge"), "unresolved threads → thread path/URL printed", out);
	check(out.includes("discussion_r"), "unresolved threads → thread URL printed", out);
	check(
		/not clear to merge|unresolved/i.test(out),
		"unresolved threads → message names the actual problem",
		out,
	);
}

// 2. All resolved: merges exactly as before #258.
console.log("\nall threads resolved:");
{
	const sb = makeSandbox("42-feature", { threadState: "clean" });
	const { code, out } = runPrMerge(sb);
	check(code === 0, "clean → exits 0", `got ${code}, output:\n${out}`);
	check(merged(sb), "clean → gh pr merge WAS called", out);
}

// 3. pr-threads itself fails (API/gh broken): abort, but say "could not
//    verify" — distinct wording from "found a problem".
console.log("\npr-threads exits broken (gh/API failure, not unresolved):");
{
	const sb = makeSandbox("42-feature", { threadState: "broken" });
	const { code, out } = runPrMerge(sb);
	check(code === 5, "pr-threads broken → exit 5 (remote/API failure)", `got ${code}, output:\n${out}`);
	check(!merged(sb), "pr-threads broken → gh pr merge never called", out);
	check(
		/could not verify|cannot verify/i.test(out),
		"pr-threads broken → wording distinguishes 'cannot check' from 'found problems'",
		out,
	);
	check(!/not clear to merge/i.test(out), "pr-threads broken → does NOT claim 'found a problem'", out);
}

// 4. pr-threads is not even on PATH: same fail-closed treatment as "broken".
console.log("\npr-threads missing from PATH entirely:");
{
	const sb = makeSandbox("42-feature", { threadState: "missing" });
	const { code, out } = runPrMerge(sb);
	check(code === 5, "pr-threads missing → exit 5 (remote/API failure)", `got ${code}, output:\n${out}`);
	check(!merged(sb), "pr-threads missing → gh pr merge never called", out);
	check(
		/could not verify|cannot verify/i.test(out),
		"pr-threads missing → same 'could not verify' framing",
		out,
	);
}

// --- regression guard: PR-selection failures still behave as before #258 ---

console.log("\nregression: no open PR (unrelated to the gate):");
{
	const sb = makeSandbox("42-feature", { threadState: "clean", noPr: true });
	const { code, out } = runPrMerge(sb);
	check(code === 4, "no open PR → exit 4 (not found)", `got ${code}, output:\n${out}`);
	check(!merged(sb), "no open PR → gh pr merge never called", out);
	check(/no open PR/i.test(out), "no open PR → says so", out);
}

console.log("\nregression: gh pr list itself fails:");
{
	const sb = makeSandbox("42-feature", { threadState: "clean", failGhList: true });
	const { code, out } = runPrMerge(sb);
	check(code === 5, "gh pr list fails → exit 5 (remote/API failure)", `got ${code}, output:\n${out}`);
	check(!merged(sb), "gh pr list fails → gh pr merge never called", out);
}

console.log("\nregression: on main refuses before any PR lookup:");
{
	const sb = makeSandbox("main", { threadState: "clean" });
	const { code, out } = runPrMerge(sb);
	check(code === 3, "on main → exit 3 (precondition not met)", `got ${code}, output:\n${out}`);
	check(!merged(sb), "on main → gh pr merge never called", out);
	check(/on main/i.test(out), "on main → says so", out);
}

// 5. Ambiguous PR selection: more than one open PR shares the branch's head.
//    Untested before this fix (#224 table and pr-merge's own header both say
//    6 here — the header used to say 4, contradicting both; see bin/pr-merge
//    header comment history). Refuses to guess, never calls `gh pr merge`.
console.log("\nregression: ambiguous PR selection (multiple open PRs share the branch):");
{
	const sb = makeSandbox("42-feature", { threadState: "clean", multiPr: true });
	const { code, out } = runPrMerge(sb);
	check(code === 6, "ambiguous PR selection → exit 6 (safety gate refused)", `got ${code}, output:\n${out}`);
	check(!merged(sb), "ambiguous PR selection → gh pr merge never called", out);
	check(/ambiguous/i.test(out), "ambiguous PR selection → says so", out);
}

// 6. TOCTOU guard (#258 follow-up, macroscopeapp finding on PR #267): the
//    branch moves between the pr-threads gate and the merge call. pr-threads
//    itself reports clean (it saw the sha at gate-time) — the guard has to
//    catch the move independently, via the second `gh pr view` call
//    immediately before `gh pr merge`.
console.log("\nbranch moves between the gate and the merge (TOCTOU guard):");
{
	const sb = makeSandbox("42-feature", { threadState: "clean", headMovesBetweenGateAndMerge: true });
	const { code, out } = runPrMerge(sb);
	check(code === 6, "head moved during verification → exit 6 (safety gate refused)", `got ${code}, output:\n${out}`);
	check(!merged(sb), "head moved during verification → gh pr merge never called", out);
	check(/moved during verification/i.test(out), "head moved → message names the actual problem", out);
	check(out.includes("sha0000"), "head moved → names the sha the gate approved", out);
	check(out.includes("sha1111"), "head moved → names the new (unverified) sha", out);
}

// 7. Regression: `gh pr view` itself fails (outage / expired auth) — the new
//    resolve_head() call, same fail-closed treatment as `gh pr list` failing.
console.log("\nregression: gh pr view itself fails:");
{
	const sb = makeSandbox("42-feature", { threadState: "clean", failGhView: true });
	const { code, out } = runPrMerge(sb);
	check(code === 5, "gh pr view fails → exit 5 (remote/API failure)", `got ${code}, output:\n${out}`);
	check(!merged(sb), "gh pr view fails → gh pr merge never called", out);
}

// ---
// #332: post-merge refresh of every other open PR
// ---
// strict_required_status_checks_policy means merging THIS PR marks every
// OTHER open PR (same base) out of date — each then needs GitHub's "Update
// branch" pressed before it can merge. pr-merge now presses that button
// itself, right after a successful merge, via the same API call:
//   gh api -X PUT repos/<owner>/<repo>/pulls/<n>/update-branch
// Best-effort only (req #2, THE hard rule): nothing here may ever change
// pr-merge's own exit code — the merge already happened and is irreversible.

console.log("\npr-merge: post-merge refresh of other open PRs (#332)");

// a. After a successful merge, refresh fires once per other open PR.
console.log("\nsuccessful merge → refresh fires once per other open PR:");
{
	const sb = makeSandbox("42-feature", {
		threadState: "clean",
		mergedBase: "main",
		otherOpenPRs: [
			{ number: 50, base: "main" },
			{ number: 51, base: "main" },
		],
	});
	const { code, out } = runPrMerge(sb);
	check(code === 0, "merge + refresh → exits 0", `got ${code}, output:\n${out}`);
	check(merged(sb), "merge + refresh → gh pr merge WAS called", out);
	const calls = apiCalls(sb);
	check(calls.length === 2, "refresh called exactly once per other open PR", calls.join(","));
	check(calls.includes("50") && calls.includes("51"), "refresh called for PR #50 and #51", calls.join(","));
	check(out.includes("refresh 50 ok"), "output: refresh 50 ok", out);
	check(out.includes("refresh 51 ok"), "output: refresh 51 ok", out);
}

// b. No merge (gate refuses) → no refresh at all.
console.log("\nno merge (gate refuses) → no refresh at all:");
{
	const sb = makeSandbox("42-feature", {
		threadState: "unresolved",
		mergedBase: "main",
		otherOpenPRs: [{ number: 50, base: "main" }],
	});
	const { code } = runPrMerge(sb);
	check(code === 6, "gate refuses → exit 6 (unchanged)", `got ${code}`);
	check(!merged(sb), "gate refuses → gh pr merge never called", "");
	check(apiCalls(sb).length === 0, "gate refuses → update-branch never called", apiCalls(sb).join(","));
}

// c. A 422 ("no new commits") response reports `skipped`, not `failed`.
console.log("\n422 'no new commits' → skipped, not failed:");
{
	const sb = makeSandbox("42-feature", {
		threadState: "clean",
		mergedBase: "main",
		otherOpenPRs: [{ number: 50, base: "main" }],
		updateBranchOutcome: { 50: "conflict" },
	});
	const { code, out } = runPrMerge(sb);
	check(code === 0, "422 on refresh → pr-merge still exits 0", `got ${code}, output:\n${out}`);
	check(out.includes("refresh 50 skipped"), "422 → reported as skipped", out);
	check(!out.includes("refresh 50 failed"), "422 → NOT reported as failed", out);
}

// d. A hard-failing refresh (e.g. permission denied) still leaves pr-merge exit 0.
console.log("\nhard-failing refresh → pr-merge still exits 0:");
{
	const sb = makeSandbox("42-feature", {
		threadState: "clean",
		mergedBase: "main",
		otherOpenPRs: [{ number: 50, base: "main" }],
		updateBranchOutcome: { 50: "hardfail" },
	});
	const { code, out } = runPrMerge(sb);
	check(code === 0, "hard-failing refresh → pr-merge exit code UNCHANGED (0)", `got ${code}, output:\n${out}`);
	check(merged(sb), "hard-failing refresh → the merge itself still happened", out);
	check(out.includes("refresh 50 failed"), "hard-failing refresh → reported as failed", out);
}

// e. `--no-refresh` suppresses it entirely.
console.log("\n--no-refresh suppresses the refresh entirely:");
{
	const sb = makeSandbox("42-feature", {
		threadState: "clean",
		mergedBase: "main",
		otherOpenPRs: [
			{ number: 50, base: "main" },
			{ number: 51, base: "main" },
		],
	});
	const { code, out } = runPrMerge(sb, ["--no-refresh"]);
	check(code === 0, "--no-refresh → exits 0", `got ${code}, output:\n${out}`);
	check(merged(sb), "--no-refresh → the merge itself still happened", out);
	check(apiCalls(sb).length === 0, "--no-refresh → update-branch never called", apiCalls(sb).join(","));
	check(!out.includes("refresh "), "--no-refresh → no refresh lines in output", out);
}

// f. A draft PR, and a PR with a different base, are both skipped.
console.log("\ndraft PR and different-base PR are both skipped:");
{
	const sb = makeSandbox("42-feature", {
		threadState: "clean",
		mergedBase: "main",
		otherOpenPRs: [
			{ number: 50, base: "main", draft: true },
			{ number: 51, base: "some-other-base" },
			{ number: 52, base: "main" },
		],
	});
	const { code, out } = runPrMerge(sb);
	check(code === 0, "draft/different-base → exits 0", `got ${code}, output:\n${out}`);
	const calls = apiCalls(sb);
	check(!calls.includes("50"), "draft PR → update-branch never called for it", calls.join(","));
	check(!calls.includes("51"), "different-base PR → update-branch never called for it", calls.join(","));
	check(calls.includes("52"), "eligible PR (same base, not draft) → update-branch WAS called", calls.join(","));
	check(out.includes("refresh 52 ok"), "output: refresh 52 ok", out);
}

// --- A merge that did NOT happen must never exit 0 (#332 review).
// The refresh refactor wrapped the merge as `if gh pr merge …; then … fi`
// followed by `exit $?`. An `if` whose condition fails and has no `else`
// returns 0, so a failed merge reported success — strictly worse than the
// pre-#332 behaviour, where the merge was the last line under `set -e` and a
// failure aborted with gh's own status. This is the inverse of the property
// #332 set out to protect, so it gets its own case rather than living inside
// the best-effort-refresh ones. ---
console.log("\ngh pr merge itself fails → non-zero exit, and nothing is refreshed:");
{
	const sb = makeSandbox("42-feature", {
		threadState: "clean",
		failGhMerge: true,
		otherOpenPRs: [{ number: 50, base: "main", draft: false }],
	});
	const { code, out } = runPrMerge(sb);
	check(code !== 0, "failed merge → does NOT exit 0", `got ${code}, output:\n${out}`);
	check(code === 5, "failed merge → exit 5 (remote/API failure per the #224 table)", `got ${code}, output:\n${out}`);
	check(
		apiCalls(sb).length === 0,
		"failed merge → no PR refreshed (refresh runs only after success)",
		apiCalls(sb).join(","),
	);
	check(!out.includes("refresh 50 ok"), "failed merge → no 'refresh … ok' record emitted", out);
}

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} pr-merge gate: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
