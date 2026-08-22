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

import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

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

// Sandboxes are removed by tests/lib/sandbox.ts's registry — on normal exit and
// on SIGINT/SIGTERM, for every suite rather than this one (#394).

function makeSandbox(): Sandbox {
	const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-gate-")));
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
type ClaudeMode = "findings" | "clean" | "broken" | "iserror" | "absent" | "arrayenv"
	| "prosebrace" | "errorobject" | "emptyfinding" | "titleonly" | "clusterprose"
	// tsconfig scopes typecheck to bin/**/*.ts, so nothing here is checked by
	// `bun run typecheck` and bun strips the annotation at runtime — an omitted
	// member costs no error and buys no safety. Kept accurate by hand: the union
	// is documentation of the stub roster, and that is its whole job (#403).
	| "hang" | "sigkill" | "exit124";
function stubs(sb: Sandbox, mode: ClaudeMode, ghRecord?: string, prose?: string, postProse?: string): Record<string, string> {
	fs.rmSync(sb.binDir, { recursive: true, force: true });
	fs.mkdirSync(sb.binDir, { recursive: true });
	if (mode === "clusterprose") {
		// Prose in front of the payload, on BOTH calls: the lenses answer with
		// findings, and the clustering call — the only prompt carrying "FINDINGS:" —
		// answers with a grouping. `prose` is the hazard under test; the default is
		// the brace that `find("{")`/`rfind("}")` mis-spanned (#378). `postProse`
		// is the same hazard AFTER the payload instead of before, for the class of
		// hazard that only bites there — a trailing echo of the prompt's own schema
		// (#378 round 2) — since LAST-wins beat FIRST-wins on the leading cases but
		// lost on this one.
		//
		// Envelopes go through FILES, not shell quoting: the hazards these cases
		// carry are quotes and braces, and a stub that has to escape them is a stub
		// that tests its own escaping.
		const payload = `{"findings":[{"severity":"High","file":"feature.sh","line":2,"title":"stub finding","detail":"stubbed"}]}`;
		// [[0,1],[2]] and not [[0],[1],[2]]: a grouping that MERGES makes distinct
		// (2) differ from raw (3), so the assertion cannot pass on the fail-open
		// path — which returns raw and would satisfy an identity partition.
		const grouping = `{"groups":[[0,1],[2]]}`;
		const pre = prose ?? 'Grouping note: avoid ${VAR} in prose.\n';
		const post = postProse ?? "\nDone, see {ref}.";
		const lensFile = path.join(sb.root, "lens-env.json");
		const clusterFile = path.join(sb.root, "cluster-env.json");
		fs.writeFileSync(lensFile, `{"is_error":false,"result":${JSON.stringify(pre + payload + post)}}`);
		fs.writeFileSync(clusterFile, `{"is_error":false,"result":${JSON.stringify(pre + grouping + post)}}`);
		fs.writeFileSync(path.join(sb.binDir, "claude"),
			`#!/usr/bin/env bash\ninput=$(cat)\ncase "$input" in\n  *FINDINGS:*) cat "${clusterFile}" ;;\n  *) cat "${lensFile}" ;;\nesac\nexit 0\n`,
			{ mode: 0o755 });
	} else if (mode === "prosebrace") {
		// A reviewer that mentions `${VAR}` (or any brace) BEFORE its payload. The
		// old collector took the FIRST balanced object, parsed `{VAR}`, and filed a
		// lens that had actually found a High as "could not look" (macroscopeapp,
		// PR #379).
		const payload = `{"findings":[{"severity":"High","file":"feature.sh","line":2,"title":"stub finding","detail":"after prose"}]}`;
		fs.writeFileSync(path.join(sb.binDir, "claude"),
			`#!/usr/bin/env bash\nprintf '%s' '{"is_error":false,"result":${JSON.stringify("Avoid ${VAR} here.\n" + payload)}}'; exit 0\n`,
			{ mode: 0o755 });
	} else if (mode === "errorobject") {
		// A well-formed JSON object that is NOT a review result. `.get("findings", [])`
		// defaulted the missing key to empty, so this counted as a lens that ran and
		// found nothing — a clean review manufactured out of a failure.
		fs.writeFileSync(path.join(sb.binDir, "claude"),
			`#!/usr/bin/env bash\nprintf '%s' '{"is_error":false,"result":"{\\"error\\":\\"rate limited\\"}"}'; exit 0\n`,
			{ mode: 0o755 });
	} else if (mode === "emptyfinding") {
		// Parseable, and says nothing: counted as a finding, exited 7, and printed
		// `[?/?] ?:?` — a PR blocked by a message no one can act on.
		fs.writeFileSync(path.join(sb.binDir, "claude"),
			`#!/usr/bin/env bash\nprintf '%s' '{"is_error":false,"result":"{\\"findings\\":[{}]}"}'; exit 0\n`,
			{ mode: 0o755 });
	} else if (mode === "titleonly") {
		// A FILE-level finding: real, actionable, and carrying no `line`. Requiring
		// every field would drop this one, trading a visible bad state for an
		// invisible one.
		fs.writeFileSync(path.join(sb.binDir, "claude"),
			`#!/usr/bin/env bash\nprintf '%s' '{"is_error":false,"result":"{\\"findings\\":[{\\"severity\\":\\"High\\",\\"file\\":\\"feature.sh\\",\\"title\\":\\"no shebang guard\\"}]}"}'; exit 0\n`,
			{ mode: 0o755 });
	} else if (mode === "hang") {
		// A reviewer that never answers. `timeout` kills it, which is a DIFFERENT
		// cause from a reviewer that errors — the script reported both with one
		// sentence naming both ("exit N (timeout ${LENS_TIMEOUT}s or reviewer
		// failure)", the ceiling interpolated), so the reader could not tell which
		// knob, if any, would help (#403).
		fs.writeFileSync(path.join(sb.binDir, "claude"),
			`#!/usr/bin/env bash\nsleep 30\n`, { mode: 0o755 });
	} else if (mode === "exit124") {
		// The reviewer's OWN 124 — the code `timeout` uses, from a process the
		// wrapper never signalled. Indistinguishable from expiry by exit code.
		fs.writeFileSync(path.join(sb.binDir, "claude"),
			`#!/usr/bin/env bash\nexit 124\n`, { mode: 0o755 });
	} else if (mode === "sigkill") {
		// Killed by a signal from outside the ceiling — the OOM killer's shape.
		// Exit 137, elapsed ~0, ceiling nowhere near reached.
		fs.writeFileSync(path.join(sb.binDir, "claude"),
			`#!/usr/bin/env bash\nkill -9 $$\n`, { mode: 0o755 });
	} else if (mode === "arrayenv") {
		// An envelope that parses as an ARRAY, not an object. Used to raise
		// AttributeError outside the try, kill the collector, and lose all lenses.
		fs.writeFileSync(path.join(sb.binDir, "claude"),
			`#!/usr/bin/env bash\nprintf '%s' '[{"type":"message"}]'; exit 0\n`, { mode: 0o755 });
	} else if (mode !== "absent") {
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
		check(code === 8, "claude broken, zero lenses ran → exit 8 (#401)", `got ${code}: ${out}`);
		check(/lenses failed/.test(out), "claude broken → reports incomplete coverage, not 'clean'", out);
	}
	{
		const env = stubs(sb, "iserror");
		const { code, out } = run(PR_REVIEW, sb.clone, env);
		check(/lenses failed/.test(out), "is_error envelope → counted as failed, not clean", out);
		check(code === 8, "is_error envelope, zero lenses ran → exit 8 (#401)", `got ${code}: ${out}`);
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

// --- #406: the log directory groups by REPOSITORY, not worktree basename ----
// `basename "$(git rev-parse --show-toplevel)"` resolves to the WORKTREE path
// inside a worktree, so a branch checked out at `<repo>/.claude/worktrees/<br
// anch>/` — pr-open's own documented layout — logged to a directory named
// after the branch instead of the repo, scattering one directory per branch
// that `pr-cleanup` then orphans. `--path-format=absolute --git-common-dir`
// resolves to the MAIN clone's `.git` in both a worktree and the main clone
// itself, so its parent's basename is the repo, stable across both.
console.log("\n#406: the log directory groups by repo, not worktree basename:");
{
	const sb = makeSandbox();
	// A worktree whose directory basename is NOT the repo name — the exact shape
	// of pr-open's own documented layout (`<repo>/.claude/worktrees/<branch>/`).
	const wtDir = path.join(sb.root, "406-feature-worktree");
	git(sb.clone, ["worktree", "add", "-q", "-b", "406-feature", wtDir]);
	fs.writeFileSync(path.join(wtDir, "wtfile.txt"), "hi\n");
	git(wtDir, ["add", "-A"]);
	git(wtDir, ["commit", "-q", "-m", "feat: worktree change"]);

	const xdg = path.join(sb.root, "xdg-state");
	// PR_REVIEW_LOG_DIR is dropped so the script computes the DEFAULT path from
	// XDG_STATE_HOME/REPO_NAME — the thing under test — rather than the
	// sandbox override every other case here uses. `-u` on the invocation
	// guards against a PR_REVIEW_LOG_DIR the host itself happens to export,
	// same pattern as the "no HOME" case above.
	const { PR_REVIEW_LOG_DIR: _dropped, ...env } = stubs(sb, "clean");
	env.XDG_STATE_HOME = xdg;
	const runDefault = (cwd: string) =>
		run("/usr/bin/env", cwd, env, ["-u", "PR_REVIEW_LOG_DIR", PR_REVIEW]);

	const { code: c1, out: o1 } = runDefault(wtDir);
	const { code: c2, out: o2 } = runDefault(sb.clone);
	check(c1 === 0, "run from the worktree still reviews and exits 0", `got ${c1}: ${o1}`);
	check(c2 === 0, "run from the main clone still reviews and exits 0", `got ${c2}: ${o2}`);

	const repoName = path.basename(sb.clone); // "clone" — the main clone's own dirname
	const repoDir = path.join(xdg, "pr-review", repoName);
	const worktreeDir = path.join(xdg, "pr-review", path.basename(wtDir));

	check(fs.existsSync(repoDir), "the repo-named log directory exists", repoDir);
	check(!fs.existsSync(worktreeDir),
		"no directory named after the worktree basename is created", worktreeDir);
	const logs = fs.existsSync(repoDir) ? fs.readdirSync(repoDir).filter((f) => f.endsWith(".json")) : [];
	check(logs.length === 2,
		"both runs — worktree AND main clone — logged into the SAME repo directory",
		JSON.stringify(logs));

	git(sb.clone, ["worktree", "remove", "-f", wtDir]);
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
	fs.rmSync(rec, { force: true });
	{
		// #401 (PR #393): the reviewer WAS on PATH and every lens still failed —
		// "could not review" must not read as "clean". pr-review exits 8, distinct
		// from both 0 (clean/absent) and 7 (findings), and pr-open refuses rather
		// than opening a PR that believes itself reviewed.
		const env = stubs(sb, "broken", rec);
		const { code, out } = run(PR_OPEN, sb.clone, env);
		check(code === 8, "zero lenses ran → pr-open refuses, exit 8 (#401)", `got ${code}: ${out}`);
		check(!fs.existsSync(rec), "zero lenses ran → NO PR created",
			fs.existsSync(rec) ? fs.readFileSync(rec, "utf8") : "");
		check(/--reviewed/.test(out), "zero lenses ran → names the override", out);
	}
	{
		// The same escape hatch that already covers findings (exit 7) also covers
		// this: --reviewed skips pr-review outright, so it never even runs.
		const env = stubs(sb, "broken", rec);
		const { code } = run(PR_OPEN, sb.clone, env, ["--reviewed"]);
		check(code === 0, "--reviewed → exit 0 despite zero coverage", `got ${code}`);
		check(fs.existsSync(rec), "--reviewed → PR created", "gh pr create was not reached");
	}
	fs.rmSync(rec, { force: true });
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
	// "0", not `delete`: run() builds the child env as {...process.env, ...env},
	// so deleting the key removes only the OVERRIDE — a host that exports
	// PR_REVIEW_NO_CLUSTER=1 leaked through and the assertions below then measured
	// the disabled branch instead of the failed one (#378).
	env.PR_REVIEW_NO_CLUSTER = "0";   // let it try; the stub cannot produce a partition
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
// ...but a USABLE payload wrapped in prose must not be filed unusable, on EITHER
// call. The collector stopped trusting brace POSITION in #379 and the clustering
// pass followed in #378 — but a scanner that counts braces by hand is fooled by
// every other thing a model writes around its answer. Each hazard below is
// prepended to both the lens response and the grouping response, so one case
// covers both passes: a lost lens shows up as fewer than 3 raw findings, a lost
// grouping as `dedup: "failed"` and the count reverting to RAW.
/**
 * The smallest `{"a":` count that makes THIS interpreter's `raw_decode` raise
 * RecursionError, plus a margin (#426). The search starts its bracket at 1, so
 * a host whose limit sits below 1000 is bisected too rather than reported as
 * 1000 — the claim in this sentence is what the code does, not a floor it
 * happens to start from (pr-review round 1, reasoning lens).
 *
 * Probed, not hardcoded. The threshold is a property of the python build's
 * recursion limit, so a literal that stops raising elsewhere would leave the
 * hazard case below silently vacuous — still PASSing, but no longer proving
 * that a RecursionError (a RuntimeError, NOT a ValueError) is caught rather
 * than escaping the scanner and killing the collector.
 *
 * It is also what the 20000 literal cost: the raise happens at the FIRST
 * candidate and the remaining attempts prove nothing, while `bin/pr-review`'s
 * rescan walks all of them at one character per failure. Measured on this host,
 * 20000 openers cost 8.6s per scan; four scans run per case, so ~34.4s of the
 * case's measured 35.5s is that walk — for a margin of 2x over a threshold
 * of 9997. The quadratic walk
 * itself is #426's other half and belongs in bin/pr-review, not here.
 *
 * The doubling search is capped at 200000 and the cap itself is always TESTED
 * before the probe gives up — a bare doubling loop can jump from a hi below
 * the cap straight past it (e.g. 128000 -> 256000), skipping every untested
 * value in between, including ones under the cap where the real threshold
 * could sit. Reporting SKIP off that untested gap would be a false negative:
 * "no depth we happened to land on raises" read as "no depth up to 200000
 * raises" (#426 round 2, pr-review self-review).
 *
 * The `spawnSync` call itself carries a 10s timeout. The probe costs ~0.01s
 * on a healthy interpreter (18 raw_decode calls), so 10s is pure headroom —
 * its only job is to keep a hung or missing python3 from blocking module load
 * forever; a timed-out probe falls through the same "probe failed" warning
 * path as any other unreadable result and the case runs at the FALLBACK
 * depth instead (#426 round 2).
 */
const RECURSION_OPENERS: number | null = (() => {
	const FALLBACK = 20000;
	// Doubling alone is too coarse: it answers 16000 for a threshold of 9997, and
	// the cost of the hazard case is quadratic in the answer. Double to bracket,
	// then bisect. Counted on that same scenario: 5 doubling calls to bracket
	// [8000, 16000] and 13 bisection calls, 18 in all — each a raw_decode from
	// position 0 on a short string, 0.01s for the lot (an earlier version of this
	// comment guessed "about fourteen": four calls short, and guessed rather
	// than counted).
	const probe = spawnSync("python3", ["-c", `
import json
dec = json.JSONDecoder()

def raises(n):
    try:
        dec.raw_decode('{"a":' * n, 0)
    except RecursionError:
        return True
    except ValueError:
        return False
    return False

CAP = 200000
lo, hi = 1, 1000
# r holds the last raises() result so the post-loop check below never has to
# call raises(hi) a second time — an earlier version of this probe rechecked
# it, which cost one extra raw_decode on every run and undercounted the "18
# in all" claim above by one (#426 round 3, reasoning lens). The loop exits
# one of two ways: r becomes True below CAP (the common case, e.g. the
# threshold=9997 example above — CAP is never reached, let alone tested), or
# doubling reaches CAP itself, which IS then tested, but only that once
# (r already holds CAP's own result afterward, never a stale one). Either
# way, no raises() call is ever repeated — that is the guarantee this
# restructuring adds, not that CAP itself is always tested (#426 round 4,
# reasoning lens — the first cut of this comment claimed the latter).
while True:
    r = raises(hi)
    if r:
        break
    if hi >= CAP:
        break
    lo, hi = hi, min(hi * 2, CAP)
if not r:
    print(0)
else:
    while lo < hi:
        mid = (lo + hi) // 2
        if raises(mid):
            hi = mid
        else:
            lo = mid + 1
    print(lo)
`], { encoding: "utf8", timeout: 10_000 });
	// Trust stdout only when the probe actually exited 0. The embedded python
	// prints on its two success paths alone, but gating on shape rather than
	// process success meant a future stray print (a debug line added ahead of
	// a crash, say) could hand a nonzero-exit run's partial stdout to
	// Number.parseInt and have it silently accepted as the real threshold —
	// exactly the "proving nothing, quietly" failure mode the warning below
	// exists to rule out (#426 round 3, contract lens).
	const found = probe.status === 0 ? Number.parseInt((probe.stdout || "").trim(), 10) : Number.NaN;
	// A probe that ran and printed 0 has established something: doubling passed
	// through 20000 on its way past 200000 WITHOUT raising, so the old fallback is
	// not merely slow here — it is already disproven, and running the case with it
	// would exercise nothing while reporting PASS (pr-review round 2, contract
	// lens). That is a skip, declared, not a silent green.
	if (found === 0) {
		console.log(
			`  ##SKIP## no '{"a":' depth up to 200000 raises RecursionError on this python3 — ` +
				`the hazard case cannot prove the non-ValueError catch here (#426)`,
		);
		return null;
	}
	if (!Number.isFinite(found) || found < 0) {
		// Loudly, not silently (pr-review round 1, contract lens). The whole point
		// of probing is that a stale constant makes this case vacuous without
		// saying so; a probe that fails quietly recreates that one level up, and
		// nobody learns the interpreter changed. The fallback still runs — slow,
		// never wrong — but it announces itself.
		console.warn(
			`⚠️  RecursionError probe failed (exit ${probe.status}${
				probe.signal ? `, signal ${probe.signal}` : ""
			}${probe.error ? `, ${probe.error.message}` : ""
			}${probe.stderr ? `: ${String(probe.stderr).trim().split("\n")[0]}` : ""}) — ` +
				`falling back to ${FALLBACK} openers. The hazard case still runs, slowly; ` +
				`if raw_decode no longer raises at all, it is now proving nothing (#426).`,
		);
		return FALLBACK;
	}
	// A margin over the probed threshold, so a slightly deeper limit on some
	// other build still raises.
	return Math.ceil(found * 1.2);
})();

const PROSE_HAZARDS: Array<{ name: string; prose?: string; post?: string }> = [
	// A brace in the explanation — `find("{")`/`rfind("}")` spanned from the first
	// brace to the last, which is neither the payload nor valid JSON (#378).
	{ name: "a brace in the prose", prose: 'Grouping note: avoid ${VAR} in prose.\n' },
	// An ODD number of quotes. Hand-rolled string tracking toggles `in_str` on
	// every '"', so one unbalanced quote — a quoted identifier, a 6" measurement —
	// left the scanner inside a string across the real payload and it saw nothing.
	{ name: 'an odd number of " in the prose', prose: 'Mind the 6" gap before the payload.\n' },
	// An unmatched OPENING brace. Depth-counting fixed the stray closer and left
	// this one: depth never returns to 0, so no span is ever yielded and the whole
	// response is discarded — a lens quoting `|| { echo ...` does exactly this.
	{ name: "an unmatched { in the prose", prose: "A fragment: || { echo hi\n" },
	// A JSON-shaped preamble whose key is the RIGHT key with the WRONG type.
	// Stopping at the first object that merely HAS the key is position-trust by
	// another name — the thing the balanced scan exists to remove.
	{ name: "a JSON preamble carrying the key with the wrong type",
		prose: '{"findings":"none"}\n{"groups":"see below"}\n' },
	// The model echoing the prompt's OWN schema before answering. Both echoes are
	// well-formed objects with a `findings` list, so first-object-wins handed the
	// answer to the prompt: the empty one recorded a lens that found defects as
	// clean (exit 0, PR opens), the placeholder one invented a finding titled
	// "short". This is the failure the gate exists to prevent, arriving through the
	// parser instead of the reviewer.
	{ name: "the prompt's own empty schema echoed first",
		prose: 'Return {"findings":[]} if you find nothing. Here is my answer:\n' },
	{ name: "the prompt's placeholder schema echoed first",
		prose: '{"findings":[{"severity":"Critical|High|Medium|Low","file":"path","line":123,"title":"short","detail":"what is wrong and why it matters"}]}\nMy actual answer:\n' },
	// Nesting deep enough to blow the decoder's stack. `raw_decode` raises
	// RecursionError there, which is a RuntimeError and NOT a ValueError: catching
	// only ValueError let it escape the scanner, kill the collector before it wrote
	// its summary, and end pr-review at exit 1 — every lens's findings lost and the
	// PR opened unreviewed. The count comes from RECURSION_OPENERS above, which
	// probes this interpreter rather than trusting a literal (#426).
	// Present only where the probe found a depth that raises — see
	// RECURSION_OPENERS. Absent, the suite has said ##SKIP## rather than running
	// a case that cannot fail.
	...(RECURSION_OPENERS === null
		? []
		: [{ name: "nesting deep enough to raise RecursionError",
			prose: '{"a":'.repeat(RECURSION_OPENERS) + "\n" }]),
	// The model echoing the prompt's OWN schema AFTER its real answer, not
	// before. A pure LAST-wins fix (briefly shipped between #378's first and
	// second commits) beat the leading-echo cases above and then lost to
	// these: the trailing echo is the very last qualifying object in the
	// response, so "take the last match" handed the answer right back to the
	// prompt from the opposite direction (macroscopeapp, #378 round 2). Only
	// a content-based selection — never trust either end of the response —
	// survives both directions at once.
	{ name: "the prompt's own empty schema echoed LAST",
		post: '\nRemember: return {"findings":[]} if you find nothing.' },
	{ name: "the prompt's placeholder schema echoed LAST",
		post: '\nFor reference, the schema is {"findings":[{"severity":"Critical|High|Medium|Low",' +
			'"file":"path","line":123,"title":"short","detail":"what is wrong and why it matters"}]}.' },
	// The CLUSTERING prompt's own placeholder grouping, echoed on either side of
	// the real partition. The findings side had this covered from both directions
	// and the groups side had nothing: no hazard exercised a groups echo, so a
	// reworded GROUPS_ECHOES_HARD would have drifted away from the CRULES example
	// in silence and a genuine trailing recap would have been taken for the answer
	// — three groups over six ids, every id past 2 pointing at nothing when only
	// three findings exist. The literal is restated here on purpose, never
	// imported: an echo constant that checks itself checks nothing.
	// ONE DIRECTION ONLY, and the earlier claim that this catches "a reworded
	// CRULES schema" was wrong: this hazard hardcodes the same literal as the
	// constant, so it fails when the CONSTANT drifts. Rewording the CRULES
	// heredoc alone still fails nothing here.
	{ name: "the clustering prompt's placeholder grouping echoed first",
		prose: '{"groups":[[0,3],[1],[2,4,5]]}\nMy actual grouping:\n' },
	{ name: "the clustering prompt's placeholder grouping echoed LAST",
		post: '\nFor reference, the grouping schema is {"groups":[[0,3],[1],[2,4,5]]}.' },
];
for (const hazard of PROSE_HAZARDS) {
	const sb = makeSandbox();
	const env = stubs(sb, "clusterprose", undefined, hazard.prose, hazard.post);
	env.PR_REVIEW_NO_CLUSTER = "0";
	const { code, out } = run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	// Read defensively: a hazard that kills the collector leaves the log created
	// but EMPTY, and a bare JSON.parse there ends the whole suite with a stack
	// trace instead of a failed check — the run reports nothing about the other
	// hazards, which is the same "could not look" / "found nothing" merge this
	// file exists to keep apart.
	const rawLog = files.length ? fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8") : "";
	let d: any = null;
	try { d = JSON.parse(rawLog); } catch { /* left null; asserted below */ }
	check(d !== null, `${hazard.name} → the run still wrote a parseable log`,
		`${rawLog.length} bytes, exit ${code}: ${out.slice(0, 300)}`);
	if (d === null) continue;
	check(d.findings.length === 3, `${hazard.name} → all three lenses still parsed`,
		`${d.findings.length} raw: ${JSON.stringify(d.failedLenses)}`);
	check(d.dedup === "clustered", `${hazard.name} → grouping still clustered, not 'failed'`,
		`${d.dedup}: ${d.dedupNote || ""}`);
	check(d.distinctFindings === 2, `${hazard.name} → the model's partition is honoured (2 of 3)`,
		String(d.distinctFindings));
	check(Array.isArray(d.distinct?.[0]?.mergedFrom) && d.distinct[0].mergedFrom.length === 2,
		`${hazard.name} → the merged pair records what it merged`,
		JSON.stringify(d.distinct?.[0]?.mergedFrom));
	check(code === 7, `${hazard.name} → findings still block`, `got ${code}: ${out}`);
	check(!/NOT deduplicated/.test(out), `${hazard.name} → output does not claim a raw count`, out);
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

// --- round-3 Highs: a bad lens costs only its own lens, and only our children die ---
console.log("\nround-3 High regressions:");
{
	// One malformed envelope must not discard the other lenses' findings, and must
	// not take the whole collector down with it.
	const sb = makeSandbox();
	const env = stubs(sb, "arrayenv");
	const { code, out } = run(PR_REVIEW, sb.clone, env);
	check(code === 8, "array envelope → exit 8, collector survived but zero lenses ran (#401)", `got ${code}: ${out}`);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	check(files.length === 1, "array envelope → a log was still written", JSON.stringify(files));
	if (files.length) {
		const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
		check(d.failedLenses.length === 3, "array envelope → each lens fails on its own", String(d.failedLenses.length));
		check(/unusable envelope/.test(d.failedLenses[0]?.why || ""),
			"array envelope → the reason names the shape problem", JSON.stringify(d.failedLenses[0]?.why));
	}
}
{
	// Not a git repository is a USAGE error (2) per the shared #224 table this
	// change amends — shipping a header that disagreed would recreate the exact
	// contradiction the exit-7 row was added to resolve.
	const sb = makeSandbox();
	const env = stubs(sb, "clean");
	const plain = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-norepo-")));
	const { code } = run(PR_REVIEW, plain, env);
	check(code === 2, "not a git repo → exit 2 (matches the #224 table)", `got ${code}`);
	fs.rmSync(plain, { recursive: true, force: true });
}
{
	// `kill 0` would signal the CALLER's whole process group. The traps must name
	// the script's own children by pid.
	// Comment lines are excluded: the file explains at length WHY `kill 0` is
	// wrong, and matching that prose would make this assertion unfalsifiable.
	const codeLines = fs.readFileSync(PR_REVIEW, "utf8")
		.split("\n")
		.filter((l) => !l.trim().startsWith("#"));
	check(!/\bkill 0\b/.test(codeLines.join("\n")),
		"no bare `kill 0` in code — it would kill the caller's process group", "");
	const src = codeLines.join("\n");
	check(/LENS_PIDS\+=\(\$!\)/.test(src), "lens pids are tracked for a targeted kill", "");
}

// --- round-4 Highs, both regressions of round-3 fixes ---
console.log("\nround-4 High regressions:");
{
	const code = fs.readFileSync(PR_REVIEW, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
	// Killing the `{...} &` wrapper does not kill the `timeout claude` inside it.
	check(/pkill -TERM -P|--ppid/.test(code), "kill_lenses reaps the lens CHILDREN, not just the wrapper", "");
	// A lens that ran and dropped one malformed finding is a warning, not a failure.
	check(/lensWarnings/.test(code), "dropped-finding case is a warning, separate from failedLenses", "");
}
{
	// A fully working lens must never be counted as failed coverage.
	const sb = makeSandbox();
	const env = stubs(sb, "findings");
	run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(d.lensesRan === 3, "all lenses working → lensesRan 3", String(d.lensesRan));
	check(d.status === "reviewed", "all lenses working → status 'reviewed'", String(d.status));
	check(Array.isArray(d.lensWarnings), "log carries a lensWarnings array", JSON.stringify(d.lensWarnings));
}

// --- #379 round 5: the payload must be SELECTED, not assumed to be first ---
console.log("\nthe review payload is identified, not taken by position:");
{
	// Prose containing a brace no longer beats the real payload.
	const sb = makeSandbox();
	const env = stubs(sb, "prosebrace");
	const { code, out } = run(PR_REVIEW, sb.clone, env);
	check(code === 7, "prose brace before the payload → still exit 7 (findings seen)", `got ${code}: ${out}`);
	check(/stub finding/.test(out), "prose brace → the finding survives", out);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(d.lensesRan === 3, "prose brace → all 3 lenses counted as ran", String(d.lensesRan));
}
{
	// An object with no `findings` key is a FAILED lens, never a clean review.
	const sb = makeSandbox();
	const env = stubs(sb, "errorobject");
	const { code, out } = run(PR_REVIEW, sb.clone, env);
	check(/lenses failed/.test(out), "{\"error\":…} → counted as failed, not as a clean review", out);
	check(code === 8, "{\"error\":…} → exit 8, zero lenses ran (#401)", `got ${code}: ${out}`);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(d.lensesRan === 0, "{\"error\":…} → lensesRan 0, not 3", String(d.lensesRan));
	check(d.status === "reviewed-none", "{\"error\":…} → status reviewed-none", String(d.status));
}

// --- #379 round 5: the timeout is validated, and the log dir maps to a code ---
console.log("\npreconditions refuse with a code from the shared table:");
{
	const sb = makeSandbox();
	// "" is deliberately absent: ${PR_REVIEW_TIMEOUT:-180} substitutes the default
	// for empty as well as unset, so an empty value is "use the default", not a typo.
	for (const bad of ["0", "-5", "10m", "600s"]) {
		const env = { ...stubs(sb, "clean"), PR_REVIEW_TIMEOUT: bad };
		const { code, out } = run(PR_REVIEW, sb.clone, env);
		check(code === 2, `PR_REVIEW_TIMEOUT='${bad}' → exit 2`, `got ${code}: ${out}`);
		check(/PR_REVIEW_TIMEOUT/.test(out), `PR_REVIEW_TIMEOUT='${bad}' → names the variable`, out);
	}
}
{
	// An unwritable log dir used to exit with mkdir's raw status (1), a code this
	// script's table does not contain — while the spec asserts pr-review is a
	// member of the shared pr-* contract.
	const sb = makeSandbox();
	const blocker = path.join(sb.root, "not-a-dir");
	fs.writeFileSync(blocker, "");
	const env = { ...stubs(sb, "clean"), PR_REVIEW_LOG_DIR: path.join(blocker, "logs") };
	const { code, out } = run(PR_REVIEW, sb.clone, env);
	check(code === 3, "unwritable PR_REVIEW_LOG_DIR → exit 3 (precondition)", `got ${code}: ${out}`);
	check(/PR_REVIEW_LOG_DIR/.test(out), "unwritable log dir → names the variable to change", out);
}

// Both `timeout` invocations carry a kill grace: TERM asks, KILL insists, and a
// reviewer that ignores TERM would otherwise keep `wait` blocked forever.
{
	// Lines where `timeout` STARTS a command — optionally behind `if`. Matching the
	// bare word anywhere caught this script's own comments and error messages, which
	// discuss timeouts at length; a check that flags prose gets muted, not fixed.
	const lines = fs.readFileSync(PR_REVIEW, "utf8").split("\n");
	// `LC_ALL=C timeout -v` since #410: the wrapper's own expiry announcement is
	// what classifies a timeout, and the locale is part of that contract.
	const invocations = lines.filter((l) => /^\s*(if\s+)?(LC_ALL=C\s+)?timeout\s/.test(l));
	check(invocations.length === 2, `both timeout invocations found (got ${invocations.length})`,
		invocations.join("\n"));
	const bare = invocations.filter((l) => !/--kill-after/.test(l));
	check(bare.length === 0, "no `timeout` invocation without --kill-after", bare.join("\n"));
}

// --- #379 round 6: a reviewer that IGNORES TERM must still be gone -----------
// `--kill-after` does not cover the signal path: when `timeout` is itself
// signalled it forwards and exits rather than escalating, so a TERM-ignoring
// reviewer outlived the trap as an orphan still holding a model call
// (macroscopeapp, PR #379). Behavioural rather than source-level, because "we
// call kill -KILL somewhere" is not the claim — the claim is that it is dead.
//
// TIMING, chosen so the check cannot pass vacuously. The stub sleeps 10s and only
// then writes its marker. pr-review is interrupted at ~3s, its trap TERMs the tree
// and escalates to KILL at ~5s, and the assertion waits until ~14s — comfortably
// past the moment an un-killed stub would have woken and written. A shorter wait
// would pass whether or not the fix works.
console.log("\nINT/TERM leaves no reviewer behind:");
{
	const sleep = (sec: number) => spawnSync("sleep", [String(sec)]);
	const sb = makeSandbox();
	const env = stubs(sb, "clean");
	const survived = path.join(sb.root, "SURVIVED");
	fs.writeFileSync(path.join(sb.binDir, "claude"),
		`#!/usr/bin/env bash\ntrap '' TERM\nsleep 10\ntouch ${JSON.stringify(survived)}\n`,
		{ mode: 0o755 });

	const child = spawn("bash", [PR_REVIEW], {
		cwd: sb.clone, env: { ...process.env, ...GIT_ENV, ...env }, stdio: "ignore",
	});
	sleep(3);              // lenses have spawned their (hung) reviewers
	child.kill("SIGTERM"); // trap: TERM the tree, 2s grace, then KILL
	sleep(11);             // past the stub's own 10s sleep

	check(!fs.existsSync(survived),
		"a reviewer that ignores TERM does not outlive the trap",
		"SURVIVED marker exists — the reviewer was never escalated to KILL");
}

// --- #379 round 7: no HOME is not a reason to stop reviewing ----------------
// `${XDG_STATE_HOME:-$HOME/.local/state}` dereferences HOME unguarded, so under
// `set -u` the script died on "HOME: unbound variable" with exit 1 — a code in no
// table here — before writing a log or reviewing a line. pr-open read that as
// "proceeding unreviewed", so the gate turned itself off in exactly the
// environments that never set HOME: cron, systemd units, containers
// (macroscopeapp, PR #379).
//
// Run through `env -u`, because run() merges process.env and this box has a HOME.
console.log("\nno HOME still reviews, into a temporary log dir:");
{
	const sb = makeSandbox();
	const tmp = path.join(sb.root, "tmp");
	fs.mkdirSync(tmp);
	const { PR_REVIEW_LOG_DIR: _dropped, ...env } = stubs(sb, "clean");
	const { code, out } = run("/usr/bin/env", sb.clone,
		{ ...env, TMPDIR: tmp },
		["-u", "HOME", "-u", "XDG_STATE_HOME", "-u", "PR_REVIEW_LOG_DIR", PR_REVIEW]);

	check(code === 0, "HOME unset → still reviews and exits 0 (clean)", `got ${code}: ${out}`);
	check(!/unbound variable/.test(out), "HOME unset → no unbound-variable abort", out);
	check(/PR_REVIEW_LOG_DIR/.test(out),
		"HOME unset → warns, naming the variable that makes the log durable", out);

	// The degradation is announced AND real: a log was written where it said.
	const named = out.match(/'([^']*pr-review-[^']*)'/);
	check(named !== null, "HOME unset → names the temporary log directory it used", out);
	if (named) {
		const wrote = fs.existsSync(named[1]) && fs.readdirSync(named[1]).length > 0;
		check(wrote, "HOME unset → the named directory actually holds this run's log",
			`${named[1]} is empty or absent`);
	}
	// Private, not a predictable /tmp path: these logs carry the branch diff.
	check(!fs.existsSync(path.join(tmp, "pr-review")),
		"HOME unset → no predictable shared /tmp/pr-review path is created",
		"a guessable path in a world-writable dir is pre-creatable by another user");
}

// --- #379 round 8: the log holds the diff, so it is nobody else's to read ----
// `mkdir -p` and python's `open(log, "w")` both take the AMBIENT umask. On this
// repo's own host (umask 002) that made every run log 0664 and its directory 0775
// — group-WRITABLE and world-readable, in the one artifact that contains the code
// under review (macroscopeapp, PR #379).
//
// The umask is forced here rather than inherited. Under a strict umask the logs
// would come out private for reasons that have nothing to do with this script, and
// every check below would pass while proving nothing. The CONTROL file is what
// rules that out: it is created by the same shell, with the same umask, in the
// same directory, and it must come out 0664. If it does not, the umask never took
// and the results are meaningless — so the control failing is itself a failure.
function runUmask(mask: string, script: string, cwd: string, env: Record<string, string>) {
	try {
		const out = execFileSync("bash", ["-c", `umask ${mask}; "$@" 2>&1`, "_", script], {
			cwd, encoding: "utf8",
			env: { ...process.env, ...GIT_ENV, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}
const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

console.log("\nrun logs are private to their owner:");
{
	const sb = makeSandbox();
	const env = stubs(sb, "clean");
	const dir = env.PR_REVIEW_LOG_DIR;
	const { code, out } = runUmask("002", PR_REVIEW, sb.clone, env);
	check(code === 0, "umask 002 → still reviews and exits 0", `got ${code}: ${out}`);

	const control = path.join(dir, "control");
	execFileSync("bash", ["-c", `umask 002; : > ${JSON.stringify(control)}`]);
	check(modeOf(control) === 0o664,
		"control: umask 002 is really in force (a plain file lands 0664)",
		`control file is ${modeOf(control).toString(8)} — the checks below prove nothing`);

	check(modeOf(dir) === 0o700,
		"a log directory pr-review creates is 0700",
		`got ${modeOf(dir).toString(8)}`);

	const logs = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	check(logs.length === 1, "one log written", JSON.stringify(logs));
	if (logs.length) {
		check(modeOf(path.join(dir, logs[0])) === 0o600,
			"the log file is 0600 — the branch diff is not other users' to read",
			`got ${modeOf(path.join(dir, logs[0])).toString(8)}`);
	}
}
{
	// A directory pr-review did NOT create is warned about, never chmod'd:
	// PR_REVIEW_LOG_DIR can name a path this script does not own, and silently
	// narrowing someone else's directory is a worse surprise than a message. The
	// file inside it is 0600 regardless — that, not the directory, is the guarantee.
	const sb = makeSandbox();
	const dir = path.join(sb.root, "shared-logs");
	fs.mkdirSync(dir);
	fs.chmodSync(dir, 0o755); // mkdir's mode argument is itself masked by the umask
	const env = { ...stubs(sb, "clean"), PR_REVIEW_LOG_DIR: dir };
	const { out } = runUmask("002", PR_REVIEW, sb.clone, env);

	check(/chmod 700/.test(out),
		"a pre-existing world-readable log dir → warns with the command that fixes it", out);
	check(modeOf(dir) === 0o755,
		"…and does not silently narrow a directory it did not create",
		`mode changed to ${modeOf(dir).toString(8)}`);
	const logs = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	check(logs.length === 1 && modeOf(path.join(dir, logs[0])) === 0o600,
		"…while this run's log inside it is still 0600",
		JSON.stringify(logs.map((f) => `${f}:${modeOf(path.join(dir, f)).toString(8)}`)));
}

// --- #379 round 9: 0600 is worthless in a directory someone else can write ---
// In such a directory another account can unlink the log and leave a symlink in
// its place between creation and any later write, and every writer follows it —
// so the file mode protects nothing (macroscopeapp, PR #379). No mode closes that.
// Not being in such a directory does, so pr-review stops using it and degrades to
// a private temporary one: the same trade as round 7, artifact over gate.
console.log("\na log directory others can write is not used at all:");
{
	const sb = makeSandbox();
	const shared = path.join(sb.root, "world-writable");
	fs.mkdirSync(shared);
	fs.chmodSync(shared, 0o777);
	const env = { ...stubs(sb, "clean"), PR_REVIEW_LOG_DIR: shared };
	const { code, out } = runUmask("002", PR_REVIEW, sb.clone, env);

	check(code === 0, "world-writable log dir → still reviews and exits 0", `got ${code}: ${out}`);
	check(fs.readdirSync(shared).length === 0,
		"world-writable log dir → nothing is written there",
		JSON.stringify(fs.readdirSync(shared)));
	check(/NOT logging/.test(out) && /every account/.test(out),
		"world-writable log dir → says it refused, and why", out);

	// Degraded, not skipped: the run still produced a log somewhere it named.
	const named = out.match(/Log: '([^']+)'/);
	check(named !== null, "world-writable log dir → names where it logged instead", out);
	if (named) {
		const logs = fs.readdirSync(named[1]).filter((f) => f.endsWith(".json"));
		check(logs.length === 1, "…and that directory holds this run's log", named[1]);
		check(modeOf(named[1]) === 0o700, "…which is private", modeOf(named[1]).toString(8));
	}
}
{
	// The predicate is about who can WRITE, not who is in the group. A per-user
	// group is the Debian/Ubuntu default that makes umask 002 ordinary; treating
	// g+w as a hole there would exile every log on such a host to /tmp for no gain.
	// This box is exactly that case, so the check is meaningful here.
	const sb = makeSandbox();
	const own = path.join(sb.root, "group-writable");
	fs.mkdirSync(own);
	fs.chmodSync(own, 0o770); // g+w, our own primary group, no other members
	const env = { ...stubs(sb, "clean"), PR_REVIEW_LOG_DIR: own };
	const { out } = runUmask("002", PR_REVIEW, sb.clone, env);
	const soleMember = execFileSync("python3", ["-c",
		"import grp,os,pwd,sys;st=os.stat(sys.argv[1]);me=os.geteuid();" +
		"o=set(grp.getgrgid(st.st_gid).gr_mem)|{p.pw_name for p in pwd.getpwall() if p.pw_gid==st.st_gid};" +
		"o.discard(pwd.getpwuid(me).pw_name);print('yes' if not o else 'no')", own],
		{ encoding: "utf8" }).trim();
	if (soleMember === "yes") {
		check(!/NOT logging/.test(out),
			"group-writable, but the group has no other member → still used", out);
		check(fs.readdirSync(own).filter((f) => f.endsWith(".json")).length === 1,
			"…and this run's log is there", JSON.stringify(fs.readdirSync(own)));
	} else {
		check(/NOT logging/.test(out),
			`group-writable with other members (${soleMember}) → refused`, out);
	}
}
{
	// A symlink at the log path must be REFUSED, never followed. The old spelling
	// truncated whatever the link pointed at — measured, not theorised.
	//
	// SCOPE, stated because it is easy to overclaim here: the log filename carries
	// a second-resolution stamp AND the pid, so it cannot be predicted from out
	// here, and planting a link under a name the run will not choose would assert
	// nothing while looking thorough. This is therefore a MECHANISM proof — the
	// script creates the log this exact way, and this exact way refuses a symlink.
	// The end-to-end guarantee is the directory check above: in a directory only
	// its owner can write, nobody is there to plant the link in the first place.
	const src = fs.readFileSync(PR_REVIEW, "utf8");
	const creation = src.split("\n").filter((l) => /:\s*>\s*"\$LOG"/.test(l));
	check(creation.length === 1, "the log is created in exactly one place",
		creation.join("\n"));
	check(creation.every((l) => /set -C/.test(l)),
		"the log is created with `set -C` — O_EXCL, which fails on a symlink",
		creation.join("\n"));

	const sb = makeSandbox();
	const victim = path.join(sb.root, "VICTIM");
	const link = path.join(sb.root, "planted.json");
	fs.writeFileSync(victim, "SECRET");
	fs.symlinkSync(victim, link);
	const guarded = spawnSync("bash", ["-c", `set -C; umask 077; : > ${JSON.stringify(link)}`]);
	check(guarded.status !== 0, "…and that spelling refuses to open a planted symlink",
		`exit ${guarded.status}`);
	check(fs.readFileSync(victim, "utf8") === "SECRET",
		"…leaving the link's target untouched",
		`VICTIM was clobbered: ${JSON.stringify(fs.readFileSync(victim, "utf8"))}`);

	// Non-vacuous: the SAME redirection without `set -C` truncates through the
	// link. If this control passes, the guard above measured nothing.
	const control = path.join(sb.root, "CONTROL");
	const clink = path.join(sb.root, "control-link.json");
	fs.writeFileSync(control, "SECRET");
	fs.symlinkSync(control, clink);
	spawnSync("bash", ["-c", `umask 077; : > ${JSON.stringify(clink)}`]);
	check(fs.readFileSync(control, "utf8") === "",
		"control: without `set -C` the same redirection DOES truncate through a symlink",
		"the primitive is safe on its own, so the guard above proves nothing");
}

// --- #379 round 10: the leaf being safe says nothing about the path to it ----
// An account that can RENAME a parent directory moves ours aside and leaves a
// symlink where it stood; every later write then follows the new path, and the
// leaf's own 0700 never came into it (macroscopeapp, PR #379). So the whole
// resolved chain is audited — the same check OpenSSH makes on ~/.ssh under
// StrictModes, for the same reason.
console.log("\nthe path above the log dir is audited too:");
{
	const sb = makeSandbox();
	const parent = path.join(sb.root, "loose-parent");
	const dir = path.join(parent, "logs");
	fs.mkdirSync(dir, { recursive: true });
	fs.chmodSync(dir, 0o700);   // the leaf itself is impeccable…
	fs.chmodSync(parent, 0o777); // …and the directory holding it is not
	const env = { ...stubs(sb, "clean"), PR_REVIEW_LOG_DIR: dir };
	const { code, out } = runUmask("002", PR_REVIEW, sb.clone, env);

	check(code === 0, "loose parent → still reviews and exits 0", `got ${code}: ${out}`);
	check(/NOT logging/.test(out) && /above it/.test(out),
		"a 0700 log dir inside a world-writable parent → refused, naming the parent", out);
	check(fs.readdirSync(dir).length === 0,
		"…and nothing is written into it", JSON.stringify(fs.readdirSync(dir)));
}
{
	// The sticky bit is the exception, and it is load-bearing rather than a
	// concession: on a sticky directory a non-owner cannot rename or delete an
	// entry it does not own, which is precisely this attack. Without the exception
	// /tmp would be condemned — and pr-review's own no-HOME fallback lands there,
	// so the rule would forbid its own last resort.
	const sb = makeSandbox();
	const parent = path.join(sb.root, "sticky-parent");
	const dir = path.join(parent, "logs");
	fs.mkdirSync(dir, { recursive: true });
	fs.chmodSync(dir, 0o700);
	// NOT fs.chmodSync: bun 1.3.14 silently drops setuid/setgid/STICKY (0o1777
	// lands as 0o777), so the whole point of this case evaporates and it fails
	// against a correct script. node keeps them; the suite runs under bun. Verified
	// both ways before blaming the script — /usr/bin/chmod is the portable answer.
	spawnSync("chmod", ["1777", parent]); // world-writable AND sticky, exactly like /tmp
	check((fs.statSync(parent).mode & 0o1000) !== 0,
		"precondition: the sticky bit is actually set on the parent",
		`mode is ${(fs.statSync(parent).mode & 0o7777).toString(8)} — this case cannot test what it claims`);
	const env = { ...stubs(sb, "clean"), PR_REVIEW_LOG_DIR: dir };
	const { out } = runUmask("002", PR_REVIEW, sb.clone, env);

	check(!/NOT logging/.test(out),
		"a sticky world-writable parent → accepted, as /tmp must be", out);
	check(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length === 1,
		"…and this run's log is written there", JSON.stringify(fs.readdirSync(dir)));
}
{
	// Every python writer reopens the log BY PATH, so each is its own chance to
	// follow a link swapped in after creation. O_NOFOLLOW on the final component
	// closes that. Source-level by necessity — the swap cannot be staged from here
	// without predicting stamp and pid — but it asserts the shape exactly: no
	// writer may use a bare open(..., "w").
	const src = fs.readFileSync(PR_REVIEW, "utf8");
	// Comment lines are excluded deliberately: this file DISCUSSES the old spelling
	// at length, and a check that flags prose gets muted rather than fixed — the
	// same trap the `timeout` check above already fell into once.
	const bare = src.split("\n")
		.filter((l) => !/^\s*#/.test(l))
		.filter((l) => /\bopen\((log|sys\.argv\[1\]), "w"\)/.test(l));
	check(bare.length === 0, "no log writer uses a bare open(..., \"w\")", bare.join("\n"));
	const writes = src.split("\n").filter((l) => /_open_private\(/.test(l) && !/^def |"""/.test(l.trim()));
	check(writes.filter((l) => /json\.dump|indent=2/.test(l)).length === 3,
		"all three writers go through the O_NOFOLLOW helper",
		writes.join("\n"));
	// Defined once per heredoc — they are separate python processes, and a helper
	// defined in one is a NameError in the next.
	const defs = src.split("\n").filter((l) => /^def _open_private/.test(l));
	check(defs.length === 3, `the helper is defined in each of the three heredocs (got ${defs.length})`,
		"a helper defined in one heredoc does not exist in another");

	// And the flag does what the name claims, on this kernel.
	const sb = makeSandbox();
	const victim = path.join(sb.root, "NF-VICTIM");
	const link = path.join(sb.root, "nf-link.json");
	fs.writeFileSync(victim, "SECRET");
	fs.symlinkSync(victim, link);
	const r = spawnSync("python3", ["-c",
		"import os,sys;os.fdopen(os.open(sys.argv[1], os.O_WRONLY|os.O_TRUNC|os.O_NOFOLLOW),'w')", link]);
	check(r.status !== 0, "O_NOFOLLOW refuses a symlink at the final component", `exit ${r.status}`);
	check(fs.readFileSync(victim, "utf8") === "SECRET",
		"…leaving the target intact",
		`clobbered: ${JSON.stringify(fs.readFileSync(victim, "utf8"))}`);
}

// --- #379 round 11 -----------------------------------------------------------
// $WORK is not a scratch area, it is the review itself: the diff, the prompts, and
// every lens's raw output. An account that can rename TMPDIR substitutes a lens's
// .out and FABRICATES findings — worse than reading them, because a manufactured
// clean review opens the PR (macroscopeapp, PR #379). Same audit as the log dir.
console.log("\nthe workspace gets the same audit as the log dir:");
{
	const sb = makeSandbox();
	const bad = path.join(sb.root, "loose-tmp");
	fs.mkdirSync(bad);
	spawnSync("chmod", ["777", bad]); // world-writable, NOT sticky
	const env = { ...stubs(sb, "clean"), TMPDIR: bad };
	// Report the real workspace from inside a lens: stdin is $WORK/<lens>.prompt.
	const seen = path.join(sb.root, "WORKSEEN");
	fs.writeFileSync(path.join(sb.binDir, "claude"),
		`#!/usr/bin/env bash\nreadlink -f /proc/self/fd/0 >> ${JSON.stringify(seen)}\n`
		+ `printf '%s' '{"is_error":false,"result":"{\\"findings\\":[]}"}'; exit 0\n`,
		{ mode: 0o755 });
	const { code, out } = runUmask("002", PR_REVIEW, sb.clone, env);
	const witness = fs.existsSync(seen)
		? fs.readFileSync(seen, "utf8").trim().split("\n").filter(Boolean) : [];

	check(code === 0, "unsafe TMPDIR → still reviews and exits 0", `got ${code}: ${out}`);
	check(/TMPDIR/.test(out) && /not safe to work in/.test(out),
		"unsafe TMPDIR → says so, naming the variable", out);
	// Where the workspace ACTUALLY went, not merely where it no longer is: the
	// EXIT trap deletes it either way, so an empty directory afterwards is true
	// whether or not the fix works. The stub reports its own stdin, which IS
	// $WORK/<lens>.prompt, so the recorded path names the real workspace.
	check(!witness.some((w) => w.startsWith(bad)),
		"unsafe TMPDIR → the workspace is not created in it",
		`workspace landed in the unsafe dir: ${witness.join(", ")}`);
	check(witness.length === 3, "…and the witness actually observed all three lenses",
		`saw ${witness.length}: ${witness.join(", ")}`);
}
{
	// /tmp is root-owned, world-writable and sticky — the default workspace on
	// every host. An audit that condemns it condemns the tool, so this is the
	// case that keeps the parent rule honest rather than merely strict.
	const sb = makeSandbox();
	const env = stubs(sb, "clean");
	const { code, out } = runUmask("002", PR_REVIEW, sb.clone, env);
	check(code === 0 && !/not safe to work in/.test(out),
		"default TMPDIR (/tmp: root-owned, sticky) → accepted", `${code}: ${out}`);
}
{
	// A log identifies the exact input that produced it. `base` alone did not:
	// with --base it is whatever ref the caller typed, and refs move. Recording
	// the two SHAs reproduces the diff exactly without embedding it — a diff is
	// unbounded, and these logs are already tens of KB.
	const sb = makeSandbox();
	const env = stubs(sb, "findings");
	runUmask("002", PR_REVIEW, sb.clone, env);
	const dir = env.PR_REVIEW_LOG_DIR;
	const d = JSON.parse(fs.readFileSync(path.join(dir,
		fs.readdirSync(dir).filter((f) => f.endsWith(".json"))[0]), "utf8"));
	const head = git(sb.clone, ["rev-parse", "HEAD"]);
	check(d.schema === "pr-review/run@1", "the log declares its schema",
		JSON.stringify(d.schema));
	check(d.headSha === head, "the log records the head sha it reviewed",
		`${d.headSha} != ${head}`);
	check(/^[0-9a-f]{40}$/.test(d.baseSha || ""), "…and a resolved base sha",
		JSON.stringify(d.baseSha));
	check(d.baseSha !== d.headSha, "…which is not the head", `${d.baseSha}`);
	// The pair must actually reproduce a diff, or it is decoration.
	const rt = spawnSync("git", ["-C", sb.clone, "diff", "--stat", `${d.baseSha}..${d.headSha}`],
		{ encoding: "utf8" });
	check(rt.status === 0 && /feature\.sh/.test(rt.stdout),
		"…and the pair reproduces the reviewed diff", `${rt.status}: ${rt.stdout}`);
}
{
	// After `wait` the lens pids are reaped and the numbers are the OS's to reuse.
	// kill_lenses walks each pid's DESCENDANTS, so a stale entry can take out an
	// unrelated process tree — and clustering, which runs after the wait, is
	// another reviewer call and another chance to be interrupted.
	const src = fs.readFileSync(PR_REVIEW, "utf8").split("\n");
	const waitAt = src.findIndex((l) => /^wait$/.test(l));
	check(waitAt !== -1, "the lens fan-out still ends in a bare `wait`", "");
	const after = src.slice(waitAt + 1, waitAt + 12).join("\n");
	check(/^LENS_PIDS=\(\)$/m.test(after),
		"the reaped pids are cleared immediately after `wait`", after);
}

// --- #379 round 12 -----------------------------------------------------------
// A POSIX ACL grants access the mode bits cannot express. The kernel folds a
// named-user entry's ceiling into the GROUP bits, so a directory carrying
// `u:someone:rwx` reads back as plain g+w — and the group-membership test then
// CLEARS it, because the owning group really does have no other members
// (macroscopeapp, PR #379). Only the ACL can be asked.
//
// setfacl is not installed on this host, so the ACL is written straight to the
// xattr: u32 version 2, then 8-byte entries of u16 tag, u16 perm, u32 id. The
// kernel validates it, so a malformed blob fails the setxattr rather than
// silently testing nothing — and the precondition below asserts it took.
function setAcl(dir: string, uid: number): boolean {
	const e = (tag: number, perm: number, id: number) => {
		const b = Buffer.alloc(8);
		b.writeUInt16LE(tag, 0); b.writeUInt16LE(perm, 2); b.writeUInt32LE(id, 4);
		return b;
	};
	const ver = Buffer.alloc(4); ver.writeUInt32LE(2, 0);
	const acl = Buffer.concat([ver,
		e(0x01, 7, 0xffffffff),  // USER_OBJ  rwx
		e(0x02, 7, uid),          // USER:uid  rwx  <- the entry that matters
		e(0x04, 0, 0xffffffff),  // GROUP_OBJ ---
		e(0x10, 7, 0xffffffff),  // MASK      rwx
		e(0x20, 0, 0xffffffff)]); // OTHER     ---
	const r = spawnSync("python3", ["-c",
		"import os,sys;os.setxattr(sys.argv[1],'system.posix_acl_access',sys.stdin.buffer.read())", dir],
		{ input: acl });
	return r.status === 0;
}

console.log("\nan ACL is access the mode bits cannot show:");
{
	const sb = makeSandbox();
	const dir = path.join(sb.root, "acl-logs");
	fs.mkdirSync(dir);
	fs.chmodSync(dir, 0o700);
	const applied = setAcl(dir, 1); // uid 1 (daemon): not us, need not be a login
	if (!applied) {
		check(false, "precondition: a POSIX ACL could be applied",
			"setxattr failed — this filesystem carries no ACLs, so the case is untested");
	} else {
		// The trap, stated as an assertion: the mode bits look fine on their own.
		const m = fs.statSync(dir).mode & 0o777;
		check((m & 0o002) === 0, "precondition: the ACL leaves the mode bits looking safe",
			`mode ${m.toString(8)} is world-writable on its own, so this proves nothing`);
		const env = { ...stubs(sb, "clean"), PR_REVIEW_LOG_DIR: dir };
		const { code, out } = runUmask("002", PR_REVIEW, sb.clone, env);
		check(code === 0, "ACL-widened log dir → still reviews and exits 0", `${code}: ${out}`);
		check(/NOT logging/.test(out) && /ACL/.test(out),
			"a log dir an ACL opens to another uid → refused, naming the ACL", out);
		check(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length === 0,
			"…and no log is written into it", JSON.stringify(fs.readdirSync(dir)));
	}
}
{
	// An unanswerable verdict must not read as "fine". A missing TMPDIR made
	// dir_verdict print NOTHING, the `= unsafe` test fell through to "not unsafe",
	// and the unguarded mktemp then died with exit 1 — untabled, and pr-open reads
	// any nonzero as "proceeding unreviewed", so the gate turned itself off.
	const sb = makeSandbox();
	const env = { ...stubs(sb, "clean"), TMPDIR: path.join(sb.root, "no-such-dir") };
	const { code, out } = runUmask("002", PR_REVIEW, sb.clone, env);
	check(code === 0, "nonexistent TMPDIR → still reviews and exits 0, not 1",
		`got ${code}: ${out}`);
	check(/TMPDIR/.test(out), "nonexistent TMPDIR → says which variable is wrong", out);
	// The distinction is WHERE it failed, not whether the words "No such file"
	// appear — the verdict says exactly that, and correctly so.
	check(!/mktemp: failed/.test(out),
		"nonexistent TMPDIR → answered by the audit, never by an unguarded mktemp", out);
	check(/Using \/tmp for this run instead/.test(out),
		"nonexistent TMPDIR → falls back rather than giving up", out);
}

// --- #379 round 13: a finding has to say something ---------------------------
// `{"findings":[{}]}` parses, counts, exits 7 and prints `[?/?] ?:?` with an empty
// detail line — a PR blocked by a message nobody can act on, clearable only with
// --reviewed (macroscopeapp, PR #379). This one fails CLOSED rather than open,
// which makes it the gentler class of bug, but a gate that cannot say why it
// refused is still a gate you learn to override.
console.log("\na finding that says nothing is not a finding:");
{
	const sb = makeSandbox();
	const env = stubs(sb, "emptyfinding");
	const { code, out } = runUmask("002", PR_REVIEW, sb.clone, env);
	check(code === 0, "an empty finding object → exit 0, the PR is not blocked",
		`got ${code}: ${out}`);
	// NOT /\[\?\/\?\]/ — the lens name IS populated, so the degenerate line reads
	// `[?/correctness]  ?:?`. Matching the reviewer's shorthand literally would
	// have made this check pass against the unfixed script, which it did once.
	check(!/\[\?\//.test(out), "…and no unknown-severity line is printed", out);

	const dir = env.PR_REVIEW_LOG_DIR;
	const d = JSON.parse(fs.readFileSync(path.join(dir,
		fs.readdirSync(dir).filter((f) => f.endsWith(".json"))[0]), "utf8"));
	check(d.findings.length === 0, "…it is not recorded as a finding",
		JSON.stringify(d.findings));
	// Dropped, but never silently: the lens RAN, so this is a warning, not a
	// failure — filing it as failed would under-report coverage on a lens that
	// worked, the same "could not look"/"found nothing" merge forbidden elsewhere.
	check(d.lensWarnings.length === 3, "…every lens records a warning about the drop",
		JSON.stringify(d.lensWarnings));
	check(d.lensesRan === 3 && d.failedLenses.length === 0,
		"…and coverage still counts all three lenses as having run",
		`ran ${d.lensesRan}, failed ${d.failedLenses.length}`);
	check(d.status === "reviewed", "…so the status is a clean review, not partial", d.status);
}
{
	// The other side of the threshold, and the reason it is not "all five fields":
	// a file-level finding carries no `line` and must survive.
	const sb = makeSandbox();
	const env = stubs(sb, "titleonly");
	const { code, out } = runUmask("002", PR_REVIEW, sb.clone, env);
	check(code === 7, "a finding with a title but no line → still blocks (exit 7)",
		`got ${code}: ${out}`);
	check(/no shebang guard/.test(out), "…and is printed", out);
}


{
	// The model/ceiling rule was prose in three comments and code in none — the
	// "stated but not enforced" shape pr-review's own contract lens hunts for.
	// Only the combination the measurements condemn is checkable, so only that
	// one warns (#403).
	const sb = makeSandbox();
	const env = stubs(sb, "clean");
	env.PR_REVIEW_MODEL = "claude-opus-5";
	const { code, out } = run(PR_REVIEW, sb.clone, env);
	check(code === 0, "a non-default model at the default ceiling still reviews", `${code}: ${out}`);
	check(/PR_REVIEW_MODEL is 'claude-opus-5' at the default 600s ceiling/.test(out),
		"…and warns, naming both values rather than the rule in the abstract", out);
	const raised = stubs(sb, "clean");
	raised.PR_REVIEW_MODEL = "claude-opus-5";
	raised.PR_REVIEW_TIMEOUT = "900";
	check(!/at the default 600s ceiling/.test(run(PR_REVIEW, sb.clone, raised).out),
		"…and says nothing once the ceiling is raised — a warning that always fires is noise", out);
	const dflt = stubs(sb, "clean");
	check(!/at the default 600s ceiling/.test(run(PR_REVIEW, sb.clone, dflt).out),
		"…and nothing for the default model, which is what the ceiling was measured against", out);
	// A reviewer on #410 read `[ "$LENS_TIMEOUT" -eq 600 ]` as bash arithmetic and
	// predicted `0600` would compare as octal 384, silently skipping the warning.
	// It does not: the `[` builtin parses decimal, unlike $(( )). Pinned here
	// because the claim is plausible enough to be "fixed" into a real bug.
	const zeroed = stubs(sb, "clean");
	zeroed.PR_REVIEW_MODEL = "claude-opus-5";
	zeroed.PR_REVIEW_TIMEOUT = "0600";
	check(/at the default 600s ceiling/.test(run(PR_REVIEW, sb.clone, zeroed).out),
		"…and a leading-zero ceiling still counts as the default — `[ -eq ]` is decimal", "0600");
	// Every other diagnostic here respects --quiet and --json; a warning that
	// ignores them puts a line on the stderr of a caller who asked for clean
	// output, which is a contract break however useful the line is (#410).
	for (const flag of ["--quiet", "--json"]) {
		const q = stubs(sb, "clean");
		q.PR_REVIEW_MODEL = "claude-opus-5";
		check(!/at the default 600s ceiling/.test(run(PR_REVIEW, sb.clone, q, [flag]).out),
			`…and is silent under ${flag}, like every other diagnostic`, flag);
	}
}
{
	// Every failedLenses entry, same keys. The two parse-failure paths omitted
	// stderr/exitCode/elapsedSec entirely while the published contract said the
	// VALUES may be null — so `f["exitCode"]` raised instead of returning null,
	// and a consumer had to branch on key presence after all.
	const sb = makeSandbox();
	const env = stubs(sb, "errorobject");
	run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(d.failedLenses.length === 3, "an unusable answer fails every lens", String(d.failedLenses.length));
	// stderr is the reviewer's own, read from the same file fail() reads — not a
	// hardcoded "" that threw away the CLI warning explaining the bad payload.
	check(d.failedLenses.every((f: any) => typeof f.stderr === "string"),
		"…and stderr is read, not stubbed", JSON.stringify(d.failedLenses.map((f: any) => f.stderr)));
	for (const key of ["lens", "why", "cause", "stderr", "exitCode", "elapsedSec"]) {
		check(d.failedLenses.every((f: any) => key in f),
			`…and every entry carries '${key}' — present, even when null`,
			JSON.stringify(d.failedLenses.map((f: any) => Object.keys(f))));
	}
}

{
	// A log directory inside the work tree defeats the "git add -A cannot commit
	// it" guarantee the docs make. Refused, not relocated: quietly writing
	// somewhere else is how evidence goes missing (#410).
	const sb = makeSandbox();
	const env = stubs(sb, "clean");
	env.PR_REVIEW_LOG_DIR = path.join(sb.clone, "logs-inside");
	const { code, out } = run(PR_REVIEW, sb.clone, env);
	check(code === 3, "PR_REVIEW_LOG_DIR inside the repo → exit 3", `${code}: ${out}`);
	check(/is inside the repository/.test(out), "…and says so", out);
	check(/git add -A/.test(out), "…naming the consequence, not just the rule", out);
	check(!fs.existsSync(path.join(sb.clone, "logs-inside")),
		"…and writes nothing there", "directory was created");
}
{
	// The timeout cause comes from `timeout -v`'s own announcement, not from a
	// duration that merely looks like the ceiling. A stub that exits 124 on its
	// own — no wrapper involvement — must NOT be called a timeout (#410).
	const sb = makeSandbox();
	const env = stubs(sb, "exit124");
	const { out } = run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(d.failedLenses.length === 3, "a reviewer exiting 124 itself fails every lens",
		String(d.failedLenses.length));
	check(d.failedLenses.every((f: any) => f.cause === "failed"),
		"…and is 'failed' — without the marker, 124 is just the reviewer's own exit code, " +
		"which happens to be the one `timeout` also uses",
		JSON.stringify(d.failedLenses.map((f: any) => f.cause)));
	check(!/PR_REVIEW_TIMEOUT=/.test(out), "…so no one is told to raise the ceiling", out);
	check(!/OOM/.test(out), "…and no one is sent to dmesg for an ordinary failure", out);
}

console.log("\na lens that TIMED OUT is not a lens that FAILED (#403):");
{
	// Timeout path: `timeout` kills the stub, exit 124.
	const sb = makeSandbox();
	const env = stubs(sb, "hang");
	env.PR_REVIEW_TIMEOUT = "1";
	const { out } = run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(d.failedLenses.length === 3, "every hung lens is recorded as failed", String(d.failedLenses.length));
	check(typeof d.lensTimeoutSec === "number" && d.lensTimeoutSec === 1,
		"…and the log records the ceiling in force, so the human line's number is not invented",
		String(d.lensTimeoutSec));
	check(d.failedLenses.every((f: any) => f.cause === "timeout"),
		"a hung lens records cause 'timeout' — a FIELD, not a sentence to parse",
		JSON.stringify(d.failedLenses.map((f: any) => f.cause)));
	check(d.failedLenses.every((f: any) => f.exitCode === 124 || f.exitCode === 137),
		"…and the exit code consistent with it — necessary evidence, never sufficient, which is " +
		"why the sigkill case below separates the same codes into 'killed'",
		JSON.stringify(d.failedLenses.map((f: any) => f.exitCode)));
	check(/timed out/.test(out), "the human line says it timed out", out);
	check(/PR_REVIEW_TIMEOUT/.test(out), "…and names the knob that raises it — the action, not just the state", out);
	// Still a negative, and a negative passes on empty output — the positives
	// above (/timed out/, /PR_REVIEW_TIMEOUT/) are what prove the printer ran.
	// It replaces `!/or reviewer failure/`, which matched a literal that only
	// ever existed inside a comment and so could not fail at all.
	check(!/reviewer exited/.test(out),
		"…and does not also blame the reviewer, which is the ambiguity being removed", out);
	check(d.failedLenses.every((f: any) => typeof f.elapsedSec === "number"),
		"…and a failed lens still reports how long it took — the third field, not just two",
		JSON.stringify(d.failedLenses.map((f: any) => f.elapsedSec)));
}
{
	// Failure path: the reviewer answers immediately with a nonzero exit.
	const sb = makeSandbox();
	const env = stubs(sb, "broken");
	const { out } = run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	// `.every()` on an empty array is true, so the length floor comes first —
	// without it these checks survive deleting failed-lens recording outright.
	check(d.failedLenses.length === 3, "every broken lens is recorded as failed",
		String(d.failedLenses.length));
	check(d.failedLenses.every((f: any) => f.cause === "failed"),
		"a reviewer that errors records cause 'failed', not 'timeout'",
		JSON.stringify(d.failedLenses.map((f: any) => f.cause)));
	check(!/timed out/.test(out), "…and the human line does not claim a timeout", out);
	check(/boom/.test(out), "…and still quotes the reviewer's own stderr", out);
}
{
	// The measurement #403's closer asks for: without it, "raise the timeout" is a
	// guess. Every lens that RAN reports how long it took, in the machine path.
	const sb = makeSandbox();
	const env = stubs(sb, "clean");
	run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(d.lensSeconds && typeof d.lensSeconds === "object", "the log records per-lens elapsed seconds",
		JSON.stringify(d.lensSeconds));
	check(["correctness", "reasoning", "contract"].every(l => typeof d.lensSeconds?.[l] === "number"),
		"…one number per lens, so a timeout raise is measured rather than guessed",
		JSON.stringify(d.lensSeconds));
}
{
	// 124/137 is necessary evidence of a timeout, not sufficient. The OOM killer
	// also produces 137, and a `claude` that exits 124 of its own accord produces
	// 124 — both would be told "raise PR_REVIEW_TIMEOUT", a knob that would not
	// have helped. The ceiling is checkable against the elapsed seconds we now
	// record, so it is checked (#403 round 2).
	const sb = makeSandbox();
	const env = stubs(sb, "sigkill");
	env.PR_REVIEW_TIMEOUT = "60";
	const { out } = run(PR_REVIEW, sb.clone, env);
	const files = fs.readdirSync(env.PR_REVIEW_LOG_DIR);
	const d = JSON.parse(fs.readFileSync(path.join(env.PR_REVIEW_LOG_DIR, files[0]), "utf8"));
	check(d.failedLenses.length === 3, "every killed lens is recorded as failed",
		String(d.failedLenses.length));
	check(d.failedLenses.every((f: any) => f.cause === "killed"),
		"a lens killed well inside the ceiling is 'killed', not 'timeout'",
		JSON.stringify(d.failedLenses.map((f: any) => [f.cause, f.elapsedSec, f.exitCode])));
	check(!/PR_REVIEW_TIMEOUT=/.test(out),
		"…and is not told to raise a knob that would not have helped", out);
	check(/killed by a signal after \d+s — the ceiling did not fire/.test(out),
		"…and the human line says what actually happened, positively — a negative check alone " +
		"passes on empty output, which is how a deleted branch stays green", out);
	check(/OOM/.test(out), "…and names where to look for the real killer", out);
}
{
	// The default itself. #398 moved the model opus→sonnet and the ceiling
	// 600s→180s in one commit; the measurements live in that PR and in #403,
	// not in this file. What #403 records: at 180s, ppp#378 got 1 of 3 lenses
	// on two consecutive runs. 600 is pinned as a FLOOR, not a guarantee — #403
	// also records one opus lens exceeding 600s, so this stops the default
	// being cost-tuned back down without a measurement, and claims no more.
	const src = fs.readFileSync(PR_REVIEW, "utf8");
	const m = src.match(/LENS_TIMEOUT="\$\{PR_REVIEW_TIMEOUT:-(\d+)\}"/);
	check(m !== null, "the default lens timeout is still a single readable literal", String(m));
	check(m !== null && Number(m[1]) >= 600,
		"the default lens timeout is at least 600s — the value that reviewed 3 of 3 lenses",
		m ? m[1] : "unmatched");
}

console.log(`\n${failures === 0 ? "✅" : "❌"} pr-review gate: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
