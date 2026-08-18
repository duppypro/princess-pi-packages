// Every shipped script in bin/ answers `-h`/`--help` and `--version` (#362).
//
// Why family-wide rather than a fix pinned to one script: `pr-threads` was the
// ONLY member of the pr-* family without `--help`, and it went unnoticed through
// #310 and #319 — the two issues that added the flag everywhere else. A test
// naming `pr-threads` would close that one hole and let the next added script
// repeat it. This asserts the property for the whole shipped set instead, so the
// family stays uniform by construction.
//
// The `--version` half is the same argument from the other direction. #350/#351
// added `--version` across the shipped set and documented it in each script's
// `--help` text — which IS a readable artifact, just one that lives inside the
// source file. The two scripts with no `--help` (`pr-threads`, `git-overview`)
// were therefore the only two where `--version` was undiscoverable. Asserting
// both flags together is what makes "discoverable" mean something.
//
// Scope: executables directly in bin/, excluding generated `*.mjs` build
// artifacts and `*.ts` sources. Discovered from disk, never listed here — a
// hardcoded list is the same defect one level up.
//
// Run with: bun run test shipped-script-help

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(REPO_ROOT, "bin");

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
		.filter((n) => !n.endsWith(".mjs") && !n.endsWith(".ts"))
		.filter((n) => {
			const p = path.join(BIN, n);
			const st = fs.statSync(p);
			return st.isFile() && (st.mode & 0o111) !== 0;
		})
		.sort();
}

function run(script: string, args: string[]) {
	return spawnSync(path.join(BIN, script), args, {
		encoding: "utf8",
		timeout: 15_000,
		// A help/version path must not need repo state, network, or a git identity.
		env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
	});
}

const SCRIPTS = shippedScripts();

console.log(`shipped-script --help/--version contract (#362) — ${SCRIPTS.length} scripts`);

check(SCRIPTS.length >= 10, `discovered a plausible shipped set (${SCRIPTS.length} >= 10)`,
	`found: ${SCRIPTS.join(", ")}`);

for (const s of SCRIPTS) {
	for (const flag of ["-h", "--help"]) {
		const r = run(s, [flag]);
		check(r.status === 0, `${s} ${flag} → exit 0`,
			`got exit ${r.status}; stderr: ${(r.stderr || "").trim().slice(0, 120)}`);
		const text = `${r.stdout || ""}${r.stderr || ""}`;
		// NOT a `usage:` regex. Three formats already ship — `usage:` (pr-open),
		// `USAGE` (repo-gate), and prose (herdr-tab) — so pinning one would invent a
		// convention this repo never adopted and fail two innocent scripts. The
		// property that matters is that help output exists, is substantive, and
		// identifies the script it belongs to.
		const lines = text.split("\n").filter((l) => l.trim() !== "");
		check(lines.length >= 2, `${s} ${flag} → prints substantive help (2+ lines)`,
			`got ${lines.length} non-empty line(s): ${JSON.stringify(text.slice(0, 120))}`);
		check(text.includes(s), `${s} ${flag} → help names the script itself`,
			`output never mentions "${s}": ${JSON.stringify(text.slice(0, 120))}`);
	}

	// --version must be discoverable from --help, not just implemented. This is the
	// countable form of "a flag that exists and is described nowhere".
	const help = run(s, ["--help"]);
	const helpText = `${help.stdout || ""}${help.stderr || ""}`;
	check(helpText.includes("--version"), `${s} --help documents --version`,
		"the flag is implemented but the script's own help never names it");

	const v = run(s, ["--version"]);
	check(v.status === 0, `${s} --version → exit 0`,
		`got exit ${v.status}; stderr: ${(v.stderr || "").trim().slice(0, 120)}`);
	check((v.stdout || "").trim().length > 0, `${s} --version → prints something on stdout`,
		`stdout was empty; stderr: ${(v.stderr || "").trim().slice(0, 120)}`);
}

console.log(`\n${failures === 0 ? "✅" : "❌"} shipped-script help/version: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
