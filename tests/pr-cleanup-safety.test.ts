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
}

function makeSandbox(branch: string, opts: SandboxOpts = {}): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-cleanup-"));
	const remote = path.join(root, "remote.git");
	fs.mkdirSync(remote);
	git(remote, ["init", "-q", "--bare", "-b", "main"]);

	const mainClone = path.join(root, opts.cloneDirName ?? "clone");
	git(root, ["clone", "-q", remote, mainClone]);
	fs.writeFileSync(path.join(mainClone, "README.md"), "base\n");
	git(mainClone, ["add", "-A"]);
	git(mainClone, ["commit", "-q", "-m", "base"]);
	git(mainClone, ["push", "-q", "origin", "main"]);

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
	git(mainClone, ["push", "-q", "origin", "main"]);
	const mergeSha = git(mainClone, ["rev-parse", "HEAD"]);

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
  "pr list")   out=$(cat ${JSON.stringify(path.join(root, "prlist.json"))}) ;;
  *) exit 0 ;;
esac
if [ -n "$jqexpr" ]; then printf '%s' "$out" | jq -r "$jqexpr"; else printf '%s\\n' "$out"; fi
`;
	fs.writeFileSync(path.join(binDir, "gh"), gh);
	fs.chmodSync(path.join(binDir, "gh"), 0o755);

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
