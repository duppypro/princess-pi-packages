// hooks/ must reach ~/.claude/hooks — and drift must fail loudly (#249)
//
// Found 2026-08-12: the deployed copy of block-dangerous-git.sh was 56 lines
// behind the tracked one, missing the ENTIRE `check_gh_command` function. On
// the host it guards, `gh pr merge 5 --squash` exited 0 — the human-only merge
// gate was documentation only. Root cause was deployment, not content: nothing
// in this repo ever copied hooks/ to ~/.claude/hooks.
//
// Three properties are gated here:
//   1. the installer deploys every tracked hook, byte-identical
//   2. `--check` reports drift without writing (exit 1), so drift is loud
//   3. the tracked hook still blocks `gh pr merge` — the gate that was lost
//   4. THIS host's wired hook matches source (fails until you deploy)
//
// Run with: bun run test hooks-deploy-drift

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install-workflow-tools");
const HOOKS_SRC = path.join(REPO_ROOT, "hooks");
const TRACKED_GIT_HOOK = path.join(HOOKS_SRC, "block-dangerous-git.sh");
const TRACKED_MAIN_GUARD = path.join(HOOKS_SRC, "block-edit-on-main.sh");
const TRACKED_PREEDIT_CHECK = path.join(HOOKS_SRC, "preedit-reread-check.py");

/**
 * Every tracked hook — read from disk, so a new hook is covered without
 * editing this test. `.sh` and `.py` only (#237): hooks/ is a flat dir of
 * PreToolUse scripts, not a place for support files like `logs/` (which is
 * runtime output, not source, and never lives in the repo).
 */
const TRACKED_HOOKS = fs
	.readdirSync(HOOKS_SRC)
	.filter((f) => f.endsWith(".sh") || f.endsWith(".py"))
	.sort();

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

function freshHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "hooks-deploy-home-"));
}

