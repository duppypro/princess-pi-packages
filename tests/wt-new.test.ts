// wt-new: one command for the worktree dance, correct upstream from minute
// one (#250 scope item 1).
//
// Same real-sandbox pattern as tests/pr-cleanup-safety.test.ts: a bare
// "remote", and a main clone — no linked worktree pre-created here, since
// wt-new's whole job is creating that worktree. What's under test is git's
// actual behavior — `git worktree add`'s upstream-from-start-point default
// (the trap), `--git-dir` vs `--git-common-dir` divergence inside a linked
// worktree, and primary-branch detection via `git ls-remote --symref origin
// HEAD` (not the local, fetch-doesn't-refresh-it `refs/remotes/origin/HEAD`
// symref — princess-pi-packages#221 finding 1) — none of which a mock can
// stand in for without encoding the very assumption each of these disproves.
//
// The load-bearing case is the upstream trap: #250 found LIVE that
// `git worktree add -b <branch> origin/main` leaves a bare `git push`
// targeting origin/main. Every other case here is a standard fail-closed
// precondition; this one is the reason the script exists.
//
// HERDR_WORKSPACE_ID and TMUX are stripped from every run below. This
// session may itself be running inside a herdr workspace (it is, in
// practice) — inheriting that would make wt-new try to open a REAL tab in
// the live session on every test run, which the task explicitly rules out.
// Stripping both env vars exercises (and is the only safe way to exercise)
// the "neither herdr nor tmux" fallback: the worktree must still be created
// and the script must still exit 0.
//
// Run with: bun run test wt-new

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WT_NEW = path.join(REPO_ROOT, "bin", "wt-new");

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
	remote: string;
	clone: string;
	primary: string;
}

function makeSandbox(opts: { primary?: string } = {}): Sandbox {
	const primary = opts.primary ?? "main";
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-new-"));
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

// `makeSandbox` above clones an EMPTY bare remote and pushes content only
// AFTER cloning — deliberately, so its own tests aren't coupled to symref
// behavior. That means it never actually exercises a local
// `refs/remotes/origin/HEAD` symref: `git clone` only writes that symref
// when the remote's HEAD already resolves to a branch that exists at clone
// time, and an empty bare repo's HEAD is unborn. The #221-finding-1 tests
// below are specifically about that symref going stale, so they need one
// that's real to begin with — seed the remote via a throwaway push-capable
// clone BEFORE the clone under test.
function makeSandboxWithRealOriginHead(opts: { primary?: string } = {}): Sandbox {
	const primary = opts.primary ?? "main";
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-new-"));
	const remote = path.join(root, "remote.git");
	fs.mkdirSync(remote);
	git(remote, ["init", "-q", "--bare", "-b", primary]);

	const seed = path.join(root, "seed");
	git(root, ["init", "-q", "-b", primary, seed]);
	fs.writeFileSync(path.join(seed, "README.md"), "base\n");
	git(seed, ["add", "-A"]);
	git(seed, ["commit", "-q", "-m", "base"]);
	git(seed, ["remote", "add", "origin", remote]);
	git(seed, ["push", "-q", "origin", `${primary}:${primary}`]);

	const clone = path.join(root, "clone");
	git(root, ["clone", "-q", remote, clone]);

	return { root, remote, clone, primary };
}

// Strips HERDR_WORKSPACE_ID and TMUX (see header) — this is the ONLY way
// these tests run wt-new. `envOverride` lets a case add other overrides
// (e.g. a broken origin) without reintroducing either.
//
// spawnSync, not execFileSync: wt-new deliberately keeps stdout to a single
// clean final line (the path, for `EnterWorktree { path: ... }`) and puts
// every progress/warning line on stderr instead — matching pr-open's own
// convention of warning on stderr even on a successful (exit 0) run.
// execFileSync only returns stdout on success and merges both streams into
// `err.stdout`/`err.stderr` on failure, which made every stderr-only line
// invisible to a passing case. spawnSync exposes stdout and stderr
// separately, on every exit code, so both `stdout` (the path contract) and
// `out` (everything, for prose assertions) can be checked from any case.
function runWtNew(
	cwd: string,
	args: string[],
	envOverride: Record<string, string> = {},
): { code: number; stdout: string; stderr: string; out: string } {
	const r = spawnSync("bash", [WT_NEW, ...args], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			...GIT_ENV,
			HERDR_WORKSPACE_ID: "",
			HERDR_SOCKET_PATH: "",
			TMUX: "",
			...envOverride,
		},
	});
	const stdout = r.stdout ?? "";
	const stderr = r.stderr ?? "";
	return { code: r.status ?? -1, stdout, stderr, out: `${stdout}${stderr}` };
}

