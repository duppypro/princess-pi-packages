// --- pr-open: warn when a branch is stacked on another unmerged branch (#218) ---
//
// We squash-merge. A squash replaces a branch's commits with one NEW commit, so a
// branch based on the merged branch still carries the originals and git reads them
// as unmerged changes conflicting with content already in main. Every stacked PR
// goes red the moment its parent lands — which is exactly what happened when #212
// merged and #213/#214/#215/#216 all broke at once.
//
// The check under test: another origin branch that is NOT an ancestor of
// origin/main (unmerged) whose tip IS an ancestor of HEAD (we are built on it).
//
// It is a WARNING, not a gate. Stacking is sometimes correct — it was correct
// this session, because main was red. So every case here also asserts pr-open
// still exits 0 and still reaches `gh pr create`; a mitigation that blocks
// legitimate work would be worse than the surprise it prevents.
//
// Run with: bun run test pr-open-stacked-base

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PR_OPEN = path.join(REPO_ROOT, "bin", "pr-open");

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

function commit(dir: string, file: string, body: string, msg: string): void {
	fs.writeFileSync(path.join(dir, file), body);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", msg]);
}

interface Sandbox {
	clone: string;
	binDir: string;
	argvLog: string;
}

/**
 * A remote plus a clone on `main`. Callers then build whatever branch topology
 * the case needs and push it.
 */
function makeSandbox(): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-open-"));
	const remote = path.join(root, "remote.git");
	fs.mkdirSync(remote);
	git(remote, ["init", "-q", "--bare", "-b", "main"]);

	const clone = path.join(root, "clone");
	git(root, ["clone", "-q", remote, clone]);
	commit(clone, "README.md", "base\n", "base");
	git(clone, ["push", "-q", "origin", "main"]);

	const binDir = path.join(root, "stubbin");
	fs.mkdirSync(binDir);
	const argvLog = path.join(root, "argv.log");
	fs.writeFileSync(argvLog, "");
	const gh = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}
