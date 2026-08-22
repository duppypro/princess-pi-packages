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
import { trackSandbox } from "./lib/sandbox";

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
	const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "pr-guard-")));
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
// 4. The two ways a fail-closed guard fails OPEN instead. Both found by
//    macroscopeapp on PR #380, and neither is visible from the happy path.
// ---
console.log("\n— the guard cannot be bypassed by a broken environment");
{
	// (a) A caller reached through a SYMLINK. `$(dirname "$0")` yields the LINK's
	//     directory, which need not hold pr-guard — so the guard was absent for
	//     every symlinked install (bun link) while the real file sat beside the
	//     target. Fails closed, so the symptom was a tool that refused to run at
	//     all rather than one that skipped its safety check; either way the
	//     predicate was not consulted.
	const { bin, cwd } = sandbox(true);
	const linkDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "pr-guard-link-")));
	for (const c of CALLERS) {
		fs.symlinkSync(path.join(bin, c), path.join(linkDir, c));
	}
	for (const c of CALLERS) {
		const r = spawnSync("bash", [path.join(linkDir, c), ...(ARGS[c] ?? [])], {
			cwd, encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" },
		});
		const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
		check(!/cannot source the protected-branch guard/.test(text),
			`${c} via a symlink → finds pr-guard beside the REAL file`, text.slice(0, 200));
	}

	// (b) The predicate itself cannot answer. Callers test it in an `if`, where a
	//     non-zero status reads as "not protected" and `set -e` does not fire — so
	//     a broken grep would have let pr-open run ON MAIN. Simulated with a `grep`
	//     that exits 2 — grep's own "an error occurred" code, as distinct from 1
	//     ("no lines matched"). Stubbing grep rather than emptying PATH, because an
	//     empty PATH also removes the `bash` that runs the probe.
	const stubDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "pr-guard-nogrep-")));
	fs.writeFileSync(path.join(stubDir, "grep"), "#!/usr/bin/env bash\nexit 2\n");
	fs.chmodSync(path.join(stubDir, "grep"), 0o755);
	const r = spawnSync("bash", ["-c",
		`. ${JSON.stringify(path.join(bin, "pr-guard"))}; pr_is_protected main; echo "RETURNED:$?"`],
		{ cwd, encoding: "utf8", env: { ...process.env, PATH: `${stubDir}:/usr/bin:/bin` } });
	const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	check(!/RETURNED:1/.test(text),
		"an unanswerable predicate does NOT return 'not protected'", text.slice(0, 300));
	check(r.status === 3, "an unanswerable predicate exits 3", `got ${r.status}: ${text.slice(0, 200)}`);

	// (c) `readlink -f` unavailable (older macOS) must NOT become "source ./pr-guard".
	//     `dirname ""` prints `.` and exits 0, so the nested spelling laundered a
	//     failed resolution into a relative path and the script sourced a file from
	//     the CALLER'S CWD — arbitrary code execution from a tool whose job is
	//     refusing unsafe operations (macroscopeapp, PR #380, Critical). The probe
	//     puts a hostile pr-guard in the cwd and a failing readlink on PATH: if the
	//     hole is open, the marker file appears.
	{
		const { bin, cwd } = sandbox(true);
		const badPath = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "pr-guard-noreadlink-")));
		fs.writeFileSync(path.join(badPath, "readlink"), "#!/usr/bin/env bash\nexit 1\n");
		fs.chmodSync(path.join(badPath, "readlink"), 0o755);

		const pwned = path.join(cwd, "PWNED");
		fs.writeFileSync(path.join(cwd, "pr-guard"),
			`#!/usr/bin/env bash\ntouch ${JSON.stringify(pwned)}\npr_is_protected() { return 1; }\n`);

		for (const c of CALLERS) {
			const r = spawnSync("bash", [path.join(bin, c), ...(ARGS[c] ?? [])], {
				cwd, encoding: "utf8", env: { ...process.env, PATH: `${badPath}:/usr/bin:/bin` },
			});
			const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
			check(!fs.existsSync(pwned), `${c} does NOT source pr-guard from the cwd`, text.slice(0, 200));
			check(r.status === 3, `${c} → exit 3 when the path cannot be resolved absolutely`,
				`got ${r.status}: ${text.slice(0, 200)}`);
		}
	}
}

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} #222: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
