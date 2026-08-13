// wt-new: one command for the worktree dance, correct upstream from minute
// one (#250 scope item 1).
//
// Same real-sandbox pattern as tests/pr-cleanup-safety.test.ts: a bare
// "remote", and a main clone — no linked worktree pre-created here, since
// wt-new's whole job is creating that worktree. What's under test is git's
// actual behavior — `git worktree add`'s upstream-from-start-point default
// (the trap), `--git-dir` vs `--git-common-dir` divergence inside a linked
// worktree, and origin's HEAD symref detection — none of which a mock can
// stand in for without encoding the very assumption the trap disproves.
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