echo "https://github.com/duppypro/princess-pi-packages/pull/999"
`;
	fs.writeFileSync(path.join(binDir, "gh"), gh);
	fs.chmodSync(path.join(binDir, "gh"), 0o755);

	return { clone, binDir, argvLog };
}

/**
 * spawnSync, NOT execFileSync — the warning under test goes to stderr, and
 * execFileSync returns stdout ONLY on success. Capturing just stdout made every
 * success-path assertion about output silently unfalsifiable: the three RED
 * checks stayed red after the feature worked, because the test could not see it.
 */
function runPrOpen(sb: Sandbox): { code: number; out: string; createdPr: boolean } {
	const r = spawnSync("bash", [PR_OPEN], {
		cwd: sb.clone,
		encoding: "utf8",
		env: { ...process.env, ...GIT_ENV, PATH: `${sb.binDir}${path.delimiter}${process.env.PATH}` },
	});
	const out = `${r.stdout || ""}${r.stderr || ""}`;
	const createdPr = fs.readFileSync(sb.argvLog, "utf8").includes("pr create");
	return { code: r.status ?? -1, out, createdPr };
}

// ---
// Cases
// ---

console.log("pr-open: stacked-base warning (#218)");

// 1. The clean case — branched straight off main. Must stay silent.
console.log("\nbranch straight off main:");
{
	const sb = makeSandbox();
	git(sb.clone, ["checkout", "-q", "-b", "42-normal"]);
	commit(sb.clone, "a.txt", "a\n", "work");
	git(sb.clone, ["push", "-q", "-u", "origin", "42-normal"]);
	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 0, "exits 0", `got ${code}, output:\n${out}`);
	check(createdPr, "still creates the PR", out);
	check(!/stacked/i.test(out), "no stacked-base warning", out);
}

// 2. The case that bit us: built on top of an unmerged sibling.
console.log("\nbranch stacked on an unmerged sibling:");
{
	const sb = makeSandbox();
	git(sb.clone, ["checkout", "-q", "-b", "42-parent"]);
	commit(sb.clone, "a.txt", "a\n", "parent work");
	git(sb.clone, ["push", "-q", "-u", "origin", "42-parent"]);

	git(sb.clone, ["checkout", "-q", "-b", "43-child"]);
	commit(sb.clone, "b.txt", "b\n", "child work");
	git(sb.clone, ["push", "-q", "-u", "origin", "43-child"]);

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 0, "still exits 0 — a warning, not a gate", `got ${code}, output:\n${out}`);
	check(createdPr, "still creates the PR", out);
	check(/stacked/i.test(out), "warns that the branch is stacked", out);
	check(out.includes("42-parent"), "names the branch it is stacked on", out);
	check(/squash/i.test(out), "explains the squash-merge consequence", out);
}

// 3. Stacked on a branch that has ALREADY merged — nothing to warn about.
console.log("\nsibling already merged into main:");
{
	const sb = makeSandbox();
	git(sb.clone, ["checkout", "-q", "-b", "42-parent"]);
	commit(sb.clone, "a.txt", "a\n", "parent work");
	git(sb.clone, ["push", "-q", "-u", "origin", "42-parent"]);

	git(sb.clone, ["checkout", "-q", "-b", "43-child"]);
	commit(sb.clone, "b.txt", "b\n", "child work");
	git(sb.clone, ["push", "-q", "-u", "origin", "43-child"]);

	// fast-forward main to include the parent, as a real merge would
	git(sb.clone, ["checkout", "-q", "main"]);
	git(sb.clone, ["merge", "-q", "--ff-only", "42-parent"]);
	git(sb.clone, ["push", "-q", "origin", "main"]);
	git(sb.clone, ["checkout", "-q", "43-child"]);

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 0, "exits 0", `got ${code}, output:\n${out}`);
	check(createdPr, "still creates the PR", out);
	check(!/stacked/i.test(out), "no warning — the sibling is already in main", out);
}

// 4. An unrelated open sibling must not trip the check. Both branch off main
//    and neither contains the other, which is the ordinary two-PRs-in-flight
//    state — warning there would train everyone to ignore the warning.
console.log("\nunrelated sibling in flight:");
{
	const sb = makeSandbox();
	git(sb.clone, ["checkout", "-q", "-b", "42-sibling"]);
	commit(sb.clone, "a.txt", "a\n", "sibling work");
	git(sb.clone, ["push", "-q", "-u", "origin", "42-sibling"]);

	git(sb.clone, ["checkout", "-q", "main"]);
	git(sb.clone, ["checkout", "-q", "-b", "43-mine"]);
	commit(sb.clone, "b.txt", "b\n", "my work");
	git(sb.clone, ["push", "-q", "-u", "origin", "43-mine"]);

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 0, "exits 0", `got ${code}, output:\n${out}`);
	check(createdPr, "still creates the PR", out);
	check(!/stacked/i.test(out), "no warning for an unrelated branch off main", out);
}

// 5. The bug this test was extended for (#265/#248): the recipe must survive
//    `pr-cleanup` deleting the parent branch — the exact thing that has
//    already happened by the time anyone actually runs the recipe.
console.log("\nparent branch already deleted (pr-cleanup ran) when the printed recipe is used:");
{
	const sb = makeSandbox();
	git(sb.clone, ["checkout", "-q", "-b", "42-parent"]);
	commit(sb.clone, "a.txt", "a\n", "parent work");
	git(sb.clone, ["push", "-q", "-u", "origin", "42-parent"]);

	git(sb.clone, ["checkout", "-q", "-b", "43-child"]);
	commit(sb.clone, "b.txt", "b\n", "child work");
	git(sb.clone, ["push", "-q", "-u", "origin", "43-child"]);

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 0, "exits 0", `got ${code}, output:\n${out}`);
	check(createdPr, "still creates the PR", out);

	const match = out.match(/git rebase --onto origin\/main (\S+) 43-child/);
	check(!!match, "prints a rebase recipe", out);
	const recordedRef = match ? match[1] : "";
	check(
		recordedRef !== "" && !recordedRef.startsWith("origin/"),
		"the recipe's parent anchor is a sha, not the branch ref pr-cleanup deletes",
		out,
	);
	check(out.includes("42-parent"), "keeps the parent's branch name visible alongside the sha", out);

	// Simulate pr-cleanup: delete the parent branch, remote and local.
	git(sb.clone, ["push", "-q", "origin", "--delete", "42-parent"]);
	git(sb.clone, ["fetch", "-q", "--prune", "origin"]);
	const remoteBranches = git(sb.clone, ["branch", "-r"]);
	check(!remoteBranches.includes("42-parent"), "parent ref is really gone (sandbox mirrors pr-cleanup)", remoteBranches);

	// The regression under test: does the recorded anchor still resolve now
	// that the parent branch is gone?
	let stillResolves = false;
	if (recordedRef) {
		try {
			git(sb.clone, ["rev-parse", "--verify", `${recordedRef}^{commit}`]);
			stillResolves = true;
		} catch {
			stillResolves = false;
		}
	}
	check(stillResolves, "the recorded anchor still resolves to a commit after the parent branch is deleted");

	// Prove it end-to-end: the exact printed command still runs (no "unknown
	// revision" / "bad object" — the failure mode #265 exists to fix).
	git(sb.clone, ["checkout", "-q", "43-child"]);
	const rebaseResult = spawnSync("git", ["rebase", "--onto", "origin/main", recordedRef, "43-child"], {
		cwd: sb.clone,
		encoding: "utf8",
		env: { ...process.env, ...GIT_ENV },
	});
	const rebaseOut = `${rebaseResult.stdout || ""}${rebaseResult.stderr || ""}`;
	check(
		!/unknown revision|bad revision|fatal: bad object/i.test(rebaseOut),
		"the printed rebase command resolves its anchor and runs, rather than failing on a missing ref",
		rebaseOut,
	);
	spawnSync("git", ["rebase", "--abort"], { cwd: sb.clone, env: { ...process.env, ...GIT_ENV } });
}

// ---
// 6. The anchor is the FORK POINT, and a parent that has advanced past us
//    produces no recipe at all (macroscopeapp on PR #323).
//
//    The review worried that freezing the parent's TIP would replay the
//    parent's newer commits onto main as if they were ours. That cannot happen
//    through this path, and this case pins the reason: the detection only warns
//    when the parent tip is an ancestor of HEAD, which makes tip and fork point
//    the same sha by construction. Once the parent advances past what we
//    contain, it stops being an ancestor and no warning — hence no recipe — is
//    produced. pr-open now asks merge-base for the boundary regardless, so the
//    guarantee comes from the definition rather than from that coupling.
// ---
console.log("\nanchor is the fork point; a parent advanced past us produces no recipe:");
{
	const sb = makeSandbox();
	git(sb.clone, ["checkout", "-q", "-b", "42-parent"]);
	commit(sb.clone, "a.txt", "a\n", "parent work");
	git(sb.clone, ["push", "-q", "-u", "origin", "42-parent"]);
	const forkPoint = git(sb.clone, ["rev-parse", "HEAD"]).trim();

	git(sb.clone, ["checkout", "-q", "-b", "43-child"]);
	commit(sb.clone, "b.txt", "b\n", "child work");
	git(sb.clone, ["push", "-q", "-u", "origin", "43-child"]);

	const first = runPrOpen(sb);
	const anchor = (first.out.match(/git rebase --onto origin\/main (\S+) 43-child/) || [])[1] || "";
	check(
		anchor === forkPoint,
		"the printed anchor is the fork point (merge-base), not merely some sha",
		`anchor=${anchor} forkPoint=${forkPoint}`,
	);

	// Parent advances past what the child contains.
	git(sb.clone, ["checkout", "-q", "42-parent"]);
	commit(sb.clone, "a2.txt", "a2\n", "parent moves on");
	git(sb.clone, ["push", "-q", "origin", "42-parent"]);
	git(sb.clone, ["checkout", "-q", "43-child"]);
	git(sb.clone, ["fetch", "-q", "origin"]);

	const second = runPrOpen(sb);
	check(
		!/stacked/i.test(second.out),
		"no stacked warning once the parent has advanced past us — so no stale-boundary recipe can be emitted",
		second.out,
	);
}

// ---

console.log(
	`\n${failures === 0 ? "✅" : "❌"} pr-open stacked base: ${checks - failures} of ${checks} checks passed.`,
);
process.exit(failures > 0 ? 1 : 0);
