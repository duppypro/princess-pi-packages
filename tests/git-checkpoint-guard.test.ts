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

// --- happy path: feature branch commit + push must not regress ---
console.log("\non a feature branch (happy path):");
{
	const sb = makeSandbox("main");
	git(sb.clone, ["checkout", "-q", "-b", "42-feature"]);
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

console.log(`\n${failures === 0 ? "✅" : "❌"} git-checkpoint guard: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
