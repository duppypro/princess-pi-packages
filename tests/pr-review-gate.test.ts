// pr-review + pr-open's review gate (#377) — the intervention arm of duppypro/btw#59.
//
// The property under test is BEHAVIOUR AT THE GATE, not review quality: given a
// reviewer that reports findings / reports nothing / is broken / is absent, does
// pr-open create the PR or not? Review quality is what btw#59's experiment
// measures over 35 real PRs; it is not something a unit test can assert.
//
// Real sandbox with stub binaries on PATH, same shape as the fakeGh helper in
// tests/git-checkpoint-guard.test.ts. `claude` is stubbed because the real one
// costs a subscription call and minutes per run; `gh` is stubbed because the
// assertion is "was `gh pr create` reached", which a stub records exactly.
//
// Run with: bun tests/pr-review-gate.test.ts

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PR_REVIEW = path.join(REPO_ROOT, "bin", "pr-review");
const PR_OPEN = path.join(REPO_ROOT, "bin", "pr-open");

let failures = 0;
let checks = 0;
function check(cond: boolean, label: string, detail = ""): void {
	checks++;
	if (cond) console.log(`  ✅ ${label}`);
	else {
		console.error(`  ❌ ${label}${detail ? `\n     ${detail.split("\n").join("\n     ")}` : ""}`);
		failures++;
	}
}

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
	GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8",
		env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Sandbox { root: string; remote: string; clone: string; binDir: string }

function makeSandbox(): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-gate-"));
	const remote = path.join(root, "remote.git");
	fs.mkdirSync(remote);
	git(remote, ["init", "-q", "--bare", "-b", "main"]);
	const clone = path.join(root, "clone");
	git(root, ["clone", "-q", remote, clone]);
	fs.writeFileSync(path.join(clone, "README.md"), "base\n");
	git(clone, ["add", "-A"]);
	git(clone, ["commit", "-q", "-m", "base"]);
	git(clone, ["push", "-q", "origin", "main"]);
	// a feature branch with one real change to review
	git(clone, ["checkout", "-q", "-b", "42-feature"]);
	fs.writeFileSync(path.join(clone, "feature.sh"), "#!/bin/sh\necho hi\n");
	git(clone, ["add", "-A"]);
	git(clone, ["commit", "-q", "-m", "feat: widget"]);
	git(clone, ["push", "-q", "--set-upstream", "origin", "42-feature"]);
	return { root, remote, clone, binDir: path.join(root, "bin") };
}

