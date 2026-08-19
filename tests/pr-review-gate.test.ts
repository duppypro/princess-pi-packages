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
	return { PATH: `${sb.binDir}:/usr/bin:/bin`, PR_REVIEW_LOG_DIR: path.join(sb.root, "logs") };
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

console.log(`\n${failures === 0 ? "✅" : "❌"} pr-review gate: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
