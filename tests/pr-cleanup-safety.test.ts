// --- pr-cleanup: every destructive path must fail CLOSED (#210) ---
//
// Real sandboxes, not mocks: a bare "remote", a main clone, and a linked
// worktree on the feature branch, plus a stub `gh` on PATH for the PR state.
// Every defect under test is about what git actually does — `git worktree
// remove` refusing a dirty tree, `ls-remote` failing on an unreachable remote,
// a push being rejected by receive.denyDeletes. None of that can be reproduced
// by a mock without encoding the very assumption the bug disproves.
//
// The shared property: when a check cannot PROVE its precondition, the script
// must abort, not assume the safe-to-delete case. Each case therefore asserts
// twice — that it exited non-zero, AND that the thing it might have destroyed
// is still there.
//
// Run with: bun run test pr-cleanup-safety

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PR_CLEANUP = path.join(REPO_ROOT, "bin", "pr-cleanup");

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
	mainClone: string;
	worktree: string;
	binDir: string;
	branch: string;
}

interface SandboxOpts {
	/** directory name for the main clone — use a name with a space to test parsing */
	cloneDirName?: string;
	/** stub gh reports a merged PR for the branch (default true) */
	prMerged?: boolean;
	/** override the headRefOid the stub PR reports (default: real branch tip) */
	headRefOid?: string;
	/** break the origin remote so ls-remote fails */
	breakRemote?: boolean;
	/** make the bare repo reject branch deletions */
	denyDeletes?: boolean;
	/** stub gh exits non-zero on `pr list` (outage / expired auth) */
	failGhList?: boolean;
	/** delete the branch from the remote before running (already cleaned up there) */
	remoteBranchGone?: boolean;
	/** primary branch name of the repo — 'master' exercises the non-main path */
	primary?: string;
	/** another clone pushed to origin/<branch> after the PR merged */
	remoteAdvanced?: boolean;
	/** leave a stale ref lock so `git branch -D` cannot delete the ref */
	staleRefLock?: boolean;
	/** shim `git` so ONLY ls-remote fails — fetch still succeeds */
	failLsRemote?: boolean;
}

function makeSandbox(branch: string, opts: SandboxOpts = {}): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-cleanup-"));
	const primary = opts.primary ?? "main";
	const remote = path.join(root, "remote.git");
	fs.mkdirSync(remote);
	git(remote, ["init", "-q", "--bare", "-b", primary]);

	const mainClone = path.join(root, opts.cloneDirName ?? "clone");
	git(root, ["clone", "-q", remote, mainClone]);
	fs.writeFileSync(path.join(mainClone, "README.md"), "base\n");
	git(mainClone, ["add", "-A"]);
	git(mainClone, ["commit", "-q", "-m", "base"]);
	git(mainClone, ["push", "-q", "origin", primary]);

	// feature branch, pushed, then "squash-merged" into main so the tip is
	// deliberately NOT an ancestor of main — the real shape after a squash.
	const worktree = path.join(root, "wt");
	git(mainClone, ["worktree", "add", "-q", "-b", branch, worktree]);
	fs.writeFileSync(path.join(worktree, "feature.txt"), "work\n");
	git(worktree, ["add", "-A"]);
	git(worktree, ["commit", "-q", "-m", "feature work"]);
	git(worktree, ["push", "-q", "-u", "origin", branch]);
	const branchTip = git(worktree, ["rev-parse", "HEAD"]);

	fs.writeFileSync(path.join(mainClone, "feature.txt"), "work\n");
	git(mainClone, ["add", "-A"]);
	git(mainClone, ["commit", "-q", "-m", `squash: feature work (#1)`]);
	git(mainClone, ["push", "-q", "origin", primary]);
	const mergeSha = git(mainClone, ["rev-parse", "HEAD"]);

	// Another clone lands a commit on origin/<branch> after the merge. OUR tip is
	// untouched, so the local-tip gate still passes — the remote is the only place
	// this commit exists.
	if (opts.remoteAdvanced) {
		const other = path.join(root, "other-clone");
		git(root, ["clone", "-q", "-b", branch, remote, other]);
		fs.writeFileSync(path.join(other, "late.txt"), "landed after the merge\n");
		git(other, ["add", "-A"]);
		git(other, ["commit", "-q", "-m", "late work from another clone"]);
		git(other, ["push", "-q", "origin", branch]);
	}

	// A stale .lock left by a crashed process: git refuses to update the ref, so
	// `branch -D` fails while the branch is still very much there. (A second
	// worktree holding the branch cannot be used — git won't check out a branch
	// that is already checked out in the feature worktree.)
	if (opts.staleRefLock) {
		const lock = path.join(mainClone, ".git", "refs", "heads", `${branch}.lock`);
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		fs.writeFileSync(lock, "");
	}

	if (opts.remoteBranchGone) git(remote, ["update-ref", "-d", `refs/heads/${branch}`]);
	if (opts.denyDeletes) git(remote, ["config", "receive.denyDeletes", "true"]);
	if (opts.breakRemote) {
		git(mainClone, ["remote", "set-url", "origin", path.join(root, "gone.git")]);
		git(worktree, ["remote", "set-url", "origin", path.join(root, "gone.git")]);
	}

	// --- stub gh ---
	const binDir = path.join(root, "stubbin");
	fs.mkdirSync(binDir);
	const prMerged = opts.prMerged !== false;
	const prJson = prMerged
		? JSON.stringify([
				{
					number: 1,
					mergeCommit: { oid: mergeSha },
					headRefOid: opts.headRefOid ?? branchTip,
					headRepositoryOwner: { login: "duppypro" },
				},
			])
		: "[]";
	fs.writeFileSync(path.join(root, "prlist.json"), prJson);
	const gh = `#!/usr/bin/env bash
jqexpr=""
prev=""
for a in "$@"; do
  case "$prev" in --jq|-q) jqexpr="$a" ;; esac
  prev="$a"
done
case "$1 $2" in
  "repo view") out='{"owner":{"login":"duppypro"},"nameWithOwner":"duppypro/princess-pi-packages"}' ;;
  "pr list")   ${opts.failGhList ? 'echo "gh: could not connect to api.github.com" >&2; exit 1' : ":"}
               out=$(cat ${JSON.stringify(path.join(root, "prlist.json"))}) ;;
  *) exit 0 ;;
esac
if [ -n "$jqexpr" ]; then printf '%s' "$out" | jq -r "$jqexpr"; else printf '%s\\n' "$out"; fi
`;
	fs.writeFileSync(path.join(binDir, "gh"), gh);
	fs.chmodSync(path.join(binDir, "gh"), 0o755);

	// Breaking the remote URL would abort at step 1's `git fetch`, never reaching
	// the ls-remote gate — the test would pass for the wrong reason. A shim that
	// fails ONLY ls-remote isolates the check under test.
	if (opts.failLsRemote) {
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const shim = `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "ls-remote" ]; then
    echo "fatal: could not read from remote repository" >&2
    exit 128
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`;
		fs.writeFileSync(path.join(binDir, "git"), shim);
		fs.chmodSync(path.join(binDir, "git"), 0o755);
	}

	return { root, remote, mainClone, worktree, binDir, branch };
}