// `claude` stub. "findings" returns one High; "clean" returns none; "broken"
// exits nonzero; "iserror" returns a well-formed envelope carrying is_error,
// which must be treated as a FAILED lens rather than a clean one — "found
// nothing" and "could not look" are different facts.
type ClaudeMode = "findings" | "clean" | "broken" | "iserror" | "absent";
function stubs(sb: Sandbox, mode: ClaudeMode, ghRecord?: string): Record<string, string> {
	fs.rmSync(sb.binDir, { recursive: true, force: true });
	fs.mkdirSync(sb.binDir, { recursive: true });
	if (mode !== "absent") {
		const payload =
			mode === "findings"
				? `{"findings":[{"severity":"High","file":"feature.sh","line":2,"title":"stub finding","detail":"stubbed"}]}`
				: `{"findings":[]}`;
		const body =
			mode === "broken"
				? 'echo "claude: boom" >&2; exit 1'
				: mode === "iserror"
					? `printf '%s' '{"is_error":true,"result":""}'; exit 0`
					: `printf '%s' '{"is_error":false,"result":${JSON.stringify(payload)}}'; exit 0`;
		fs.writeFileSync(path.join(sb.binDir, "claude"), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
	}
	// pr-open calls pr-review by bare name; expose the worktree copy under test.
	fs.writeFileSync(path.join(sb.binDir, "pr-review"),
		`#!/usr/bin/env bash\nexec "${PR_REVIEW}" "$@"\n`, { mode: 0o755 });
	if (ghRecord) {
		fs.writeFileSync(path.join(sb.binDir, "gh"),
			`#!/usr/bin/env bash\nif [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo created >> "${ghRecord}"; fi\nexit 0\n`,
			{ mode: 0o755 });
	}
	// PATH is REPLACED, not prepended: the real claude and gh on this developer's
	// PATH would otherwise answer and the test would measure the host.
	// PR_REVIEW_NO_CLUSTER: the clustering pass (#377 round 2) is a fourth real
	// `claude` call. The stub cannot emit a valid grouping for arbitrary inputs, and
	// these tests are about gate BEHAVIOUR, not clustering quality — which is
	// exercised separately below via its documented fail-open contract.
	return { PATH: `${sb.binDir}:/usr/bin:/bin`, PR_REVIEW_LOG_DIR: path.join(sb.root, "logs"),
		PR_REVIEW_NO_CLUSTER: "1" };
}

function run(script: string, cwd: string, env: Record<string, string>, args: string[] = []) {
	// stderr is merged into `out` on BOTH paths. Capturing it only on failure hid
	// the fail-open warnings, which are written to stderr precisely because they
	// are not errors — so the assertions about them silently measured nothing.
	try {
		const out = execFileSync("bash", ["-c", `"$@" 2>&1`, "_", script, ...args], {
			cwd, encoding: "utf8",
			env: { ...process.env, ...GIT_ENV, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}

console.log("pr-review + pr-open review gate (#377)");

console.log("\npr-review exit codes:");
{
	const sb = makeSandbox();
	{
		const env = stubs(sb, "findings");
		const { code, out } = run(PR_REVIEW, sb.clone, env);
		check(code === 7, "findings → exit 7", `got ${code}: ${out}`);
		check(/stub finding/.test(out), "findings → prints the finding", out);
	}
	{
		const env = stubs(sb, "clean");
		const { code, out } = run(PR_REVIEW, sb.clone, env);
		check(code === 0, "no findings → exit 0", `got ${code}: ${out}`);
	}
	{
		const env = stubs(sb, "absent");
		const { code, out } = run(PR_REVIEW, sb.clone, env);
		check(code === 0, "claude absent → exit 0 (fails open)", `got ${code}: ${out}`);
		check(/not on PATH/.test(out), "claude absent → says why", out);
	}
	{
		// A lens that could not run must never be counted as a clean lens.
		const env = stubs(sb, "broken");
		const { code, out } = run(PR_REVIEW, sb.clone, env);
		check(code === 0, "claude broken → exit 0 (fails open)", `got ${code}: ${out}`);
		check(/lenses failed/.test(out), "claude broken → reports incomplete coverage, not 'clean'", out);
	}
	{
		const env = stubs(sb, "iserror");
		const { code, out } = run(PR_REVIEW, sb.clone, env);
		check(/lenses failed/.test(out), "is_error envelope → counted as failed, not clean", out);
		check(code === 0, "is_error envelope → still fails open", `got ${code}: ${out}`);
	}
	{
		// On the primary branch there is no feature diff to review.
		const env = stubs(sb, "clean");
		git(sb.clone, ["checkout", "-q", "main"]);
		const { code } = run(PR_REVIEW, sb.clone, env);
		check(code === 3, "on main → exit 3 (precondition)", `got ${code}`);
		git(sb.clone, ["checkout", "-q", "42-feature"]);
	}
}

console.log("\nthe log is written every run:");
{
	const sb = makeSandbox();
	const env = stubs(sb, "findings");
	run(PR_REVIEW, sb.clone, env);
	const dir = env.PR_REVIEW_LOG_DIR;
	const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
	check(files.length === 1, "one log per run", JSON.stringify(files));
	if (files.length) {
		const d = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
		// Three lenses, each returning the stub's single finding: three entries, not
		// one. Deduplication is deliberately NOT done — two lenses flagging the same
		// line from different angles is signal about the finding, not noise.
		check(Array.isArray(d.findings) && d.findings.length === 3,
			"log carries one finding per lens (no dedup)", JSON.stringify(d.findings.length));
		check(d.findings[0].lens === "correctness" || d.findings[0].lens === "reasoning" || d.findings[0].lens === "contract",
			"each finding is tagged with its lens", JSON.stringify(d.findings[0]));
		check(Array.isArray(d.lenses) && d.lenses.length === 3, "log records all three lenses", JSON.stringify(d.lenses));
		check(typeof d.base === "string" && d.base.length > 0, "log records the base it diffed against", JSON.stringify(d.base));
	}
}

console.log("\npr-open gate behaviour:");
{
	const sb = makeSandbox();
	const rec = path.join(sb.root, "gh-calls");
	{
		const env = stubs(sb, "findings", rec);
		const { code, out } = run(PR_OPEN, sb.clone, env);
		check(code === 7, "findings → pr-open exits 7", `got ${code}: ${out}`);
		check(!fs.existsSync(rec), "findings → NO PR created", fs.existsSync(rec) ? fs.readFileSync(rec, "utf8") : "");
		check(/--reviewed/.test(out), "findings → names the override", out);
	}
	{
		const env = stubs(sb, "findings", rec);
		const { code } = run(PR_OPEN, sb.clone, env, ["--reviewed"]);
		check(code === 0, "--reviewed → exit 0 despite findings", `got ${code}`);
		check(fs.existsSync(rec), "--reviewed → PR created", "gh pr create was not reached");
	}
	fs.rmSync(rec, { force: true });
	{
		const env = stubs(sb, "clean", rec);
		const { code } = run(PR_OPEN, sb.clone, env);
		check(code === 0, "clean review → exit 0", `got ${code}`);
		check(fs.existsSync(rec), "clean review → PR created", "gh pr create was not reached");
	}
	fs.rmSync(rec, { force: true });
	{
		// The reviewer being absent must never block the release path.
		const env = stubs(sb, "absent", rec);
		const { code } = run(PR_OPEN, sb.clone, env);
		check(code === 0, "claude absent → exit 0", `got ${code}`);
		check(fs.existsSync(rec), "claude absent → PR still created (fails open)", "gh pr create was not reached");
	}
}

// --- the findings pr-review's own first run raised against itself (#377) ---
// Every one of these was a real defect in the first cut, found by running the
// gate on its own diff before the PR existed. They are tests now so the fixes
// cannot silently regress.
console.log("\nself-review regressions:");
{
	// E2BIG. The prompt used to be passed as `-p "$prompt"`, and Linux caps ONE
	// argument at MAX_ARG_STRLEN (131072 bytes) regardless of ARG_MAX. Every lens
	// failed on a large branch, the script exited 0, and pr-open opened the PR —
	// so the biggest diffs were exactly the ones never reviewed. Now on stdin.
	const sb = makeSandbox();
	const big = "x".repeat(200_000);
	fs.writeFileSync(path.join(sb.clone, "big.txt"), big + "\n");
	git(sb.clone, ["add", "-A"]);
	git(sb.clone, ["commit", "-q", "-m", "big"]);
	const env = stubs(sb, "clean");
	const { code, out } = run(PR_REVIEW, sb.clone, env);
	const diffBytes = git(sb.clone, ["diff", "--unified=8", "main...HEAD"]).length;
	check(diffBytes > 131072, `sandbox diff really exceeds MAX_ARG_STRLEN (${diffBytes} bytes)`, "");
	check(code === 0, "200KB diff → exit 0, lenses actually ran", `got ${code}: ${out}`);
	check(!/lenses failed/.test(out), "200KB diff → no lens failed (prompt went via stdin)", out);
}
{
	// Coverage and cleanliness are different claims. The first cut printed
	// "✅ no findings across 3 lenses" on stdout while stderr said 3 of 3 failed —
	// anything reading the last stdout line recorded a review that never happened.
	const sb = makeSandbox();
	const env = stubs(sb, "broken");
	const { out } = run(PR_REVIEW, sb.clone, env);
	check(!/✅/.test(out), "all lenses failed → no ✅ claim", out);
	check(/COVERAGE INCOMPLETE/.test(out), "all lenses failed → says coverage is incomplete", out);
	check(/no findings from the 0 lens/.test(out), "all lenses failed → reports lenses that RAN, not declared", out);
}
{
	// --json must emit exactly ONE parseable document on every exit path. The
	// first cut leaked a second summary object on the reviewed path, and printed
	// a human sentence on the empty-diff path.
	const sb = makeSandbox();
	for (const [mode, label] of [["clean", "reviewed"], ["absent", "reviewer-unavailable"]] as const) {
		const env = stubs(sb, mode);
		const { out } = run(PR_REVIEW, sb.clone, env, ["--json"]);
		let parsed: any = null;
		try { parsed = JSON.parse(out.trim()); } catch { /* left null */ }
		check(parsed !== null, `--json (${label}) → exactly one parseable document`, out.slice(0, 300));
		check(parsed?.status !== undefined, `--json (${label}) → carries a status field`, out.slice(0, 200));
	}
	{
		// empty diff: --base HEAD means nothing changed
		const env = stubs(sb, "clean");
		const { out } = run(PR_REVIEW, sb.clone, env, ["--json", "--base", "HEAD"]);
		let parsed: any = null;
		try { parsed = JSON.parse(out.trim()); } catch { /* left null */ }
		check(parsed?.status === "no-changes", "--json (no-changes) → JSON, not a human sentence", out.slice(0, 200));
	}
}
{
	// The experiment's metric is DISTINCT defects. The raw list keeps one entry
	// per lens on purpose, but the control arm it is compared against is a
	// deduplicated per-reviewer count, so reporting the raw total would inflate
	// this arm by up to 3x and corrupt the measurement (btw#59).
	const sb = makeSandbox();
	const env = stubs(sb, "findings");
	const { out } = run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(d.findings.length === 3, "raw list keeps one entry per lens", String(d.findings.length));
	check(d.dedup === "disabled", "PR_REVIEW_NO_CLUSTER=1 disables clustering", String(d.dedup));
	check(d.distinctFindings === 3, "with clustering off, distinct == raw (no false dedup)", String(d.distinctFindings));
}
{
	// A failed lens must carry its cause. The first cut captured each lens's
	// stderr and then deleted it unread with the EXIT trap, leaving "N of 3
	// failed" with no way to tell E2BIG from expired auth — while failing open.
	const sb = makeSandbox();
	const env = stubs(sb, "broken");
	run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(d.failedLenses.length === 3, "every failed lens is recorded", JSON.stringify(d.failedLenses.length));
	check(typeof d.failedLenses[0]?.why === "string" && d.failedLenses[0].why.length > 0,
		"a failed lens records WHY it failed", JSON.stringify(d.failedLenses[0]));
	check(/boom/.test(d.failedLenses[0]?.stderr || ""), "a failed lens keeps the reviewer's stderr",
		JSON.stringify(d.failedLenses[0]));
}
{
	// A git failure is not an empty diff. `|| true` used to collapse a bogus base,
	// a corrupt object and a shallow clone into "nothing to review" + exit 0,
	// which pr-open read as a clean gate.
	const sb = makeSandbox();
	const env = stubs(sb, "clean");
	const { code, out } = run(PR_REVIEW, sb.clone, env, ["--base", "no-such-ref-at-all"]);
	check(code === 3, "unresolvable base → exit 3, not a clean 0", `got ${code}: ${out}`);
}

// --- clustering fails open to a LABELLED raw count (#377 round 2) ---
// String-key dedup was replaced after measuring it at 0% on a live 19-finding
// run: three lenses run three different prompts, so the same defect arrives with
// different words at different lines (true duplicate pairs spanned 0.09-0.56
// title similarity and 0-260 lines apart). Clustering is a fourth model call, so
// it can fail — and an un-deduplicated count that SAYS SO is usable, while one
// that pretends is what corrupts the experiment.
console.log("\nclustering fail-open:");
{
	const sb = makeSandbox();
	const env = stubs(sb, "findings");
	delete (env as any).PR_REVIEW_NO_CLUSTER;   // let it try; the stub cannot produce a partition
	const { code, out } = run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(code === 7, "unusable clustering → still exit 7 (findings are not lost)", `got ${code}: ${out}`);
	check(d.dedup === "failed", "unusable clustering → dedup recorded as 'failed'", String(d.dedup));
	check(d.distinctFindings === d.findings.length, "unusable clustering → count falls back to raw", 
		`${d.distinctFindings} vs ${d.findings.length}`);
	check(/NOT deduplicated/.test(out), "unusable clustering → output SAYS the count is not deduplicated", out);
	check(typeof d.dedupNote === "string" && d.dedupNote.length > 0, "unusable clustering → records why", String(d.dedupNote));
}
{
	// Partial coverage must be visible on the machine path too, not only the human one.
	const sb = makeSandbox();
	const env = stubs(sb, "broken");
	const { out } = run(PR_REVIEW, sb.clone, env, ["--json"]);
	const d = JSON.parse(out.trim());
	check(d.status === "reviewed-none", "all lenses failed → status 'reviewed-none', not 'reviewed'", String(d.status));
	check(d.lensesRan === 0, "all lenses failed → lensesRan 0", String(d.lensesRan));
}
{
	// A flag-shaped --base value is a usage error, not a silently consumed flag:
	// `--base --json` used to drop --json, fail the diff, and open an unreviewed PR.
	const sb = makeSandbox();
	const env = stubs(sb, "clean");
	const { code, out } = run(PR_REVIEW, sb.clone, env, ["--base", "--json"]);
	check(code === 2, "--base with a flag-shaped value → exit 2", `got ${code}: ${out}`);
}
{
	// emit_status must produce valid JSON for a message containing a backslash.
	const sb = makeSandbox();
	const env = stubs(sb, "clean");
	const { out } = run(PR_REVIEW, sb.clone, env, ["--json", "--base", "a\\qb"]);
	let parsed: any = null;
	try { parsed = JSON.parse(out.trim()); } catch { /* left null */ }
	check(parsed !== null, "backslash in --base → still exactly one parseable document", out.slice(0, 200));
}
{
	// pr-open must be LOUD when pr-review is missing — the one fail-open that used
	// to produce no output at all.
	const sb = makeSandbox();
	const rec = path.join(sb.root, "gh-calls-2");
	const env = stubs(sb, "clean", rec);
	fs.rmSync(path.join(sb.binDir, "pr-review"));   // deployed without its pair
	const { code, out } = run(PR_OPEN, sb.clone, env);
	check(code === 0, "pr-review missing → pr-open still exits 0", `got ${code}: ${out}`);
	check(fs.existsSync(rec), "pr-review missing → PR still created (fails open)", "");
	check(/UNREVIEWED/.test(out), "pr-review missing → says the PR is unreviewed", out);
	check(/install-workflow-tools/.test(out), "pr-review missing → names the fix", out);
}

console.log(`\n${failures === 0 ? "✅" : "❌"} pr-review gate: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
