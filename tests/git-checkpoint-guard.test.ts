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

function runCheckpoint(cwd: string, msg = "test commit"): { code: number; out: string } {
	try {
		const out = execFileSync("bash", [GIT_CHECKPOINT, msg], {
			cwd,
			encoding: "utf8",
			env: { ...process.env, ...GIT_ENV },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
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
		check(code === 1, "unknown -flag → exit 1 (usage error)", `got ${code}, output:\n${out}`);
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

console.log(`\n${failures === 0 ? "✅" : "❌"} git-checkpoint guard: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