function runCleanup(sb: Sandbox, cwd?: string): { code: number; out: string } {
	try {
		const out = execFileSync("bash", [PR_CLEANUP], {
			cwd: cwd ?? sb.worktree,
			encoding: "utf8",
			env: { ...process.env, ...GIT_ENV, PATH: `${sb.binDir}${path.delimiter}${process.env.PATH}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}

function localBranchExists(sb: Sandbox): boolean {
	try {
		git(sb.mainClone, ["rev-parse", "--verify", `refs/heads/${sb.branch}`]);
		return true;
	} catch {
		return false;
	}
}

function remoteBranchExists(sb: Sandbox): boolean {
	try {
		return git(sb.remote, ["for-each-ref", `refs/heads/${sb.branch}`]).length > 0;
	} catch {
		return false;
	}
}

// ---
// Cases
// ---

console.log("pr-cleanup: destructive paths must fail closed (#210)");

// --- happy path first: the fix must not break the thing that works ---
console.log("\nhappy path:");
{
	const sb = makeSandbox("42-feature");
	const { code, out } = runCleanup(sb);
	check(code === 0, "merged PR → exits 0", `got ${code}, output:\n${out}`);
	check(!fs.existsSync(sb.worktree), "merged PR → worktree removed", out);
	check(!localBranchExists(sb), "merged PR → local branch deleted", out);
	check(!remoteBranchExists(sb), "merged PR → remote branch deleted", out);
}

// --- finding: CWD=$(pwd) instead of the worktree top level ---
console.log("\nrun from a subdirectory (pwd vs --show-toplevel):");
{
	const sb = makeSandbox("42-feature");
	const sub = path.join(sb.worktree, "nested", "deeper");
	fs.mkdirSync(sub, { recursive: true });
	const { code, out } = runCleanup(sb, sub);
	check(code === 0, "run from a subdirectory → exits 0", `got ${code}, output:\n${out}`);
	check(!fs.existsSync(sb.worktree), "run from a subdirectory → worktree still removed", out);
}

// --- CRITICAL: --force retry destroys uncommitted work ---
console.log("\ndirty worktree (the --force retry):");
{
	const sb = makeSandbox("42-feature");
	const scratch = path.join(sb.worktree, "UNCOMMITTED.txt");
	fs.writeFileSync(scratch, "work that only exists here\n");
	const { code, out } = runCleanup(sb);
	check(code !== 0, "dirty worktree → non-zero", `got ${code}, output:\n${out}`);
	check(fs.existsSync(scratch), "dirty worktree → uncommitted file SURVIVES", out);
	check(fs.existsSync(sb.worktree), "dirty worktree → worktree not removed", out);
	check(!/Cleanup complete/.test(out), "dirty worktree → does not claim success", out);
}

// --- CRITICAL: ls-remote failure read as "branch absent" ---
console.log("\nunreachable remote (ls-remote failure vs branch absent):");
{
	const sb = makeSandbox("42-feature", { prMerged: false, breakRemote: true });
	const { code, out } = runCleanup(sb);
	check(code !== 0, "ls-remote fails → non-zero", `got ${code}, output:\n${out}`);
	check(fs.existsSync(sb.worktree), "ls-remote fails → worktree not removed", out);
	check(localBranchExists(sb), "ls-remote fails → local branch survives", out);
}

// --- CRITICAL: merged-PR gate never tied to the branch tip in hand ---
console.log("\nbranch tip ahead of the merged PR (reused name / later commits):");
{
	const sb = makeSandbox("42-feature");
	// commit AFTER the PR merged — headRefOid no longer matches the tip
	fs.writeFileSync(path.join(sb.worktree, "later.txt"), "not in any PR\n");
	git(sb.worktree, ["add", "-A"]);
	git(sb.worktree, ["commit", "-q", "-m", "work done after the merge"]);
	const { code, out } = runCleanup(sb);
	check(code !== 0, "tip ahead of headRefOid → non-zero", `got ${code}, output:\n${out}`);
	check(fs.existsSync(sb.worktree), "tip ahead of headRefOid → worktree survives", out);
	check(localBranchExists(sb), "tip ahead of headRefOid → local branch survives", out);
	check(/unmerged|not.*merged|ahead|does not match/i.test(out),
		"tip ahead of headRefOid → says why", out);
}

// --- swallowed push --delete failure reported as success ---
console.log("\nremote rejects the delete:");
{
	const sb = makeSandbox("42-feature", { denyDeletes: true });
	const { code, out } = runCleanup(sb);
	check(code !== 0, "remote delete rejected → non-zero", `got ${code}, output:\n${out}`);
	check(remoteBranchExists(sb), "remote delete rejected → remote branch still there (precondition)", out);
	check(!/Cleanup complete/.test(out), "remote delete rejected → does not claim success", out);
}

// --- gh itself failing must not fall through to the "no merged PR" branch ---
//
// The remote branch must ALREADY be gone for this to bite. With it still on
// origin, the ls-remote arm catches the case anyway ("exists on origin but no
// merged PR") and the hole never opens — a version of this test without
// remoteBranchGone passes against the unfixed script and proves nothing.
console.log("\ngh pr list fails, branch already gone from origin:");
{
	const sb = makeSandbox("42-feature", { failGhList: true, remoteBranchGone: true });
	const { code, out } = runCleanup(sb);
	check(code !== 0, "gh pr list fails → non-zero", `got ${code}, output:\n${out}`);
	check(fs.existsSync(sb.worktree), "gh pr list fails → worktree survives", out);
	check(localBranchExists(sb), "gh pr list fails → local branch survives", out);
	check(!/Cleanup complete/.test(out), "gh pr list fails → does not claim success", out);
}

// --- absence from origin is not authorization ---
//
// No merged PR and no remote ref is exactly the state of a branch that was
// never pushed, or whose remote was deleted WITHOUT merging. Its commits then
// exist nowhere else, and "nothing to verify" would authorize destroying the
// only copy.
console.log("\nno merged PR, branch absent from origin:");
{
	// unique local commits, nowhere else
	const sb = makeSandbox("42-feature", { prMerged: false, remoteBranchGone: true });
	const { code, out } = runCleanup(sb);
	check(code !== 0, "unique local commits → non-zero", `got ${code}, output:\n${out}`);
	check(fs.existsSync(sb.worktree), "unique local commits → worktree survives", out);
	check(localBranchExists(sb), "unique local commits → local branch survives", out);
	check(/not in origin\/main|nowhere else/i.test(out), "unique local commits → says why", out);
}
{
	// tip already contained in origin/main — nothing unique, so deletion is safe
	const sb = makeSandbox("42-feature", { prMerged: false, remoteBranchGone: true });
	git(sb.worktree, ["reset", "-q", "--hard", "origin/main"]);
	const { code, out } = runCleanup(sb);
	check(code === 0, "tip already in origin/main → exits 0", `got ${code}, output:\n${out}`);
	check(!fs.existsSync(sb.worktree), "tip already in origin/main → worktree removed", out);
	check(!localBranchExists(sb), "tip already in origin/main → local branch deleted", out);
}

// --- someone pushed to the remote branch after the PR merged ---
//
// Our local tip is untouched, so the headRefOid gate passes. The commit exists
// ONLY on origin/<branch>, so deleting that ref destroys it — and nothing about
// the local state hints at it.
console.log("\nremote branch advanced after the merge:");
{
	const sb = makeSandbox("42-feature", { remoteAdvanced: true });
	const { code, out } = runCleanup(sb);
	check(code !== 0, "remote advanced → non-zero", `got ${code}, output:\n${out}`);
	check(remoteBranchExists(sb), "remote advanced → remote branch SURVIVES", out);
	check(fs.existsSync(sb.worktree), "remote advanced → worktree survives (gate is before teardown)", out);
	check(localBranchExists(sb), "remote advanced → local branch survives", out);
	check(/moved since|remote tip/i.test(out), "remote advanced → says why", out);
}

// --- ls-remote failing in the MERGED-PR arm must abort, not read as "no ref" ---
//
// A failed ls-remote yields an empty REMOTE_TIP, which is indistinguishable from
// "the remote branch is already gone" — so the moved-since-merge check silently
// passes and teardown proceeds on unverified remote state.
console.log("\nls-remote fails while verifying the remote tip:");
{
	const sb = makeSandbox("42-feature", { failLsRemote: true });
	const { code, out } = runCleanup(sb);
	check(code !== 0, "ls-remote fails in the merged arm → non-zero", `got ${code}, output:\n${out}`);
	check(fs.existsSync(sb.worktree), "ls-remote fails → worktree survives", out);
	check(remoteBranchExists(sb), "ls-remote fails → remote branch survives", out);
	check(localBranchExists(sb), "ls-remote fails → local branch survives", out);
	check(/ls-remote/.test(out), "ls-remote fails → names ls-remote, not the fetch", out);
}

// --- `git branch -D` failing must not be read as "already gone" ---
console.log("\nlocal branch delete blocked by a stale ref lock:");
{
	const sb = makeSandbox("42-feature", { staleRefLock: true });
	const { code, out } = runCleanup(sb);
	check(code !== 0, "branch -D fails → non-zero", `got ${code}, output:\n${out}`);
	check(localBranchExists(sb), "branch -D fails → branch still exists (precondition)", out);
	check(!/Cleanup complete/.test(out), "branch -D fails → does not claim success", out);
}

// --- master-primary repo: the ref name must be discovered, not assumed ---
//
// The main-clone lookup accepts main OR master; hard-coding origin/main
// downstream would abort every legitimate cleanup here, blaming the merge
// commit — a wrong answer wearing a confident error message.
console.log("\nmaster-primary repo:");
{
	const sb = makeSandbox("42-feature", { primary: "master" });
	const { code, out } = runCleanup(sb);
	check(code === 0, "master-primary → exits 0", `got ${code}, output:\n${out}`);
	check(!fs.existsSync(sb.worktree), "master-primary → worktree removed", out);
	check(!localBranchExists(sb), "master-primary → local branch deleted", out);
	check(!/not in origin\/main/.test(out), "master-primary → no bogus origin/main complaint", out);
}

// --- newline in the main clone path (why --porcelain needs -z) ---
console.log("\nmain clone path containing a newline:");
{
	const sb = makeSandbox("42-feature", { cloneDirName: "clone\nwith-newline" });
	const { code, out } = runCleanup(sb);
	check(code === 0, "path with a newline → exits 0", `got ${code}, output:\n${out}`);
	check(!fs.existsSync(sb.worktree), "path with a newline → worktree removed", out);
	check(!localBranchExists(sb), "path with a newline → local branch deleted", out);
}

// --- main clone path containing a space ---
console.log("\nmain clone path with a space:");
{
	const sb = makeSandbox("42-feature", { cloneDirName: "my clone dir" });
	const { code, out } = runCleanup(sb);
	check(code === 0, "path with a space → exits 0", `got ${code}, output:\n${out}`);
	check(!fs.existsSync(sb.worktree), "path with a space → worktree removed", out);
	check(!localBranchExists(sb), "path with a space → local branch deleted", out);
}

// --- no merged PR and the branch IS on origin: refuse ---
console.log("\nno merged PR, branch still on origin:");
{
	const sb = makeSandbox("42-feature", { prMerged: false });
	const { code, out } = runCleanup(sb);
	check(code !== 0, "no merged PR → non-zero", `got ${code}, output:\n${out}`);
	check(fs.existsSync(sb.worktree), "no merged PR → worktree survives", out);
	check(localBranchExists(sb), "no merged PR → local branch survives", out);
}

// ---

console.log(
	`\n${failures === 0 ? "✅" : "❌"} pr-cleanup safety: ${checks - failures} of ${checks} checks passed.`,
);
process.exit(failures > 0 ? 1 : 0);
