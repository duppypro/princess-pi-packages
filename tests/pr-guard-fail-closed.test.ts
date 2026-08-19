// --- #222: the protected-branch guard fails CLOSED, and shares one predicate ---
//
// `bin/pr-guard` replaced four verbatim copies of
//
//     if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
//
// with one sourced predicate. That trade is only safe if a MISSING pr-guard stops
// the pr-* scripts outright. The tempting alternative — keep an inline
// main/master fallback for when the source fails — silently restores the four
// copies this file deleted, on exactly the hosts where the guard is already
// broken. So: no fallback, exit 3, name `install-workflow-tools`.
//
// This is the half no other suite reaches. tests/shipped-script-help.test.ts and
// tests/pr-cleanup-safety.test.ts drive the scripts with a COMPLETE bin/, which is
// the state where a fail-closed path is invisible by construction.
//
// Hermetic by the same rule that suite learned the hard way (its own header): the
// scripts under test mutate GitHub, so the fixture is a throwaway `git init` with
// NO origin and NO `gh` on PATH. A fall-through dies locally instead of reaching
// a real remote.
//
// Run with: bun run test pr-guard-fail-closed

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const CALLERS = ["pr-open", "pr-merge", "pr-reject", "pr-cleanup"];
/** pr-cleanup requires a branch argument before it reaches any guard. */
const ARGS: Record<string, string[]> = { "pr-cleanup": ["some-branch"] };

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

/** A scratch bin/ holding the callers, with pr-guard present or absent. */
function sandbox(withGuard: boolean): { bin: string; cwd: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-guard-"));
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	for (const c of [...CALLERS, ...(withGuard ? ["pr-guard"] : [])]) {
		fs.copyFileSync(path.join(REPO, "bin", c), path.join(bin, c));
		fs.chmodSync(path.join(bin, c), 0o755);
	}
	const cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
		["commit", "-q", "--allow-empty", "-m", "x"]]) {
		spawnSync("git", a, { cwd, stdio: "ignore" });
	}
	return { bin, cwd };
}

function run(bin: string, cwd: string, script: string) {
	// PATH deliberately WITHOUT this host's ~/bin, and without `gh`: a script that
	// gets past the guard must fail locally, never against a real remote.
	const r = spawnSync("bash", [path.join(bin, script), ...(ARGS[script] ?? [])], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, PATH: "/usr/bin:/bin" },
	});
	return { code: r.status ?? -1, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

console.log("#222: pr-guard fails closed");

// ---
// 1. pr-guard absent → every caller refuses, with the same code and a fix.
// ---
console.log("\n— pr-guard missing: refuse, do not fall back");
{
	const { bin, cwd } = sandbox(false);
	for (const c of CALLERS) {
		const { code, text } = run(bin, cwd, c);
		check(code === 3, `${c} → exit 3`, `got ${code}: ${text.slice(0, 200)}`);
		check(/protected-branch guard/.test(text), `${c} → says what is missing`, text.slice(0, 200));
		check(/install-workflow-tools/.test(text), `${c} → names the command that fixes it`, text.slice(0, 200));
	}
}

// ---
// 2. No caller keeps an inline main/master pair. Source-level, because a
//    behavioural test cannot distinguish "used the shared predicate" from
//    "used its own copy that happens to agree" — and agreeing today is exactly
//    what the four copies did.
// ---
console.log("\n— no caller carries its own copy of the predicate");

const INLINE = /\[\s*"\$BRANCH"\s*=\s*"(main|master)"\s*\]/;
for (const c of CALLERS) {
	const src = fs.readFileSync(path.join(REPO, "bin", c), "utf8");
	check(!INLINE.test(src), `${c} has no inline main/master test`,
		src.split("\n").filter((l) => INLINE.test(l)).join("\n"));
	check(/pr_is_protected/.test(src), `${c} calls pr_is_protected`);
}
// The detector must still see the shape it forbids.
check(INLINE.test('if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then'),
	"the inline-copy detector still catches the original shape");

// ---
// 3. pr-guard present → the guard actually answers, and the callers get past it.
// ---
console.log("\n— pr-guard present: the predicate answers");
{
	const { bin, cwd } = sandbox(true);
	const guard = (args: string[]) =>
		spawnSync("bash", [path.join(bin, "pr-guard"), ...args], { cwd, encoding: "utf8" });

	check(guard(["main"]).status === 0, "pr-guard main → exit 0 (protected)");
	check(guard(["master"]).status === 0, "pr-guard master → exit 0 (protected)");
	check(guard(["42-a-feature"]).status === 1, "pr-guard 42-a-feature → exit 1 (not protected)");
	// The empty case is load-bearing: `git branch --show-current` is empty on a
	// detached HEAD, and every caller has its own, better message for that. This
	// reproduces the old `[ "$BRANCH" = "main" ]` behaviour, which also fell through.
	check(guard([""]).status === 1, "pr-guard '' → exit 1 (detached HEAD is not 'protected')");

	const list = guard(["--list"]);
	check(list.status === 0 && list.stdout.trim().split("\n").join(",") === "main,master",
		"--list → one branch per line, no header", JSON.stringify(list.stdout));

	const json = guard(["--json"]);
	let doc: any = null;
	try { doc = JSON.parse(json.stdout); } catch { /* reported below */ }
	check(doc?.schema === "pr-guard/protected@1", "--json → versioned schema", json.stdout);
	check(Array.isArray(doc?.branches) && doc.branches.join(",") === "main,master",
		"--json → branches array", json.stdout);
}

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} #222: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
