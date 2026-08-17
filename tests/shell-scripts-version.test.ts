// --- shell workflow scripts: --version reports the RUNNING copy's resolved
// path (#178, the shell half) ---
//
// The defect: `install-workflow-tools` deploys these scripts to ~/bin, so
// running one of them bare from a feature worktree executes the
// LAST-INSTALLED copy, never the worktree's own. There was no way to ask
// which copy actually ran. Duppy's decided direction (issue #178, comment
// "Direction decided (2026-08-17)"): `--version` prints the resolved script
// path via `readlink -f "$0"`-equivalent resolution — no comparison step
// needed, just `<script> --version` vs. the path you expected.
//
// These scripts are NOT built (no .mjs step for bin/*, unlike wtft/serve/
// yada), so they get the PATH half only — no commit-hash/semver stamp. The
// whole contract under test is: exit 0, and stdout is exactly the resolved
// absolute path of the file that was actually executed.
//
// Every script is driven as `bash <path> --version` (matching how the other
// suites in this repo invoke these scripts, e.g. tests/git-checkpoint-guard
// .test.ts) so this suite runs identically whether or not the scripts are
// marked executable on the host running it.
//
// Run with: bun run test shell-scripts-version

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN_DIR = path.join(REPO_ROOT, "bin");

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

// Every shell workflow script this repo ships, per bin/'s own table in
// CLAUDE.md and docs/dev-workflow-spec.md — the extensionless files in bin/,
// deployed by install-workflow-tools' own SCRIPTS array. Listed explicitly
// (not globbed) so a future script that forgets --version fails HERE by
// name, rather than silently not being checked.
const SCRIPTS = [
	"git-checkpoint",
	"git-overview",
	"wt-new",
	"herdr-tab",
	"herdr-reap",
	"pr-open",
	"pr-merge",
	"pr-reject",
	"pr-cleanup",
	"pr-threads",
	"repo-gate",
	"install-workflow-tools",
];

function run(scriptPath: string, args: string[], cwd = REPO_ROOT): { code: number; out: string } {
	try {
		const out = execFileSync("bash", [scriptPath, ...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}

console.log("shell workflow scripts: --version reports the resolved running path (#178)");

// --- coverage completeness: every extensionless file in bin/ is covered ----
// The manifest above is a literal list precisely so a new script silently
// missing --version fails by name — but only if the manifest itself cannot
// silently fall behind bin/. Assert the two stay in sync.
{
	const actual = fs
		.readdirSync(BIN_DIR)
		.filter((f) => !f.endsWith(".mjs") && !f.endsWith(".ts"))
		.sort();
	const declared = [...SCRIPTS].sort();
	check(
		JSON.stringify(actual) === JSON.stringify(declared),
		"SCRIPTS manifest matches every extensionless file in bin/",
		`bin/: ${actual.join(", ")}\nSCRIPTS: ${declared.join(", ")}`,
	);
}

// --- the core contract: --version exits 0 and prints the resolved path -----
console.log("\n--version — exit 0, stdout is the resolved absolute path:");
for (const name of SCRIPTS) {
	const scriptPath = path.join(BIN_DIR, name);
	const expected = fs.realpathSync(scriptPath);
	const { code, out } = run(scriptPath, ["--version"]);
	check(code === 0, `${name} --version → exit 0`, `got ${code}, output:\n${out}`);
	check(
		out.trim() === expected,
		`${name} --version → prints its own resolved path, nothing else`,
		`expected: ${expected}\ngot:      ${JSON.stringify(out)}`,
	);
}

// --- the point of the flag: resolves a SYMLINK to its real target, not the
// link's own path. This is the exact ~/bin shape install-workflow-tools
// creates in spirit — a name on PATH that is not the file's own location —
// proving --version actually answers "which copy is this", not just echoing
// argv[0]. ---
console.log("\n--version — resolves a symlink to its real target (the ~/bin shape):");
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shell-version-symlink-"));
	try {
		for (const name of SCRIPTS) {
			const real = path.join(BIN_DIR, name);
			const link = path.join(tmp, `linked-${name}`);
			fs.symlinkSync(real, link);
			const { code, out } = run(link, ["--version"]);
			check(code === 0, `${name} via symlink → exit 0`, `got ${code}, output:\n${out}`);
			check(
				out.trim() === fs.realpathSync(real),
				`${name} via symlink → resolves to the REAL file, not the link path`,
				`link:     ${link}\nexpected: ${fs.realpathSync(real)}\ngot:      ${JSON.stringify(out)}`,
			);
			check(out.trim() !== link, `${name} via symlink → output is not the symlink's own path`, out);
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

// --- --version must not require any precondition the rest of the script
// needs (a git repo, gh, jq, a policy file, an origin remote, exactly N
// positional args). It is the one flag that has to work in a broken or
// half-set-up environment, same as -h/--help already does for every one of
// these scripts. Driven from a bare tmpdir: no git, no gh, no jq, no repo
// checkout, no docs/repo-policy.json — the worst case each script could be
// run in. ---
console.log("\n--version — works with zero preconditions (no git repo, no other args):");
{
	const bareTmp = fs.mkdtempSync(path.join(os.tmpdir(), "shell-version-bare-"));
	try {
		for (const name of SCRIPTS) {
			const scriptPath = path.join(BIN_DIR, name);
			const expected = fs.realpathSync(scriptPath);
			const { code, out } = run(scriptPath, ["--version"], bareTmp);
			check(code === 0, `${name} --version (bare env, no git repo) → exit 0`, `got ${code}, output:\n${out}`);
			check(
				out.trim() === expected,
				`${name} --version (bare env) → still prints its own resolved path`,
				`expected: ${expected}\ngot:      ${JSON.stringify(out)}`,
			);
		}
	} finally {
		fs.rmSync(bareTmp, { recursive: true, force: true });
	}
}

// --- herdr-tab's dual nature (#277): --version must be reachable from its
// one-shot CLI mode, and adding it must not disturb the SOURCED library path
// — `. herdr-tab` still has to define herdr_available()/herdr_tab() with no
// `set -euo pipefail` leaking into the caller's shell, and must not itself
// try to consume "--version" as a positional. ---
console.log("\nherdr-tab dual nature: --version does not disturb the sourced library path:");
{
	const HERDR_TAB = path.join(BIN_DIR, "herdr-tab");
	let code = 0;
	let out = "";
	try {
		out = execFileSync(
			"bash",
			[
				"-c",
				`. ${JSON.stringify(HERDR_TAB)} && type herdr_available >/dev/null 2>&1 && echo LIB_OK && type herdr_tab >/dev/null 2>&1 && echo TAB_OK && echo "pipefail-check:$-"`,
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		code = 0;
	} catch (err: any) {
		code = err?.status ?? -1;
		out = `${err?.stdout || ""}${err?.stderr || ""}`;
	}
	check(code === 0, "sourcing herdr-tab still succeeds after adding --version", `got ${code}, out:\n${out}`);
	check(/LIB_OK/.test(out), "sourcing herdr-tab still defines herdr_available()", out);
	check(/TAB_OK/.test(out), "sourcing herdr-tab still defines herdr_tab()", out);
}

console.log(
	`\n${failures === 0 ? "✅" : "❌"} shell scripts --version: ${checks - failures} of ${checks} checks passed.`,
);
process.exit(failures > 0 ? 1 : 0);
