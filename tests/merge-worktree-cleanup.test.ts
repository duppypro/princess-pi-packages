// --- merge: worktree-aware cleanup, post-merge rebuild, --version (#143, #173, #177) ---
//
// Drives the REAL built bin/merge.mjs against throwaway sandboxes: a bare "remote",
// a main clone, and (where the case needs it) a linked worktree. Same shape as the
// older tests/merge-fallback.sandbox.sh, but as a *.test.ts so `bun run test` runs it
// instead of it being a thing someone remembers to invoke.
//
// Why sandboxes and not mocks: every defect here is about what git actually refuses
// to do. `git checkout main` failing because main is checked out in another worktree
// (#143) cannot be reproduced by a mock without encoding the very assumption the bug
// disproves.
//
// Run with: bun run test merge-worktree-cleanup

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---
// Layout
// ---

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MERGE_BIN = path.join(REPO_ROOT, "bin", "merge.mjs");

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

function git(cwd: string, cmd: string): string {
	return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Run the merge CLI. Never throws — the exit code and combined output are the subject. */
function runMerge(cwd: string, args: string, extraPath = ""): { code: number; out: string } {
	const env = { ...process.env };
	if (extraPath) env.PATH = `${extraPath}${path.delimiter}${env.PATH}`;
	try {
		const out = execSync(`node ${JSON.stringify(MERGE_BIN)} ${args} < /dev/null 2>&1`, {
			cwd, encoding: "utf8", env, timeout: 120_000,
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}

// ---
// Fixtures
// ---

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "merge-sandbox-"));
const created: string[] = [];

/**
 * A bare remote plus a main clone, on `main`, with one commit pushed.
 * `pkg` optionally installs a package.json + build script, so the #177 path has
 * something real to regenerate.
 */
function freshRepo(name: string, pkg: { build?: string; buildScript?: string } = {}): { remote: string; main: string } {
	const base = path.join(TMP_ROOT, name);
	created.push(base);
	const remote = path.join(base, "remote.git");
	const main = path.join(base, "main");
	fs.mkdirSync(base, { recursive: true });
	execSync(`git init -q --bare ${JSON.stringify(remote)}`);
	execSync(`git clone -q ${JSON.stringify(remote)} ${JSON.stringify(main)}`);
	git(main, "config user.email t@t");
	git(main, "config user.name t");
	git(main, "checkout -q -b main");
	fs.mkdirSync(path.join(main, "src"), { recursive: true });
	fs.writeFileSync(path.join(main, "src", "a.txt"), "A0\n");
	fs.writeFileSync(path.join(main, "src", "b.txt"), "B0\n");
	if (pkg.build) {
		fs.writeFileSync(path.join(main, "package.json"), JSON.stringify({ name, scripts: { build: pkg.build } }, null, 2) + "\n");
		if (pkg.buildScript) fs.writeFileSync(path.join(main, "build.js"), pkg.buildScript);
		// The tracked artifact: concatenation of BOTH sources, so a branch touching
		// only a.txt and a branch touching only b.txt each commit a bundle that is
		// correct alone and wrong together. That is #177 in miniature.
		execSync("node build.js", { cwd: main, stdio: "ignore" });
	}
	git(main, "add -A");
	git(main, 'commit -q -m "init"');
	git(main, "push -q -u origin main");
	return { remote, main };
}

/** A feature branch in a LINKED WORKTREE — the layout #143 is about. */
function featureWorktree(mainCwd: string, branch: string): string {
	const wt = path.join(path.dirname(mainCwd), branch);
	git(mainCwd, `worktree add -q ${JSON.stringify(wt)} -b ${branch}`);
	git(wt, "config user.email t@t");
	git(wt, "config user.name t");
	return wt;
}

function step5Commit(cwd: string, what: string): void {
	git(cwd, "add -A");
	execSync(`git commit -q -m "docs: Code and Spec Approved — ${what}"`, { cwd, stdio: "ignore" });
}

const BUILD_JS = `// concatenates src/*.txt into dist/bundle.txt
const fs = require("node:fs"), path = require("node:path");
const src = path.join(__dirname, "src"), dist = path.join(__dirname, "dist");
fs.mkdirSync(dist, { recursive: true });
const names = fs.readdirSync(src).sort();
fs.writeFileSync(path.join(dist, "bundle.txt"), names.map(n => fs.readFileSync(path.join(src, n), "utf8")).join(""));
`;

// ---
// V1-V3 — --version must answer without touching git (#173)
// ---

console.log("\n--- V1-V3: merge --version outside a git repo ---");
{
	const nonRepo = path.join(TMP_ROOT, "not-a-repo");
	fs.mkdirSync(nonRepo, { recursive: true });
	const r = runMerge(nonRepo, "--version");
	const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs", "manifests", "merge-cmd.json"), "utf8"));

	check(r.code === 0, "V1: exits 0 outside any git repo", `exit ${r.code}\n${r.out}`);
	check(!/not a git repository/i.test(r.out), "V1: no 'not a git repository' error", r.out);
	check(!/Running merge validation checks/.test(r.out), "V2: does not run validation checks first", r.out);
	check(r.out.trim() === `${manifest.name} ${manifest.version}`,
		`V3: prints '${manifest.name} ${manifest.version}' from the manifest`, `got: ${JSON.stringify(r.out.trim())}`);
}

// ---
// V4-V5 — cleanup in the worktree layout (#143.1)
// ---

console.log("\n--- V4-V5: merge --cleanup from a linked worktree ---");
{
	const { main } = freshRepo("worktree-cleanup");
	const wt = featureWorktree(main, "feature-x");
	fs.writeFileSync(path.join(wt, "src", "a.txt"), "A1\n");
	step5Commit(wt, "feature x");
	git(wt, "push -q -u origin feature-x");

	const r = runMerge(wt, "--cleanup");

	check(r.code === 0, "V4: exits 0", `exit ${r.code}\n${r.out}`);
	check(!/Merge Aborted/.test(r.out), "V4: no 'Merge Aborted' banner", r.out);
	git(main, "fetch -q origin");
	let merged = true;
	try { git(main, "merge-base --is-ancestor feature-x origin/main"); } catch { merged = false; }
	check(merged, "V4: origin/main advanced to include the feature commit");

	const branches = git(main, "branch --list feature-x");
	check(branches === "", "V4: local feature branch deleted", `got: ${JSON.stringify(branches)}`);
	const remotes = git(main, "ls-remote --heads origin feature-x");
	check(remotes === "", "V4: remote feature branch deleted", `got: ${JSON.stringify(remotes)}`);

	const wtHead = git(wt, "rev-parse --abbrev-ref HEAD");
	check(wtHead === "HEAD", "V5: feature worktree is on a detached HEAD", `got: ${wtHead}`);
	check(git(wt, "rev-parse HEAD") === git(main, "rev-parse main"), "V5: detached at main's commit");
	check(git(main, "rev-parse --abbrev-ref HEAD") === "main", "V5: main clone still has main checked out");
}

// ---
// V6 — single-checkout layout still works (regression guard)
// ---

console.log("\n--- V6: single-checkout cleanup (no main worktree) ---");
{
	const { main } = freshRepo("single-checkout");
	git(main, "checkout -q -b feature-y");
	fs.writeFileSync(path.join(main, "src", "a.txt"), "A2\n");
	step5Commit(main, "feature y");
	git(main, "push -q -u origin feature-y");

	const r = runMerge(main, "--cleanup");

	check(r.code === 0, "V6: exits 0", `exit ${r.code}\n${r.out}`);
	check(git(main, "rev-parse --abbrev-ref HEAD") === "main", "V6: back on main");
	check(git(main, "branch --list feature-y") === "", "V6: local branch deleted");
	check(git(main, "ls-remote --heads origin feature-y") === "", "V6: remote branch deleted");
}

// ---
// V7-V8 — cleanup fails honestly (#143.2, #143.3)
// ---
// Fault injection via a `git` shim earlier on PATH that fails ONLY on `branch -d`.
// This is the one way to reach the failure ordering without contriving repo state
// that git itself would refuse to create.

console.log("\n--- V7-V8: local delete fails → remote survives, merge not blamed ---");
{
	const { main } = freshRepo("cleanup-failure");
	const wt = featureWorktree(main, "feature-z");
	fs.writeFileSync(path.join(wt, "src", "a.txt"), "A3\n");
	step5Commit(wt, "feature z");
	git(wt, "push -q -u origin feature-z");

	const shimDir = path.join(TMP_ROOT, "gitshim");
	fs.mkdirSync(shimDir, { recursive: true });
	const realGit = execSync("command -v git", { encoding: "utf8", shell: "/bin/bash" }).trim();
	fs.writeFileSync(path.join(shimDir, "git"),
		`#!/bin/bash\nif [ "$1" = "branch" ] && [ "$2" = "-d" ]; then\n  echo "error: injected failure deleting branch" >&2\n  exit 1\nfi\nexec ${realGit} "$@"\n`);
	fs.chmodSync(path.join(shimDir, "git"), 0o755);

	const r = runMerge(wt, "--cleanup", shimDir);

	check(r.code === 0, "V8: exits 0 — a cleanup failure is not a merge failure", `exit ${r.code}\n${r.out}`);
	check(!/Merge Aborted/.test(r.out), "V8: no 'Merge Aborted' banner", r.out);
	check(/succeeded/i.test(r.out), "V8: output states the merge succeeded", r.out);

	const remotes = git(main, "ls-remote --heads origin feature-z");
	check(remotes !== "", "V7: remote branch still present — nothing half-deleted", "remote was deleted despite local failing");
}

// ---
// V9-V11 — post-merge rebuild (#177)
// ---

console.log("\n--- V9-V11: merging two branches regenerates the combined artifact ---");
{
	const { main } = freshRepo("rebuild", { build: "node build.js", buildScript: BUILD_JS });
	const bundle = path.join(main, "dist", "bundle.txt");

	// Two branches, each touching a DIFFERENT source, each committing a bundle that
	// is correct for its own tree and wrong for the merge of the two.
	for (const [branch, file, val] of [["feat-a", "a.txt", "A9"], ["feat-b", "b.txt", "B9"]] as const) {
		git(main, `checkout -q -b ${branch} main`);
		fs.writeFileSync(path.join(main, "src", file), `${val}\n`);
		execSync("node build.js", { cwd: main, stdio: "ignore" });
		step5Commit(main, `${branch} work`);
		git(main, `push -q -u origin ${branch}`);
		git(main, "checkout -q main");
	}

	git(main, "checkout -q feat-a");
	const r1 = runMerge(main, "--cleanup");
	check(r1.code === 0, "V9: first merge exits 0", `exit ${r1.code}\n${r1.out}`);

	git(main, "checkout -q feat-b");
	const r2 = runMerge(main, "--cleanup");
	check(r2.code === 0, "V9: second merge exits 0", `exit ${r2.code}\n${r2.out}`);

	// The combined bundle must be on main, and a fresh build must produce no diff.
	execSync("node build.js", { cwd: main, stdio: "ignore" });
	const dirty = git(main, "status --porcelain");
	check(dirty === "", "V9: no stale artifact on main — a fresh build produces no diff", `dirty:\n${dirty}`);
	check(fs.readFileSync(bundle, "utf8") === "A9\nB9\n", "V9: bundle holds BOTH branches' changes",
		`got: ${JSON.stringify(fs.readFileSync(bundle, "utf8"))}`);

	const log = git(main, 'log --oneline -20 --pretty=%s');
	check(/build: regenerate tracked artifacts/.test(log), "V10: rebuild landed as its own commit", log);
	check(/regenerate tracked artifacts/.test(r2.out), "V10: rebuild reported before the push", r2.out);
	check(git(main, "rev-parse main") === git(main, "rev-parse origin/main"),
		"V10: rebuild commit was pushed in the same push as the merge");
}

console.log("\n--- V11: no delta → no build commit ---");
{
	const { main } = freshRepo("rebuild-noop", { build: "node build.js", buildScript: BUILD_JS });
	git(main, "checkout -q -b feat-noop");
	// Touch a file the build does not read, so the artifact cannot change.
	fs.writeFileSync(path.join(main, "README.md"), "unrelated\n");
	step5Commit(main, "no artifact change");
	git(main, "push -q -u origin feat-noop");

	const r = runMerge(main, "--cleanup");
	check(r.code === 0, "V11: exits 0", `exit ${r.code}\n${r.out}`);
	check(/already current/.test(r.out), "V11: reports build output already current", r.out);
	check(!/build: regenerate tracked artifacts/.test(git(main, "log --oneline -10 --pretty=%s")),
		"V11: no rebuild commit created");
}

// ---
// V12-V13 — genericity and opt-out
// ---

console.log("\n--- V12-V13: no build script, and --no-build ---");
{
	const { main } = freshRepo("no-build-script");
	git(main, "checkout -q -b feat-nb");
	fs.writeFileSync(path.join(main, "src", "a.txt"), "A12\n");
	step5Commit(main, "no build script here");
	git(main, "push -q -u origin feat-nb");
	const r = runMerge(main, "--cleanup");
	check(r.code === 0, "V12: repo with no build script merges normally", `exit ${r.code}\n${r.out}`);
	check(/No 'build' script/.test(r.out), "V12: says it skipped the build and why", r.out);
}
{
	const { main } = freshRepo("opt-out", { build: "node build.js", buildScript: BUILD_JS });
	git(main, "checkout -q -b feat-optout");
	fs.writeFileSync(path.join(main, "src", "a.txt"), "A13\n");
	step5Commit(main, "stale artifact on purpose");
	git(main, "push -q -u origin feat-optout");
	const r = runMerge(main, "--cleanup --no-build");
	check(r.code === 0, "V13: --no-build exits 0", `exit ${r.code}\n${r.out}`);
	check(/--no-build/.test(r.out), "V13: reports the rebuild was skipped", r.out);
	check(!/build: regenerate tracked artifacts/.test(git(main, "log --oneline -10 --pretty=%s")),
		"V13: no rebuild commit created");
}

// ---
// V14 — a failing build blocks the push
// ---

console.log("\n--- V14: failing build must not push ---");
{
	const { main } = freshRepo("build-fails", { build: "node build.js", buildScript: BUILD_JS });
	const before = git(main, "rev-parse origin/main");
	git(main, "checkout -q -b feat-broken");
	fs.writeFileSync(path.join(main, "build.js"), 'process.exit(3);\n');
	step5Commit(main, "break the build");
	git(main, "push -q -u origin feat-broken");

	const r = runMerge(main, "--cleanup");

	check(r.code !== 0, "V14: exits non-zero", `exit ${r.code}\n${r.out}`);
	check(/Merge not pushed/.test(r.out), "V14: banner says 'Merge not pushed', not 'Merge Aborted'", r.out);
	check(!/Merge Aborted/.test(r.out), "V14: does not claim the merge was aborted", r.out);
	check(!/rolled back/.test(r.out), "V14: does not claim a rollback that did not happen", r.out);
	git(main, "fetch -q origin");
	check(git(main, "rev-parse origin/main") === before, "V14: origin/main is unchanged");
}

// ---
// Cleanup + verdict
// ---

try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }

if (failures > 0) {
	console.error(`\n❌ merge worktree/cleanup/rebuild: ${failures} of ${checks} checks failed.`);
	process.exit(1);
}
console.log(`\n✅ merge worktree/cleanup/rebuild: all ${checks} checks passed.`);
