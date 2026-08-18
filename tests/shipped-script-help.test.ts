// Every shipped script in bin/ answers `-h`/`--help` and `--version`, refuses an
// unknown flag, and reaches the network on none of those paths (#362).
//
// Why family-wide rather than a fix pinned to one script: `pr-threads` was the
// ONLY member of the pr-* family without `--help`, and it went unnoticed through
// #310 — the issue that added the flag everywhere else. A test naming
// `pr-threads` would close that one hole and let the next added script repeat it.
//
// WHY THIS RUNS IN A SANDBOX — this suite's own incident, worth keeping:
// the first version drove the real scripts in the real repo with live `gh` auth.
// A spec-reconcile auditor probing whether its assertions were vacuous ran
// `pr-reject --zzz-unknown`; `bin/pr-reject` had no `-*` guard, took the unknown
// flag as the close REASON, found the branch's PR and CLOSED it (PR #364, open
// for two seconds). The lesson is not "be careful with probes" — it is that a
// suite exercising argument handling on scripts that mutate GitHub must not be
// able to reach GitHub at all. So:
//
//   - `gh` is stubbed to LOG ITS ARGV AND FAIL. A help/version/usage path must
//     never invoke it, and the log being empty is asserted, not assumed. This
//     is the assertion the incident earns: it fails loudly if a help path ever
//     grows a `gh` call, instead of quietly closing someone's PR.
//   - the repo is a throwaway `git init` with NO `origin`, so a fall-through to
//     push/fetch dies locally rather than touching a real remote.
//   - proving this suite RED is therefore safe, which matters because the
//     unknown-flag assertions below were red by design until the `-*` guards
//     landed.
//
// Assertions are written to be non-vacuous. The earlier version's exit-0 checks
// passed for `git-overview`, `pr-open` and `pr-reject` even with their flag arms
// deleted, because those scripts had no `*)` arm and fell through to exit 0. The
// unknown-flag check is what distinguishes "answers --help" from "ignores every
// argument"; without it the rest of this file proves nothing for those three.
//
// Scope: executables directly in bin/, excluding `*.mjs` and `*.ts`. Discovered
// from disk and CROSS-CHECKED against install-workflow-tools' own SCRIPTS array,
// so drift in either direction fails here by name rather than silently shrinking
// the tested set.
//
// Run with: bun run test shipped-script-help

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(REPO_ROOT, "bin");
const INSTALLER = path.join(BIN, "install-workflow-tools");

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

/** Shipped scripts: executable, directly in bin/, not a generated or source file. */
function shippedScripts(): string[] {
	return fs
		.readdirSync(BIN)
		.filter((n) => !n.startsWith(".") && !n.endsWith(".mjs") && !n.endsWith(".ts"))
		.filter((n) => {
			const p = path.join(BIN, n);
			// lstat, not stat: stat follows symlinks and THROWS on a dangling one,
			// which would crash the suite instead of failing a check.
			const st = fs.lstatSync(p);
			if (st.isSymbolicLink()) return false;
			return st.isFile() && (st.mode & 0o111) !== 0;
		})
		.sort();
}

