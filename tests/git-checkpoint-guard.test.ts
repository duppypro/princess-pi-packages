// git-checkpoint: refuses to commit+push on the primary branch (#225 gap 1)
//
// git-checkpoint adds, commits, AND pushes in one step. On main/master (or a
// detached HEAD) that is a one-command way to land unreviewed work straight
// on the branch everything else builds from — with no PR gate in between.
// The fix is a branch guard before any git write: exit 3 on main, master, or
// detached HEAD, with no commit and no push attempted.
//
// Real sandbox, not mocks: a bare "remote" plus a clone, same fixture shape
// as tests/pr-cleanup-safety.test.ts — the property under test is what git
// actually does (does a commit land, does the remote tip move), which a
// mocked `git` can't disprove.
//
// The `git add -A` vs `add -u` question (#225 gap 1, second half) is a
// separate, unresolved fork — not covered here. This suite only tests the
// branch guard.
//
// Run with: bun tests/git-checkpoint-guard.test.ts

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GIT_CHECKPOINT = path.join(REPO_ROOT, "bin", "git-checkpoint");

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
	// Cut the developer's git config out of the sandbox (#228). This developer has
	// `push.autoSetupRemote=true` set globally, which makes a bare `git push`
	// succeed on a branch with no upstream; a machine without it fails on the same
	// command. Inheriting that meant the happy path below was measuring the host,
	// and git-checkpoint's behaviour on a fresh clone went untested until the suite
	// was run under an empty $HOME. /dev/null reads as an empty config file, so the
	// sandbox behaves identically here, on a new laptop, and on a CI runner.
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
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
	remote: string;
	clone: string;
	primary: string;
}

function makeSandbox(primary: "main" | "master" = "main"): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-checkpoint-guard-"));
	const remote = path.join(root, "remote.git");
	fs.mkdirSync(remote);
	git(remote, ["init", "-q", "--bare", "-b", primary]);

	const clone = path.join(root, "clone");
	git(root, ["clone", "-q", remote, clone]);
	fs.writeFileSync(path.join(clone, "README.md"), "base\n");
	git(clone, ["add", "-A"]);
	git(clone, ["commit", "-q", "-m", "base"]);
	git(clone, ["push", "-q", "origin", primary]);

	return { root, remote, clone, primary };
}