function wtPathFor(clone: string, branch: string): string {
	return path.join(clone, ".claude", "worktrees", branch);
}

// ---
// Cases
// ---

console.log("wt-new: worktree dance + correct upstream from minute one (#250)");

// --- happy path: in-tree location, never out-of-tree ---
console.log("\nhappy path — creates the worktree IN-TREE:");
{
	const sb = makeSandbox();
	const { code, out, stdout } = runWtNew(sb.clone, ["250-wt-new"]);
	const wt = wtPathFor(sb.clone, "250-wt-new");
	check(code === 0, "exits 0", `got ${code}, output:\n${out}`);
	check(fs.existsSync(wt), "worktree exists at <clone>/.claude/worktrees/<branch>", out);
	check(
		stdout.trim() === wt,
		"stdout is EXACTLY the created path — nothing else (for EnterWorktree { path: ... })",
		`stdout:\n${stdout}`,
	);
	check(
		!out.includes("git-projects/worktrees/"),
		"never the retired out-of-tree layout (~/git-projects/worktrees/<repo>/<branch>)",
		out,
	);
}

// --- THE UPSTREAM TRAP: the single most important correctness property ---
console.log("\nupstream regression test — THE TRAP (#250):");
{
	const sb = makeSandbox();
	const { code } = runWtNew(sb.clone, ["251-upstream-trap"]);
	check(code === 0, "setup: wt-new exits 0", `got ${code}`);
	const wt = wtPathFor(sb.clone, "251-upstream-trap");
	const upstream = git(wt, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
	check(upstream === "origin/251-upstream-trap", "upstream is origin/<branch>", `got '${upstream}'`);
	check(upstream !== "origin/main", "upstream is NOT origin/main (the trap)", `got '${upstream}'`);
}

// --- a bare `git push` from the new worktree must reach origin/<branch> and
// must NOT touch origin/main ---
console.log("\nbare `git push` from the new worktree:");
{
	const sb = makeSandbox();
	runWtNew(sb.clone, ["252-bare-push"]);
	const wt = wtPathFor(sb.clone, "252-bare-push");
	const mainBefore = git(sb.clone, ["rev-parse", "origin/main"]);

	fs.writeFileSync(path.join(wt, "extra.txt"), "work\n");
	git(wt, ["add", "-A"]);
	git(wt, ["commit", "-q", "-m", "extra work"]);
	// The bare form is the whole point of this test — see #250's header:
	// "a bare `git push` from that worktree targets `origin/main`" is
	// exactly the failure mode being regression-tested here.
	execFileSync("git", ["push"], { cwd: wt, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });

	const localTip = git(wt, ["rev-parse", "HEAD"]);
	const remoteBranchTip = git(sb.remote, ["rev-parse", "252-bare-push"]);
	const remoteMainTip = git(sb.remote, ["rev-parse", "main"]);

	check(remoteBranchTip === localTip, "bare push reached origin/252-bare-push", `remote: ${remoteBranchTip}, local: ${localTip}`);
	check(remoteMainTip === mainBefore, "bare push did NOT touch origin/main", `before: ${mainBefore}, after: ${remoteMainTip}`);
}

// --- refuses from inside an existing (linked) worktree ---
console.log("\nrefuses when run from inside an existing worktree:");
{
	const sb = makeSandbox();
	runWtNew(sb.clone, ["253-first"]);
	const wt = wtPathFor(sb.clone, "253-first");
	const { code, out } = runWtNew(wt, ["254-second"]);
	check(code === 3, "exits with the precondition code (3)", `got ${code}, output:\n${out}`);
	check(!fs.existsSync(wtPathFor(sb.clone, "254-second")), "no worktree created for the refused branch", out);
	check(!git(sb.clone, ["branch", "--list", "254-second"]).length, "no local branch created for the refused branch", "");
}

// --- refuses when the target path already exists ---
console.log("\nrefuses when the target path already exists:");
{
	const sb = makeSandbox();
	const wt = wtPathFor(sb.clone, "255-exists");
	fs.mkdirSync(wt, { recursive: true });
	fs.writeFileSync(path.join(wt, "placeholder.txt"), "pre-existing\n");
	const { code, out } = runWtNew(sb.clone, ["255-exists"]);
	check(code === 6, "exits with the safety-gate code (6)", `got ${code}, output:\n${out}`);
	check(fs.existsSync(path.join(wt, "placeholder.txt")), "pre-existing directory contents untouched", out);
}

// --- refuses when the branch already exists locally ---
console.log("\nrefuses when the branch already exists (local):");
{
	const sb = makeSandbox();
	git(sb.clone, ["branch", "256-exists-local"]);
	const { code, out } = runWtNew(sb.clone, ["256-exists-local"]);
	check(code === 6, "exits with the safety-gate code (6)", `got ${code}, output:\n${out}`);
	check(!fs.existsSync(wtPathFor(sb.clone, "256-exists-local")), "no worktree created", out);
}

// --- refuses when the branch already exists on origin (not yet local) ---
console.log("\nrefuses when the branch already exists (origin only):");
{
	const sb = makeSandbox();
	const other = path.join(sb.root, "other-clone");
	git(sb.root, ["clone", "-q", sb.remote, other]);
	git(other, ["checkout", "-q", "-b", "257-exists-remote"]);
	fs.writeFileSync(path.join(other, "x.txt"), "x\n");
	git(other, ["add", "-A"]);
	git(other, ["commit", "-q", "-m", "from another clone"]);
	git(other, ["push", "-q", "origin", "257-exists-remote"]);

	const { code, out } = runWtNew(sb.clone, ["257-exists-remote"]);
	check(code === 6, "exits with the safety-gate code (6)", `got ${code}, output:\n${out}`);
	check(!fs.existsSync(wtPathFor(sb.clone, "257-exists-remote")), "no worktree created", out);
}

// --- master-primary repo: primary branch must be detected, not hard-coded ---
console.log("\nmaster-primary repo:");
{
	const sb = makeSandbox({ primary: "master" });
	const { code, out } = runWtNew(sb.clone, ["258-master-primary"]);
	const wt = wtPathFor(sb.clone, "258-master-primary");
	check(code === 0, "exits 0 in a master-primary repo", `got ${code}, output:\n${out}`);
	check(fs.existsSync(wt), "worktree created", out);
	const upstream = git(wt, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
	check(upstream === "origin/258-master-primary", "upstream is origin/<branch>, not origin/master", `got '${upstream}'`);
	// Prove the branch was actually started FROM master's content, not just
	// that the upstream string happens to be right — the branch point matters.
	let startedFromMaster = false;
	try {
		git(sb.clone, ["merge-base", "--is-ancestor", "master", "258-master-primary"]);
		startedFromMaster = true; // exit 0 = ancestor
	} catch {
		startedFromMaster = false;
	}
	check(startedFromMaster, "branch point descends from origin/master", "");
}

// --- stale local origin/HEAD symref after the remote's default branch
// changes (#221 finding 1): `git fetch` does NOT refresh
// `refs/remotes/origin/HEAD` — verified directly below — so wt-new must ask
// the server (`git ls-remote --symref origin HEAD`) rather than trust that
// local symref, or a default-branch rename/flip silently branches (and
// pushes) from the WRONG, stale primary. ---
console.log("\nstale local origin/HEAD after the remote's default branch changes (#221 finding 1):");
{
	const sb = makeSandboxWithRealOriginHead(); // primary "main", REAL origin/HEAD symref

	// Create a second branch with a commit NOT on main, push it, then flip
	// the remote's default HEAD to it WITHOUT touching main — the realistic
	// case (a GitHub default-branch flip, or a rename that leaves the old
	// branch around). The extra file is what lets the assertions below tell
	// "branched from the stale primary" apart from "branched from the
	// current one": same-SHA branches would prove nothing.
	git(sb.clone, ["checkout", "-q", "-b", "newmain"]);
	fs.writeFileSync(path.join(sb.clone, "newmain-only.txt"), "newmain\n");
	git(sb.clone, ["add", "-A"]);
	git(sb.clone, ["commit", "-q", "-m", "newmain-only commit"]);
	git(sb.clone, ["push", "-q", "origin", "newmain"]);
	git(sb.clone, ["checkout", "-q", sb.primary]);
	git(sb.remote, ["symbolic-ref", "HEAD", "refs/heads/newmain"]);

	const { code, out } = runWtNew(sb.clone, ["260-stale-head"]);
	const wt = wtPathFor(sb.clone, "260-stale-head");
	check(code === 0, "exits 0 despite the remote's default branch having changed", `got ${code}, output:\n${out}`);
	check(fs.existsSync(wt), "worktree created", out);

	// Sanity: confirm wt-new's own `git fetch` really did leave the local
	// symref stale — otherwise this test would not be exercising the bug at
	// all.
	const staleLocalSymref = git(sb.clone, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
	check(
		staleLocalSymref === `origin/${sb.primary}`,
		"sanity: local origin/HEAD symref is confirmed STALE after wt-new's fetch (the bug this test guards)",
		`got '${staleLocalSymref}'`,
	);

	const upstream = git(wt, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
	check(upstream === "origin/260-stale-head", "upstream is origin/<branch>", `got '${upstream}'`);
	check(
		fs.existsSync(path.join(wt, "newmain-only.txt")),
		"branched from the NEW primary (newmain) — has newmain-only.txt",
		out,
	);
}

// --- absent origin/HEAD symref: the main/master fallback, previously
// untested because `git clone` always writes the symref. `git remote
// set-head origin -d` is the only way to reach this state. Also proves
// server-side detection (`git ls-remote --symref`) needs no local symref at
// all — it works identically whether that symref is fresh, stale, or gone.
console.log("\nabsent origin/HEAD symref — server-side detection still works (#221 finding 1 fallback):");
{
	const sb = makeSandbox();
	git(sb.clone, ["remote", "set-head", "origin", "-d"]);
	let symrefGone = false;
	try {
		git(sb.clone, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
	} catch {
		symrefGone = true;
	}
	check(symrefGone, "sanity: local origin/HEAD symref is confirmed ABSENT before the run", "");

	const { code, out } = runWtNew(sb.clone, ["261-no-symref"]);
	const wt = wtPathFor(sb.clone, "261-no-symref");
	check(code === 0, "exits 0 even with no local origin/HEAD symref", `got ${code}, output:\n${out}`);
	check(fs.existsSync(wt), "worktree created", out);
	const upstream = git(wt, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
	check(upstream === "origin/261-no-symref", "upstream is origin/<branch>", `got '${upstream}'`);
	let branchedFromPrimary = false;
	try {
		git(sb.clone, ["merge-base", "--is-ancestor", `origin/${sb.primary}`, "261-no-symref"]);
		branchedFromPrimary = true;
	} catch {
		branchedFromPrimary = false;
	}
	check(branchedFromPrimary, "branch point descends from origin/main even with no local symref", "");
}

// --- neither herdr nor tmux: worktree still created, still exits 0 ---
console.log("\nno herdr session, no tmux — still creates the worktree and exits 0:");
{
	const sb = makeSandbox();
	const { code, out } = runWtNew(sb.clone, ["259-no-tab"]);
	const wt = wtPathFor(sb.clone, "259-no-tab");
	check(code === 0, "exits 0 with neither herdr nor tmux present", `got ${code}, output:\n${out}`);
	check(fs.existsSync(wt), "worktree still created", out);
	check(/no herdr session or tmux detected/i.test(out), "prints a friendly note that no tab was created", out);
	check(!/error/i.test(out), "the friendly note is not phrased as an error", out);
}

// --- initial push REJECTED by the remote (#224: a determined "no" → 6, not
// the undetermined-state code 5 the header used to claim unconditionally
// for every push failure). The worktree and branch are already created by
// this point — only the push itself is refused, by a pre-receive hook
// (stand-in for a protected-branch ruleset). ---
console.log("\ninitial push rejected by the remote (protected-branch hook) — exit 6, not 5:");
{
	const sb = makeSandbox();
	fs.mkdirSync(path.join(sb.remote, "hooks"), { recursive: true });
	fs.writeFileSync(
		path.join(sb.remote, "hooks", "pre-receive"),
		"#!/bin/sh\necho 'remote: protected branch — rejecting all pushes' >&2\nexit 1\n",
	);
	fs.chmodSync(path.join(sb.remote, "hooks", "pre-receive"), 0o755);

	const { code, out } = runWtNew(sb.clone, ["262-hook-rejected"]);
	const wt = wtPathFor(sb.clone, "262-hook-rejected");
	check(code === 6, "exits with the safety-gate-refused code (6), not git's raw exit 1 or the old blanket 5", `got ${code}, output:\n${out}`);
	check(fs.existsSync(wt), "worktree WAS created — only the push was refused", out);
	check(out.includes("wt-new:"), "message is wt-new's own", out);
	check(out.includes("rejected"), "message says the push was rejected", out);
	check(
		!git(sb.remote, ["branch", "--list", "262-hook-rejected"]).length,
		"the branch never landed on origin — the hook's rejection held",
		"",
	);
}

// --- initial push destination unreachable — undetermined, not a rejection.
// Fetch still succeeds (separate fetch URL, untouched); only the push
// destination is broken, so git exits 128 ("fatal: ..."), never 1, and
// wt-new must map that to 5, not 6 — nothing was determined here. ---
console.log("\ninitial push destination unreachable (undetermined) — exit 5, not 6:");
{
	const sb = makeSandbox();
	git(sb.clone, ["remote", "set-url", "--push", "origin", path.join(sb.root, "does-not-exist.git")]);

	const { code, out } = runWtNew(sb.clone, ["263-unreachable"]);
	const wt = wtPathFor(sb.clone, "263-unreachable");
	check(code === 5, "exits with the remote/API-failure code (5), not 6", `got ${code}, output:\n${out}`);
	check(fs.existsSync(wt), "worktree WAS created — only the push failed", out);
	check(out.includes("wt-new:"), "message is wt-new's own", out);
	check(!/rejected/i.test(out), "message does not claim the remote rejected it — it never got that far", out);
}

// --- usage errors ---
console.log("\nusage errors:");
{
	const sb = makeSandbox();
	{
		const { code, out } = runWtNew(sb.clone, []);
		check(code === 2, "no argument → usage error (2)", `got ${code}, output:\n${out}`);
	}
	{
		const { code, out } = runWtNew(sb.clone, ["not-a-valid-slug"]);
		check(code === 2, "malformed <issue#>-<slug> → usage error (2)", `got ${code}, output:\n${out}`);
	}
	{
		const { code, out } = runWtNew(sb.clone, ["main"]);
		check(code === 2, "'main' named explicitly → usage error (2)", `got ${code}, output:\n${out}`);
	}
}

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} wt-new: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