function run(home: string, args: string[] = []): { code: number; out: string } {
	try {
		const out = execFileSync("bash", [INSTALLER, ...args], {
			encoding: "utf8",
			env: { ...process.env, HOME: home },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}

console.log("hooks deploy + drift gate (#249)");

// 1. Install deploys every tracked hook, byte-identical and executable.
{
	const home = freshHome();
	const { code, out } = run(home);
	const deployedDir = path.join(home, ".claude", "hooks");

	check(code === 0, "installer exits 0 on a fresh machine", `got ${code}, out:\n${out}`);
	for (const hook of TRACKED_HOOKS) {
		const dest = path.join(deployedDir, hook);
		const exists = fs.existsSync(dest);
		check(exists, `hook '${hook}' deployed to ~/.claude/hooks`, out);
		if (!exists) continue;
		check(
			fs.readFileSync(dest, "utf8") === fs.readFileSync(path.join(HOOKS_SRC, hook), "utf8"),
			`hook '${hook}' deployed byte-identical to source`,
		);
		check((fs.statSync(dest).mode & 0o111) !== 0, `hook '${hook}' deployed executable`);
	}

	// Idempotent: a second run is a no-op that still exits 0.
	const second = run(home);
	check(second.code === 0, "second install run → exit 0 (idempotent)", second.out);
}

// 2. --check on a machine that never deployed: exit 1, names the hook, writes
//    NOTHING. A check that repairs is a check that hides the drift it found.
{
	const home = freshHome();
	const { code, out } = run(home, ["--check"]);

	check(code === 1, "--check with nothing deployed → exit 1", `got ${code}, out:\n${out}`);
	for (const hook of TRACKED_HOOKS) {
		check(out.includes(hook), `--check names the missing hook '${hook}'`, out);
		check(!fs.existsSync(path.join(home, ".claude", "hooks", hook)), `--check deployed nothing for '${hook}'`, out);
	}
	check(!fs.existsSync(path.join(home, "bin", "pr-open")), "--check installed no bin scripts either", out);
}

// 3. --check after a real install: in sync → exit 0.
{
	const home = freshHome();
	run(home);
	const { code, out } = run(home, ["--check"]);
	check(code === 0, "--check after install → exit 0 (in sync)", `got ${code}, out:\n${out}`);
}

// 4. The drift case that started #249: deployed copy edited behind source.
{
	const home = freshHome();
	run(home);
	const dest = path.join(home, ".claude", "hooks", "block-dangerous-git.sh");
	const stale = "#!/usr/bin/env bash\n# pretend this is 56 lines behind\nexit 0\n";
	fs.writeFileSync(dest, stale);

	const { code, out } = run(home, ["--check"]);
	check(code === 1, "--check with a drifted deployed hook → exit 1", `got ${code}, out:\n${out}`);
	check(out.includes("block-dangerous-git.sh"), "--check names the drifted hook", out);
	check(fs.readFileSync(dest, "utf8") === stale, "--check left the drifted file alone (report, not repair)");

	// ...and a plain install run repairs it.
	const repair = run(home);
	check(repair.code === 0, "install run after drift → exit 0", repair.out);
	check(
		fs.readFileSync(dest, "utf8") === fs.readFileSync(TRACKED_GIT_HOOK, "utf8"),
		"install run overwrote the drifted hook with source",
	);
}

// 4b. Content matches, but the deployed hook is no longer executable (PR #255
//     review). settings.json wires the hook by path and Claude Code execs it;
//     a hook it cannot exec gates nothing, so `cmp` alone is the wrong question.
{
	const home = freshHome();
	run(home);
	const dest = path.join(home, ".claude", "hooks", "block-dangerous-git.sh");
	fs.chmodSync(dest, 0o644);

	const { code, out } = run(home, ["--check"]);
	check(code === 1, "--check with a non-executable deployed hook → exit 1", `got ${code}, out:\n${out}`);
	check(out.includes("block-dangerous-git.sh"), "--check names the non-executable hook", out);
	check((fs.statSync(dest).mode & 0o111) === 0, "--check did not silently chmod it back (report, not repair)");

	const repair = run(home);
	check(repair.code === 0, "install run after chmod → exit 0", repair.out);
	check((fs.statSync(dest).mode & 0o111) !== 0, "install run restored the executable bit");
}

// 4c. A managed file missing FROM SOURCE (renamed/deleted in the repo, still
//     listed here). Previously this printed a warning and exited 0 in both
//     modes, so `--check` would report "in sync" for a hook that no longer
//     exists — the drift check signing off on its own blind spot (PR #255
//     review). Driven against a synthetic repo whose hooks/ is empty.
{
	const home = freshHome();
	const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-deploy-repo-"));
	fs.mkdirSync(path.join(fakeRepo, "bin"), { recursive: true });
	fs.mkdirSync(path.join(fakeRepo, "hooks"), { recursive: true }); // present but EMPTY
	// resolve_repo_dir's identity check (#267 finding) requires package.json's
	// "name" field, not just bin/+hooks/ shape.
	fs.writeFileSync(path.join(fakeRepo, "package.json"), JSON.stringify({ name: "princess-pi-packages" }));
	fs.copyFileSync(INSTALLER, path.join(fakeRepo, "bin", "install-workflow-tools"));
	for (const s of ["git-checkpoint", "git-overview", "pr-open", "pr-merge", "pr-reject", "pr-cleanup", "pr-threads"]) {
		fs.copyFileSync(path.join(REPO_ROOT, "bin", s), path.join(fakeRepo, "bin", s));
	}
	const fakeInstaller = path.join(fakeRepo, "bin", "install-workflow-tools");

	const runFake = (args: string[] = []) => {
		try {
			const out = execFileSync("bash", [fakeInstaller, ...args], {
				encoding: "utf8",
				env: { ...process.env, HOME: home },
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { code: 0, out };
		} catch (err: any) {
			return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
		}
	};

	const install = runFake();
	check(install.code !== 0, "install with a hook missing from source → nonzero exit", `got ${install.code}, out:\n${install.out}`);
	for (const hook of TRACKED_HOOKS) {
		check(install.out.includes(hook), `install names '${hook}' missing from source`, install.out);
	}

	const checked = runFake(["--check"]);
	check(checked.code === 1, "--check with a hook missing from source → exit 1, not 'in sync'", `got ${checked.code}, out:\n${checked.out}`);
	check(!/in sync with/i.test(checked.out), "--check does not claim 'In sync' when a source file is gone", checked.out);
}

// 5. The gate itself: the tracked hook must block `gh pr merge`. This is the
//    property the 56-line drift silently removed, asserted directly so it
//    cannot be edited out of the source either (#183/#189/#208 keep the
//    wrapper spellings honest in tests/fixtures/git-guardrails-cases.json).
{
	const payload = JSON.stringify({ tool_input: { command: "gh pr merge 5 --squash" }, cwd: REPO_ROOT });
	const res = spawnSync("bash", [TRACKED_GIT_HOOK], { input: payload, encoding: "utf8" });
	check(res.status === 2, "tracked hook blocks `gh pr merge 5 --squash` (exit 2)", `got ${res.status}: ${res.stdout}${res.stderr}`);
}

// 5b. block-edit-on-main.sh (#237) — the enforcement behind the HARD GATE
// that feature work starts on a branch. Load-bearing load-bearing cases only
// (full matrix is in #237's issue body); a deploy-drift suite's job is
// "does the tracked copy still gate", not re-proving every #237 edge case.
{
	const mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-mainguard-main-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: mainRepo });
	const featRepo = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-mainguard-feat-"));
	execFileSync("git", ["init", "-q", "-b", "42-slug"], { cwd: featRepo });
	const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-mainguard-nonrepo-"));

	const verdict = (filePath: string, cwd: string): number => {
		const payload = JSON.stringify({ tool_input: { file_path: filePath }, cwd });
		return spawnSync("bash", [TRACKED_MAIN_GUARD], { input: payload, encoding: "utf8" }).status ?? -1;
	};

	check(verdict(path.join(mainRepo, "f.txt"), mainRepo) === 2, "block-edit-on-main.sh blocks an edit inside a repo on 'main' (exit 2)");
	check(verdict(path.join(featRepo, "f.txt"), featRepo) === 0, "block-edit-on-main.sh allows an edit inside a repo on a feature branch (exit 0)");

	// Symlink bypass (#267 finding, macroscopeapp on PR #267): a symlink SITS
	// in the feature worktree but its TARGET is physically inside mainRepo.
	// `dirname` on the symlink path alone resolves to featRepo — the bug this
	// closes let `git -C featRepo` report the feature branch and allow an edit
	// that actually lands in mainRepo, on 'main'.
	fs.symlinkSync(path.join(mainRepo, "f.txt"), path.join(featRepo, "symlink-to-main.txt"));
	check(
		verdict(path.join(featRepo, "symlink-to-main.txt"), featRepo) === 2,
		"block-edit-on-main.sh blocks a symlink in a feature worktree whose target is inside a repo on 'main' (exit 2)",
	);
	check(verdict(path.join(nonRepo, "f.txt"), nonRepo) === 0, "block-edit-on-main.sh allows an edit outside any git work tree (exit 0)");
}

// 5c. preedit-reread-check.py (#237) — converts a doomed exact-match edit
// into an actionable retry instead of the native tool's terse "not found".
// Same load-bearing-only scope as 5b.
//
// HOME is sandboxed here (unlike 5b's block-edit-on-main.sh, which touches no
// filesystem state outside its own git repos): preedit-reread-check.py
// self-logs every evaluated decision to ~/.claude/hooks/logs/preedit.jsonl
// (its own header calls this "the FAITHFUL measurement" read at the next ax
// retro). Without a HOME override this suite was appending real records to
// THIS host's live log every run — benign to the host, corrosive to the
// evidence ax reads later. Every other sandbox in this file already sets
// HOME; this was the one leak (post-#258 finding).
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-preedit-"));
	const target = path.join(dir, "file.txt");
	fs.writeFileSync(target, "unique line one\nunique line two\n");
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-preedit-home-"));

	const verdict = (oldString: string): number => {
		const payload = JSON.stringify({ tool_input: { file_path: target, old_string: oldString, new_string: "x" } });
		return spawnSync("python3", [TRACKED_PREEDIT_CHECK], {
			input: payload,
			encoding: "utf8",
			env: { ...process.env, HOME: tmpHome },
		}).status ?? -1;
	};

	check(verdict("does not appear anywhere") === 2, "preedit-reread-check.py blocks an old_string that is absent (exit 2)");
	check(verdict("unique line one") === 0, "preedit-reread-check.py allows an old_string present exactly once (exit 0)");
}

// 6. THIS host. Compare against the hooks `settings.json` actually wires, not
//    an assumed path — a host that wires the repo copy directly is in sync by
//    construction, and a host that wires nothing is disarmed no matter what
//    sits in ~/.claude/hooks. Skipped only where there is no Claude Code
//    config at all (then there is no PreToolUse hook to be behind). Loops
//    every tracked hook (#237 brought block-edit-on-main.sh and
//    preedit-reread-check.py in alongside block-dangerous-git.sh) so a hook
//    that stops being wired, or drifts on just THIS host, is caught the same
//    way the original #249 gap was.
{
	const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
	if (!fs.existsSync(settingsPath)) {
		console.log("  ⏭️  no ~/.claude/settings.json — not a Claude Code host, skipping live drift check");
	} else {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		const commands: string[] = (settings?.hooks?.PreToolUse ?? []).flatMap((entry: any) =>
			(entry?.hooks ?? []).map((h: any) => String(h?.command ?? "")),
		);

		for (const hook of TRACKED_HOOKS) {
			const escaped = hook.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const wired = commands.find((c) => c.includes(hook));
			check(wired !== undefined, `settings.json wires ${hook} as a PreToolUse hook`, `PreToolUse commands: ${commands.join(" | ")}`);

			if (wired) {
				const match = wired.match(new RegExp(`(\\S*${escaped})`));
				const wiredPath = (match?.[1] ?? "").replace(/^~/, os.homedir());
				const live = fs.existsSync(wiredPath) ? fs.readFileSync(wiredPath, "utf8") : null;
				check(
					live === fs.readFileSync(path.join(HOOKS_SRC, hook), "utf8"),
					`the ${hook} this host actually runs matches hooks/${hook}`,
					`${wiredPath} is ${live === null ? "MISSING" : "BEHIND/AHEAD of"} source — the guardrail may be disarmed.\nFix: bin/install-workflow-tools`,
				);
			}
		}
	}
}

console.log(`\n${failures === 0 ? "✅" : "❌"} hooks deploy + drift: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
