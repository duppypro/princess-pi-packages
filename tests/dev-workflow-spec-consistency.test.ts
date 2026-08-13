// docs/dev-workflow-spec.md consistency checks (#234)
//
// #234 moved workflow facts that used to live only in the untracked
// ~/git-projects/CLAUDE.md into this repo's tracked spec, and thinned this
// repo's CLAUDE.md to gates + commands + pointers. Three properties from the
// issue's Verification section, checked mechanically so drift breaks the
// build instead of accumulating silently:
//
//  1. The spec's Scripts table matches install-workflow-tools' SCRIPTS array
//     (the "Three scripts / seven installed" bug, caught mechanically).
//  2. No substantive line appears verbatim in both CLAUDE.md and the spec —
//     duplication that isn't asserted is duplication that drifts.
//  3. A fresh worktree still has CLAUDE.md present — the property the
//     road-not-taken ("don't gitignore CLAUDE.md") exists to protect.
//
// Run with: bun run test dev-workflow-spec-consistency

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install-workflow-tools");
const SPEC = path.join(REPO_ROOT, "docs", "dev-workflow-spec.md");
const CLAUDE_MD = path.join(REPO_ROOT, "CLAUDE.md");

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

console.log("docs/dev-workflow-spec.md consistency (#234)");

// ---
// 1. Scripts table matches install-workflow-tools' SCRIPTS array
// ---
{
	const installerSrc = fs.readFileSync(INSTALLER, "utf8");
	// Closing paren must be on its own line (`\n)`), not merely the first `)`
	// anywhere after `SCRIPTS=(` — a non-greedy match on a bare `\)` used to
	// stop early at the FIRST parenthetical it met, including one inside an
	// in-array comment (#263 added `# Itself (#263): ...` ahead of the real
	// closing paren). Comment lines are then dropped explicitly, so a script
	// name never picks up a stray `#...` line as a fake "script".
	const arrayMatch = installerSrc.match(/SCRIPTS=\(([\s\S]*?)\n\)/);
	check(arrayMatch !== null, "SCRIPTS array found in install-workflow-tools", installerSrc);
	const scripts = arrayMatch
		? arrayMatch[1]
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0 && !l.startsWith("#"))
		: [];
	check(scripts.length > 0, "SCRIPTS array is non-empty", scripts.join(","));

	const specSrc = fs.readFileSync(SPEC, "utf8");
	for (const script of scripts) {
		// Matches `script`, `script arg`, `script "msg"` — a bare name in backticks,
		// optionally followed by more text before the closing backtick.
		const namedInSpec = new RegExp(`\`${script}[\` ]`).test(specSrc);
		check(
			namedInSpec,
			`spec's Scripts table names '${script}' (from install-workflow-tools' SCRIPTS array)`,
			`looked for a backtick-wrapped '${script}' in ${SPEC}`,
		);
	}
}

// ---
// 2. No substantive line duplicated verbatim between CLAUDE.md and the spec
// ---
{
	const claudeLines = fs
		.readFileSync(CLAUDE_MD, "utf8")
		.split("\n")
		.map((l) => l.trim())
		// Substantive = long enough that a coincidental match is implausible,
		// and not markdown scaffolding (headers, table rules, bare list markers).
		.filter((l) => l.length >= 40 && !l.startsWith("#") && !/^\|[\s-:|]+\|$/.test(l));

	const specLines = new Set(
		fs
			.readFileSync(SPEC, "utf8")
			.split("\n")
			.map((l) => l.trim()),
	);

	const duplicated = claudeLines.filter((l) => specLines.has(l));
	check(
		duplicated.length === 0,
		"no substantive line appears verbatim in both CLAUDE.md and docs/dev-workflow-spec.md",
		duplicated.join("\n"),
	);
}

// ---
// 3. A fresh worktree still has CLAUDE.md present
// ---
{
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "dev-workflow-spec-wt-"));
	fs.rmdirSync(wt); // git worktree add requires the target not exist
	try {
		execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: REPO_ROOT, stdio: "pipe" });
		check(fs.existsSync(path.join(wt, "CLAUDE.md")), "CLAUDE.md is present in a freshly created worktree", wt);
	} finally {
		try {
			execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: REPO_ROOT, stdio: "pipe" });
		} catch {
			fs.rmSync(wt, { recursive: true, force: true });
		}
	}

	// The mechanism behind check 3: CLAUDE.md must be tracked and not gitignored,
	// or no worktree — fresh or otherwise — will ever have it.
	const tracked = execFileSync("git", ["ls-files", "--", "CLAUDE.md"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
	check(tracked === "CLAUDE.md", "CLAUDE.md is a tracked file", `git ls-files returned: '${tracked}'`);
}

console.log(`\n${failures === 0 ? "✅" : "❌"} dev-workflow-spec consistency: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