function runCheckpoint(
	cwd: string,
	msg = "test commit",
	opts: { args?: string[]; env?: Record<string, string> } = {},
): { code: number; out: string } {
	try {
		const out = execFileSync("bash", [GIT_CHECKPOINT, ...(opts.args ?? []), msg], {
			cwd,
			encoding: "utf8",
			env: { ...process.env, ...GIT_ENV, ...(opts.env ?? {}) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}

// --- fake `gh` (#368) ---
// git-checkpoint asks `gh repo view` who owns this repo, then `gh pr list --head
// <branch> --state open` whether one of OUR PRs is open on it. The whole point of
// the change is what happens on each outcome, so the tests drive all of them —
// including the failure one, which is unreachable against the real gh without
// breaking the network.
//
// `mode` maps to the contract git-checkpoint relies on:
//   "open"    -> exit 0, one PR whose head repo is ours   (a PR is open)
//   "fork"    -> exit 0, one PR whose head repo is NOT ours (#369)
//   "none"    -> exit 0, `[]`                             (no PR)
//   "fail"    -> exit 1                                   (gh broke / not logged in)
//   "missing" -> no gh on PATH at all
// Returns the env overlay that puts the fake first on PATH.
//
// `fork` was added for macroscopeapp's High finding on PR #369: `--head` matches
// a branch NAME across every fork, so a stranger's identically named branch used
// to answer for ours and withhold the push. Proving that fix needs a stub that
// DISPATCHES on the subcommand (the script now asks `gh repo view` first) and
// APPLIES the `--jq` filter it was given — a stub that echoes one canned blob for
// every invocation would pass the fork case without exercising the filter at all,
// which is the vacuous-assertion trap #362's suite was rewritten to avoid.
function fakeGh(sb: Sandbox, mode: "open" | "fork" | "none" | "fail" | "missing"): Record<string, string> {
	const binDir = path.join(sb.root, `fakebin-${mode}`);
	fs.mkdirSync(binDir, { recursive: true });
	if (mode !== "missing") {
		// One PR on the branch. In `fork` mode it belongs to somebody else's
		// fork, which is exactly what `--head` alone cannot tell apart.
		const payload =
			mode === "open"
				? '[{"number":42,"headRepositoryOwner":{"login":"test-owner"}}]'
				: mode === "fork"
					? '[{"number":42,"headRepositoryOwner":{"login":"a-stranger"}}]'
					: "[]";
		const body =
			mode === "fail"
				? 'echo "gh: could not reach api.github.com" >&2; exit 1'
				: [
						'case "$1 $2" in',
						'  "repo view") echo "test-owner"; exit 0 ;;',
						'  "pr list")',
						`    payload=${JSON.stringify(payload)}`,
						'    filter=""; prev=""',
						'    for a in "$@"; do [ "$prev" = "--jq" ] && filter="$a"; prev="$a"; done',
						'    if [ -n "$filter" ]; then printf "%s" "$payload" | jq -r "$filter"; else printf "%s\\n" "$payload"; fi',
						"    exit 0 ;;",
						"esac",
						'echo "fake gh: unexpected: $*" >&2; exit 1',
					].join("\n");
		fs.writeFileSync(path.join(binDir, "gh"), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
	}
	// PATH is replaced, not prepended, for "missing" — otherwise the real gh on
	// this developer's PATH would answer and the test would measure the host.
	return { PATH: mode === "missing" ? `${binDir}:/usr/bin:/bin` : `${binDir}:${process.env.PATH}` };
}

function tip(repo: string, ref = "HEAD"): string {
	return git(repo, ["rev-parse", ref]);
}

console.log("git-checkpoint: refuses to commit+push on the primary branch (#225 gap 1)");

// --- on main: refuse, no commit, remote tip unchanged ---
console.log("\non main:");
{
	const sb = makeSandbox("main");
	const before = tip(sb.clone);
	const remoteBefore = tip(sb.remote, "refs/heads/main");
	fs.writeFileSync(path.join(sb.clone, "scratch.txt"), "uncommitted change\n");
	const { code, out } = runCheckpoint(sb.clone);
	check(code === 3, "on main → exit 3", `got ${code}, output:\n${out}`);
	check(tip(sb.clone) === before, "on main → no commit created", out);
	check(tip(sb.remote, "refs/heads/main") === remoteBefore, "on main → remote tip unchanged", out);
	check(/main/.test(out), "on main → mentions the branch name", out);
}

// --- on master: same guard applies ---
console.log("\non master:");
{
	const sb = makeSandbox("master");
	const before = tip(sb.clone);
	const remoteBefore = tip(sb.remote, "refs/heads/master");
	fs.writeFileSync(path.join(sb.clone, "scratch.txt"), "uncommitted change\n");
	const { code, out } = runCheckpoint(sb.clone);
	check(code === 3, "on master → exit 3", `got ${code}, output:\n${out}`);
	check(tip(sb.clone) === before, "on master → no commit created", out);
	check(tip(sb.remote, "refs/heads/master") === remoteBefore, "on master → remote tip unchanged", out);
}

// --- detached HEAD: refuse ---
console.log("\ndetached HEAD:");
{
	const sb = makeSandbox("main");
	const before = tip(sb.clone);
	git(sb.clone, ["checkout", "-q", "--detach", "HEAD"]);
	fs.writeFileSync(path.join(sb.clone, "scratch.txt"), "uncommitted change\n");
	const { code, out } = runCheckpoint(sb.clone);
	check(code === 3, "detached HEAD → exit 3", `got ${code}, output:\n${out}`);
	check(tip(sb.clone) === before, "detached HEAD → no commit created", out);
	check(/detached/i.test(out), "detached HEAD → says detached", out);
}

// --- no upstream: refuse before committing, and say what is missing (#228) ---
// wt-new pushes every branch with its upstream set, so a branch without one is off
// the sanctioned path. git-checkpoint does not paper over it by creating the remote
// branch — it names the missing config. Asserted here rather than left to whatever
// `push.autoSetupRemote` the runner happens to have (see GIT_ENV above).
console.log("\non a feature branch with NO upstream:");
{
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	const before = tip(sb.clone);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const { code, out } = runCheckpoint(sb.clone, "feat: add widget (#42)");
	check(code === 3, "no upstream → exit 3 (precondition)", `got ${code}, output:\n${out}`);
	check(/no upstream/i.test(out), "no upstream → says the branch has no upstream", out);
	check(/push\.autoSetupRemote/.test(out), "no upstream → names the config that fixes it", out);
	check(/--set-upstream origin 42-feature/.test(out), "no upstream → gives the one-branch escape hatch", out);
	check(tip(sb.clone) === before, "no upstream → refuses BEFORE committing, so a re-run works", out);
}

// --- happy path: feature branch commit + push must not regress ---
console.log("\non a feature branch (happy path):");
{
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	// The upstream wt-new would have created.
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const { code, out } = runCheckpoint(sb.clone, "feat: add widget (#42)");
	check(code === 0, "feature branch → exit 0", `got ${code}, output:\n${out}`);
	const localTip = tip(sb.clone);
	let remoteTip = "";
	try {
		remoteTip = tip(sb.remote, "refs/heads/42-feature");
	} catch {
		/* left empty — checked below */
	}
	check(remoteTip === localTip, "feature branch → pushed and remote tip matches local", out);
	check(/👑π🐱/.test(git(sb.clone, ["log", "-1", "--format=%s"])), "feature branch → commit message carries the signature", out);
}

// --- #310: a flag is never a commit message ---
// `git-checkpoint --help` once committed AND pushed with the message "--help 👑π🐱"
// (commit 93f1151 on 308-wtft-lagging-session). Same sandbox: the property is
// that no commit lands and the remote tip does not move.
console.log("\n#310 — flags are not messages:");
{
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const before = tip(sb.clone);
	const remoteBefore = tip(sb.remote, "refs/heads/42-feature");

	for (const flag of ["--help", "-h"]) {
		const { code, out } = runCheckpoint(sb.clone, flag);
		check(code === 0, `${flag} → exit 0`, `got ${code}, output:\n${out}`);
		check(/usage/i.test(out) && /git-checkpoint/.test(out), `${flag} → prints usage`, out);
		check(tip(sb.clone) === before, `${flag} → no commit created`, out);
		check(tip(sb.remote, "refs/heads/42-feature") === remoteBefore, `${flag} → remote tip unchanged`, out);
	}
	{
		const { code, out } = runCheckpoint(sb.clone, "--not-a-flag");
		// 2, not 1, since #366: one usage-error vocabulary across the shipped family.
		// `install-workflow-tools`' 64 (sysexits) is the single documented exception.
		check(code === 2, "unknown -flag → exit 2 (usage error, #224 table)", `got ${code}, output:\n${out}`);
		check(/--not-a-flag/.test(out) && /--/.test(out), "unknown -flag → names it and points at `--` for a message that starts with '-'", out);
		check(tip(sb.clone) === before, "unknown -flag → no commit created", out);
	}
	{
		// `--` ends flag parsing: a message that genuinely starts with '-' is still possible.
		let code = -1, out = "";
		try {
			out = execFileSync("bash", [GIT_CHECKPOINT, "--", "-dashy message (#310)"], { cwd: sb.clone, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
			code = 0;
		} catch (err: any) { code = err?.status ?? -1; out = `${err?.stdout || ""}${err?.stderr || ""}`; }
		check(code === 0, "`-- -dashy message` → exit 0 (committed)", `got ${code}, output:\n${out}`);
		check(/^-dashy message \(#310\) 👑π🐱$/.test(git(sb.clone, ["log", "-1", "--format=%s"])), "`--` → the dash-leading message is the commit subject", git(sb.clone, ["log", "-1", "--format=%s"]));
	}
}

// --- #368: while a PR is open, commit locally and batch the push ---
// Macroscope bills a $0.50 floor per review run and re-reviews on every push:
// 157 of 269 runs over 8 days were re-reviews, $64.58, 45% of spend (btw#59).
// Pushes made BEFORE a PR exists cost nothing — the opening review bundles them
// (measured: first review fires within seconds of PR creation on 7-11 commit
// PRs). So the push is withheld only while a PR is open, and only then.
//
// The property under test is the remote tip, not the log text: "batched" means
// the commit exists locally and origin has not moved.
console.log("\n#368 — batch the push while a PR is open:");
{
	// open PR → commit lands, remote does NOT move, and the user is told how to send it
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	const remoteBefore = tip(sb.remote, "refs/heads/42-feature");
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const { code, out } = runCheckpoint(sb.clone, "fix: address review (#42)", { env: fakeGh(sb, "open") });
	check(code === 0, "open PR → exit 0", `got ${code}, output:\n${out}`);
	check(tip(sb.clone) !== remoteBefore, "open PR → commit still created locally", out);
	check(tip(sb.remote, "refs/heads/42-feature") === remoteBefore, "open PR → remote tip UNCHANGED (push batched)", out);
	check(/git push/.test(out), "open PR → names the command that sends the batch", out);
	check(/#42|PR/.test(out), "open PR → says why the push was held", out);
}
{
	// a second checkpoint keeps batching, and the pending count grows
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	const remoteBefore = tip(sb.remote, "refs/heads/42-feature");
	const env = fakeGh(sb, "open");
	fs.writeFileSync(path.join(sb.clone, "a.txt"), "1\n");
	runCheckpoint(sb.clone, "fix: one (#42)", { env });
	fs.writeFileSync(path.join(sb.clone, "b.txt"), "2\n");
	const { out } = runCheckpoint(sb.clone, "fix: two (#42)", { env });
	check(tip(sb.remote, "refs/heads/42-feature") === remoteBefore, "open PR → still unpushed after two checkpoints", out);
	check(/\b2\b/.test(out), "open PR → reports the pending-commit count (2)", out);
}
{
	// no open PR → today's behaviour exactly: push. This is the pre-PR phase,
	// where the push is free and losing work is the real risk.
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const { code, out } = runCheckpoint(sb.clone, "feat: widget (#42)", { env: fakeGh(sb, "none") });
	check(code === 0, "no PR → exit 0", `got ${code}, output:\n${out}`);
	check(tip(sb.remote, "refs/heads/42-feature") === tip(sb.clone), "no PR → pushed, remote matches local", out);
}
{
	// --push overrides the batching: sometimes you WANT the re-review now
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const { code, out } = runCheckpoint(sb.clone, "fix: ready for re-review (#42)", { args: ["--push"], env: fakeGh(sb, "open") });
	check(code === 0, "--push with open PR → exit 0", `got ${code}, output:\n${out}`);
	check(tip(sb.remote, "refs/heads/42-feature") === tip(sb.clone), "--push with open PR → pushes anyway", out);
}
{
	// gh broken → FALL BACK TO PUSHING. A missed detection costs $0.50; a
	// wrongly-withheld push risks the work. Fail open toward the old behaviour.
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const { code, out } = runCheckpoint(sb.clone, "feat: widget (#42)", { env: fakeGh(sb, "fail") });
	check(code === 0, "gh fails → exit 0", `got ${code}, output:\n${out}`);
	check(tip(sb.remote, "refs/heads/42-feature") === tip(sb.clone), "gh fails → pushes (fails open, work protected)", out);
}
{
	// gh not installed at all → same fail-open path
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const { code, out } = runCheckpoint(sb.clone, "feat: widget (#42)", { env: fakeGh(sb, "missing") });
	check(code === 0, "no gh on PATH → exit 0", `got ${code}, output:\n${out}`);
	check(tip(sb.remote, "refs/heads/42-feature") === tip(sb.clone), "no gh on PATH → pushes (fails open)", out);
}

{
	// macroscopeapp on PR #369, High: an open PR on an identically named branch in
	// SOMEBODY ELSE'S FORK satisfied `--head` and withheld this branch's push. The
	// failure is silent and unbounded — nothing here has a PR, so nothing ever
	// tells you the commits are piling up locally. Same fork-collision guard
	// bin/pr-reject and bin/pr-merge have carried since #209.
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const { code, out } = runCheckpoint(sb.clone, "feat: widget (#42)", { env: fakeGh(sb, "fork") });
	check(code === 0, "fork's PR on same branch name → exit 0", `got ${code}, output:\n${out}`);
	check(tip(sb.remote, "refs/heads/42-feature") === tip(sb.clone),
		"fork's PR on same branch name → pushes (not OUR PR)", out);
}
{
	// macroscopeapp on PR #369, Low: `--push` shifted itself out of a single
	// `case`, so the `--` terminator and the flag-shaped-message refusal never
	// ran against what followed. `git-checkpoint --push -- "-fix"` committed the
	// message `--`. This is #310 reopening through a flag added after it.
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	let code = -1, out = "";
	try {
		out = execFileSync("bash", [GIT_CHECKPOINT, "--push", "--", "-fix: dashy (#42)"],
			{ cwd: sb.clone, encoding: "utf8", env: { ...process.env, ...GIT_ENV, ...fakeGh(sb, "none") }, stdio: ["ignore", "pipe", "pipe"] });
		code = 0;
	} catch (err: any) { code = err?.status ?? -1; out = `${err?.stdout || ""}${err?.stderr || ""}`; }
	check(code === 0, "--push -- <dashy message> → exit 0", `got ${code}, output:\n${out}`);
	check(git(sb.clone, ["log", "-1", "--format=%s"]) === "-fix: dashy (#42) 👑π🐱",
		"--push -- <dashy message> → the message survives, not `--`",
		git(sb.clone, ["log", "-1", "--format=%s"]));
}

// --- #369 review: --push must not become a hole in the #310 flag guard ---
// The first cut parsed flags with a single `case`, so `--push` shifted and
// whatever followed became the commit message: `git-checkpoint --push --help`
// committed "--help", reopening exactly the bug #310 closed. The parser now
// loops, so every flag is re-checked after each shift.
console.log("\n#369 — --push does not bypass flag validation:");
{
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const before = tip(sb.clone);
	const env = fakeGh(sb, "none");
	{
		// #367 (merged from main) makes -h/--help/--version TERMINAL: they take no
		// other arguments. So `--push --help` is a usage error, not a help screen —
		// and either way it must never commit.
		const { code, out } = runCheckpoint(sb.clone, "--help", { args: ["--push"], env });
		// exit 2, not 1, since #366 — see the allowlist note in
		// tests/shipped-script-help.test.ts. This assertion was written on the #368
		// branch while main still said 1; the rebase merged the code cleanly and
		// left the expectation behind, which is the half git cannot see.
		check(code === 2, "--push --help → exit 2 (#367: terminal flags take no other args)", `got ${code}: ${out}`);
		check(tip(sb.clone) === before, "--push --help → no commit created", out);
	}
	{
		const { code, out } = runCheckpoint(sb.clone, "--not-a-flag", { args: ["--push"], env });
		check(code === 2, "--push --not-a-flag → exit 2 (usage error, #366)", `got ${code}: ${out}`);
		check(tip(sb.clone) === before, "--push --not-a-flag → no commit created", out);
	}
	{
		// `--push -- "-dashy"` must commit the dash-leading MESSAGE, not "--"
		const { code } = runCheckpoint(sb.clone, "-dashy (#369)", { args: ["--push", "--"], env });
		const subj = git(sb.clone, ["log", "-1", "--format=%s"]);
		check(code === 0, "--push -- -dashy → exit 0", subj);
		check(/^-dashy \(#369\) 👑π🐱$/.test(subj), "--push -- -dashy → message is the subject, not '--'", subj);
	}
}
{
	// An identically-named branch on somebody else's fork must not hold our push.
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
	git(sb.clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	fs.writeFileSync(path.join(sb.clone, "feature.txt"), "work\n");
	const { code, out } = runCheckpoint(sb.clone, "feat: widget (#42)", { env: fakeGh(sb, "otherfork") });
	check(code === 0, "fork's same-named branch → exit 0", `got ${code}: ${out}`);
	check(
		tip(sb.remote, "refs/heads/42-feature") === tip(sb.clone),
		"fork's same-named branch → pushes (that PR is not ours)",
		out,
	);
}

console.log(`\n${failures === 0 ? "✅" : "❌"} git-checkpoint guard: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
