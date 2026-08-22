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
import { trackSandbox } from "./lib/sandbox";

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
const installerSrc = fs.readFileSync(INSTALLER, "utf8");
// Closing paren must be on its own line (`\n)`), not merely the first `)`
// anywhere after `SCRIPTS=(` — a non-greedy match on a bare `\)` used to stop
// early at the FIRST parenthetical it met, including one inside an in-array
// comment (#263 added `# Itself (#263): ...` ahead of the real closing paren).
// Comment lines are then dropped explicitly, so a script name never picks up
// a stray `#...` line as a fake "script". Same fix as
// tests/install-path-no-ax-surrealdb.test.ts (#263) — kept in sync by hand,
// since the two files don't share a helper.
const arrayMatch = installerSrc.match(/SCRIPTS=\(([\s\S]*?)\n\)/);
check(arrayMatch !== null, "SCRIPTS array found in install-workflow-tools", installerSrc);
const scripts = arrayMatch
	? arrayMatch[1]
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#"))
	: [];
check(scripts.length > 0, "SCRIPTS array is non-empty", scripts.join(","));

// ---
// 1. Scripts table matches install-workflow-tools' SCRIPTS array
// ---
{
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
// 1b. CLAUDE.md's "Shipped scripts" table matches the same SCRIPTS array
// (#264 — this edge was untested, which is how wt-new drifted out of
// CLAUDE.md silently: the installer and the spec agreed, and nothing checked
// the third corner of the triangle. CLAUDE.md is loaded into every session's
// context, so a tool missing from its table is invisible where agents
// actually look, even when the spec documents it correctly.)
// ---
{
	const claudeMdSrc = fs.readFileSync(CLAUDE_MD, "utf8");
	for (const script of scripts) {
		const namedInClaudeMd = new RegExp(`\`${script}[\` ]`).test(claudeMdSrc);
		check(
			namedInClaudeMd,
			`CLAUDE.md's Shipped scripts table names '${script}' (from install-workflow-tools' SCRIPTS array)`,
			`looked for a backtick-wrapped '${script}' in ${CLAUDE_MD}`,
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
	const wt = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "dev-workflow-spec-wt-")));
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

// --- markdown tables: every row in a table has the table's cell count ---------
//
// A `|` written as prose inside a cell is parsed as a DELIMITER, silently
// splitting that row into extra cells. It renders as garbage on GitHub and is
// invisible in the diff, in the editor, and to anyone reading the raw file —
// which is how `CLAUDE.md`'s pr-threads row shipped with `issuer | reviewer |
// untrusted` in it and rendered as four unlabeled cells (#362, caught by review
// rather than by us). The fix is `\\|`; this is the check that counts it.
{
	const mdFiles = [
		{ label: "CLAUDE.md", file: CLAUDE_MD },
		{ label: "docs/dev-workflow-spec.md", file: SPEC },
	];
	for (const { label, file } of mdFiles) {
		const lines = fs.readFileSync(file, "utf8").split("\n");
		// Count only UNESCAPED pipes: strip \| first, then count what remains.
		const cells = (line: string): number => (line.replace(/\\\|/g, "").match(/\|/g) || []).length;
		let inFence = false;
		let expected = 0;
		let headerLine = 0;
		const bad: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
			if (inFence) continue;
			const isRow = /^\s*\|.*\|\s*$/.test(line);
			if (!isRow) { expected = 0; continue; }
			// A delimiter row (|---|---|) sets the table's shape.
			if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) { expected = cells(line); headerLine = i + 1; continue; }
			if (expected === 0) continue; // header row, before the delimiter
			if (cells(line) !== expected) {
				bad.push(`${label}:${i + 1} has ${cells(line)} unescaped pipes, table (delimiter at :${headerLine}) expects ${expected}`);
			}
		}
		check(bad.length === 0, `${label}: every table row matches its table's cell count`,
			bad.join("\n") + (bad.length ? "\n(a literal | inside a cell must be written \\|)" : ""));
	}
}

console.log(`\n${failures === 0 ? "✅" : "❌"} dev-workflow-spec consistency: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
