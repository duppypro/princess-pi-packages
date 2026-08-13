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
}

interface SandboxOpts {
	/** stub `pr-threads`: "clean" (exit 0), "unresolved" (exit 1), "broken" (exit 5), or "missing" (no such command on PATH) */
	threadState?: "clean" | "unresolved" | "broken" | "missing";
	/** stub `gh pr list` finds zero open PRs for the branch */
	noPr?: boolean;
	/** stub `gh pr list` itself fails (outage / expired auth) */
	failGhList?: boolean;
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

	// --- stub gh: repo view / pr list / pr merge ---
	const noPr = opts.noPr ?? false;
	const prJson = opts.failGhList
		? ""
		: noPr
			? "[]"
			: JSON.stringify([{ number: 42, headRepositoryOwner: { login: "duppypro" } }]);
	const gh = `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo '{"owner":{"login":"duppypro"}}' ;;
  "pr list")
    ${opts.failGhList ? 'echo "gh: could not connect to api.github.com" >&2; exit 1' : `echo ${JSON.stringify(prJson)} | jq -r '[.[] | select(.headRepositoryOwner.login == "duppypro") | .number] | @tsv'`}
    ;;
  "pr merge") touch ${JSON.stringify(mergedFlag)} ;;
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

	return { root, worktree, binDir, mergedFlag, branch };
}

// Deliberately NOT `${sb.binDir}:${process.env.PATH}` — this host already has a
// REAL pr-threads deployed to ~/bin (install-workflow-tools' whole job), and
// prepending would only WIN the lookup when the sandbox supplies its own
// stub. The "missing" case supplies none, so without this the test would
// silently fall through to the real, live pr-threads instead of proving
// pr-merge's fail-closed behavior. A minimal system PATH plus the sandbox
// bin dir gives git/jq/bash without leaking any host-installed workflow tool.
const ISOLATED_PATH = `${path.dirname(execFileSync("which", ["bash"], { encoding: "utf8" }).trim())}${path.delimiter}/usr/bin${path.delimiter}/bin`;

function runPrMerge(sb: Sandbox): { code: number; out: string } {
	try {
		const out = execFileSync("bash", [PR_MERGE], {
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

// ---
// Cases
// ---

console.log("pr-merge: gated on pr-threads before the network call (#258)");

// 1. Unresolved threads: refuse, print the details, never touch `gh pr merge`.
console.log("\nunresolved threads:");
{
	const sb = makeSandbox("42-feature", { threadState: "unresolved" });
	const { code, out } = runPrMerge(sb);
	check(code !== 0, "unresolved threads → non-zero", `got ${code}, output:\n${out}`);
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
	check(code !== 0, "pr-threads broken → non-zero", `got ${code}, output:\n${out}`);
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
	check(code !== 0, "pr-threads missing → non-zero", `got ${code}, output:\n${out}`);
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
	check(code !== 0, "no open PR → non-zero", `got ${code}, output:\n${out}`);
	check(!merged(sb), "no open PR → gh pr merge never called", out);
	check(/no open PR/i.test(out), "no open PR → says so", out);
}

console.log("\nregression: gh pr list itself fails:");
{
	const sb = makeSandbox("42-feature", { threadState: "clean", failGhList: true });
	const { code, out } = runPrMerge(sb);
	check(code !== 0, "gh pr list fails → non-zero", `got ${code}, output:\n${out}`);
	check(!merged(sb), "gh pr list fails → gh pr merge never called", out);
}

console.log("\nregression: on main refuses before any PR lookup:");
{
	const sb = makeSandbox("main", { threadState: "clean" });
	const { code, out } = runPrMerge(sb);
	check(code !== 0, "on main → non-zero", `got ${code}, output:\n${out}`);
	check(!merged(sb), "on main → gh pr merge never called", out);
	check(/on main/i.test(out), "on main → says so", out);
}

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} pr-merge gate: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
