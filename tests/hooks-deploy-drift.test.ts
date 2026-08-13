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

/** Every tracked hook — read from disk, so a new hook is covered without editing this test. */
const TRACKED_HOOKS = fs
	.readdirSync(HOOKS_SRC)
	.filter((f) => f.endsWith(".sh"))
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
	check(out.includes("block-dangerous-git.sh"), "--check names the missing hook", out);
	check(!fs.existsSync(path.join(home, ".claude", "hooks", "block-dangerous-git.sh")), "--check deployed nothing", out);
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

// 5. The gate itself: the tracked hook must block `gh pr merge`. This is the
//    property the 56-line drift silently removed, asserted directly so it
//    cannot be edited out of the source either (#183/#189/#208 keep the
//    wrapper spellings honest in tests/fixtures/git-guardrails-cases.json).
{
	const payload = JSON.stringify({ tool_input: { command: "gh pr merge 5 --squash" }, cwd: REPO_ROOT });
	const res = spawnSync("bash", [TRACKED_GIT_HOOK], { input: payload, encoding: "utf8" });
	check(res.status === 2, "tracked hook blocks `gh pr merge 5 --squash` (exit 2)", `got ${res.status}: ${res.stdout}${res.stderr}`);
}

// 6. THIS host. Compare against the hook `settings.json` actually wires, not an
//    assumed path — a host that wires the repo copy directly is in sync by
//    construction, and a host that wires nothing is disarmed no matter what
//    sits in ~/.claude/hooks. Skipped only where there is no Claude Code
//    config at all (then there is no PreToolUse hook to be behind).
{
	const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
	if (!fs.existsSync(settingsPath)) {
		console.log("  ⏭️  no ~/.claude/settings.json — not a Claude Code host, skipping live drift check");
	} else {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		const commands: string[] = (settings?.hooks?.PreToolUse ?? []).flatMap((entry: any) =>
			(entry?.hooks ?? []).map((h: any) => String(h?.command ?? "")),
		);
		const wired = commands.find((c) => c.includes("block-dangerous-git.sh"));
		check(wired !== undefined, "settings.json wires block-dangerous-git.sh as a PreToolUse hook", `PreToolUse commands: ${commands.join(" | ")}`);

		if (wired) {
			const match = wired.match(/(\S*block-dangerous-git\.sh)/);
			const wiredPath = (match?.[1] ?? "").replace(/^~/, os.homedir());
			const live = fs.existsSync(wiredPath) ? fs.readFileSync(wiredPath, "utf8") : null;
			check(
				live === fs.readFileSync(TRACKED_GIT_HOOK, "utf8"),
				"the hook this host actually runs matches hooks/block-dangerous-git.sh",
				`${wiredPath} is ${live === null ? "MISSING" : "BEHIND/AHEAD of"} source — the merge gate may be disarmed.\nFix: bin/install-workflow-tools`,
			);
		}
	}
}

console.log(`\n${failures === 0 ? "✅" : "❌"} hooks deploy + drift: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