/** The installer's own SCRIPTS array — the authoritative deploy set. */
function installerScripts(): string[] {
	const src = fs.readFileSync(INSTALLER, "utf8");
	const m = src.match(/^SCRIPTS=\(([\s\S]*?)\)$/m);
	if (!m) return [];
	return m[1]
		.split("\n")
		.map((l) => l.replace(/#.*$/, "").trim())
		.filter(Boolean)
		.flatMap((l) => l.split(/\s+/))
		.map((s) => s.replace(/^["']|["']$/g, ""))
		.filter(Boolean)
		.sort();
}

/**
 * A throwaway git repo with a stub `gh` on PATH that logs argv and FAILS.
 * No `origin` remote: a fall-through to fetch/push dies locally.
 */
function sandbox() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "help-contract-"));
	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	execFileSync("git", ["init", "-q", "-b", "362-sandbox"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env: gitEnv });

	const binDir = path.join(dir, "stubbin");
	fs.mkdirSync(binDir);
	const ghLog = path.join(dir, "gh.log");
	fs.writeFileSync(ghLog, "");
	// Fails loudly. Any script that calls it on a help/version/usage path is a bug.
	fs.writeFileSync(
		path.join(binDir, "gh"),
		`#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\necho "stub gh: refusing (this path must not call gh)" >&2\nexit 1\n`,
		{ mode: 0o755 },
	);
	return { dir, binDir, ghLog };
}

const SB = sandbox();

function run(script: string, args: string[]) {
	return spawnSync(path.join(BIN, script), args, {
		encoding: "utf8",
		timeout: 15_000,
		cwd: SB.dir,
		env: {
			...process.env,
			PATH: `${SB.binDir}${path.delimiter}${process.env.PATH}`,
			// Unset, not empty: `gh` treats an empty GH_TOKEN as absent and falls
			// back to the keyring, and `[[ -v GH_TOKEN ]]` sees empty as PRESENT.
			// The repo's own convention is `env -u`, and this mirrors it.
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
		},
	});
}

function ghCalls(): string {
	return fs.readFileSync(SB.ghLog, "utf8").trim();
}

const SCRIPTS = shippedScripts();
const DECLARED = installerScripts();

console.log(`shipped-script help/version/usage contract (#362) — ${SCRIPTS.length} scripts`);

// The discovered set IS the installer's deploy set. Named-mismatch, not a floor:
// `>= 10` would still pass after deleting pr-threads and adding two unrelated files.
check(
	JSON.stringify(SCRIPTS) === JSON.stringify(DECLARED),
	"discovered bin/ set == install-workflow-tools' SCRIPTS array",
	`discovered: ${SCRIPTS.join(", ")}\ndeclared:   ${DECLARED.join(", ")}`,
);

for (const s of SCRIPTS) {
	for (const flag of ["-h", "--help"]) {
		const r = run(s, [flag]);
		const text = `${r.stdout || ""}${r.stderr || ""}`;
		check(r.status === 0, `${s} ${flag} → exit 0`,
			`got exit ${r.status}; stderr: ${(r.stderr || "").trim().slice(0, 160)}`);
		// stdout only: several scripts emit unrelated warnings on stderr, and
		// counting those toward "substantive help" let an error path satisfy it.
		const lines = (r.stdout || "").split("\n").filter((l) => l.trim() !== "");
		check(lines.length >= 2, `${s} ${flag} → prints substantive help on stdout (2+ lines)`,
			`got ${lines.length} non-empty stdout line(s): ${JSON.stringify((r.stdout || "").slice(0, 160))}`);
		check(text.includes("--version"), `${s} ${flag} → help documents --version`,
			"the flag is implemented but the script's own help never names it");
	}

	const v = run(s, ["--version"]);
	check(v.status === 0, `${s} --version → exit 0`,
		`got exit ${v.status}; stderr: ${(v.stderr || "").trim().slice(0, 160)}`);
	// The exact resolved path, not merely "something" — a weaker check would not
	// notice --version printing an unrelated string.
	check((v.stdout || "").trim() === fs.realpathSync(path.join(BIN, s)),
		`${s} --version → prints its own resolved path`,
		`got ${JSON.stringify((v.stdout || "").trim())}`);

	// The assertion that makes the rest non-vacuous: without it, "answers --help"
	// is indistinguishable from "ignores every argument".
	// Non-zero alone is NOT enough, and assuming it was is how this suite nearly
	// shipped vacuous a second time: in the sandbox `pr-open` exited 3 ("worktree
	// not clean") and `pr-cleanup` exited 4 ("no main worktree") — both failing
	// for reasons that have nothing to do with the flag, while still having no
	// `-*` guard. Require the #224 usage code AND the flag named in the message,
	// so the refusal is provably ABOUT the flag.
	const u = run(s, ["--zzz-unknown-flag"]);
	const utext = `${u.stdout || ""}${u.stderr || ""}`;
	// Two scripts refuse safely but with a different code, and both are recorded
	// here BY NAME rather than by relaxing the check — an allowlist keeps the
	// divergence countable, a loosened assertion hides it. `git-checkpoint` exits
	// 1, which docs/dev-workflow-spec.md documents; `install-workflow-tools`
	// exits 64 (sysexits EX_USAGE). Neither is governed by the #224 pr-* table.
	// Reconciling the three vocabularies is filed separately — see #366.
	const EXIT2_EXEMPT: Record<string, number> = {
		"git-checkpoint": 1,
		"install-workflow-tools": 64,
	};
	const wantExit = EXIT2_EXEMPT[s] ?? 2;
	check(u.status === wantExit, `${s} --zzz-unknown-flag → exit ${wantExit}${wantExit === 2 ? " (usage, per #224)" : " (documented exception, #366)"}`,
		`got exit ${u.status}; a non-${wantExit} non-zero here means it failed for an unrelated ` +
		`reason and the flag still fell through. stderr: ${(u.stderr || "").trim().slice(0, 160)}`);
	check(utext.includes("--zzz-unknown-flag"), `${s} --zzz-unknown-flag → names the flag it refused`,
		`message never quotes the offending argument: ${JSON.stringify(utext.slice(0, 160))}`);
}

// The incident assertion. None of the paths above may reach GitHub.
check(ghCalls() === "", "no help/version/usage path invoked gh",
	`stub gh recorded:\n${ghCalls()}`);

fs.rmSync(SB.dir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "✅" : "❌"} shipped-script help/version/usage: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
