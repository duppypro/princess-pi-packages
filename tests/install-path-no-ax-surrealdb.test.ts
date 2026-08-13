// install-workflow-tools' managed set stays free of ax / SurrealDB (#236)
//
// #236 keeps ax (SurrealDB daemon, layer 3) scoped to this VPS — it must
// never be a requirement on a laptop install, which only ever runs
// install-workflow-tools' copy of bin/*, never a git clone of this repo.
// This asserts that property mechanically instead of by review: every
// script install-workflow-tools installs, plus the installer itself, is
// free of ax/SurrealDB references.
//
// Run with: bun run test install-path-no-ax-surrealdb

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install-workflow-tools");

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

console.log("install path stays ax/SurrealDB-free (#236)");

const AX_PATTERN = /\bax\b|surrealdb|127\.0\.0\.1:8521|ax-db-start/i;

const installerSrc = fs.readFileSync(INSTALLER, "utf8");
check(!AX_PATTERN.test(installerSrc), "install-workflow-tools itself has no ax/SurrealDB reference", installerSrc);

// Anchor the closing paren to its own line, and drop comment lines. A bash
// array may legally carry comments, and a non-greedy match on a bare `\)`
// stops at the FIRST parenthetical it meets — including one inside a comment
// (#263 added `# Itself (#263): ...` above the real closing paren), which then
// reads `# Itself (#263` as a script name and asserts bin/ contains a file by
// that name. Same fragility, same fix, as tests/dev-workflow-spec-consistency.
const arrayMatch = installerSrc.match(/SCRIPTS=\(([\s\S]*?)\n\)/);
check(arrayMatch !== null, "SCRIPTS array found in install-workflow-tools");
const scripts = arrayMatch
	? arrayMatch[1]
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#"))
	: [];
check(scripts.length > 0, "SCRIPTS array is non-empty");

for (const script of scripts) {
	const scriptPath = path.join(REPO_ROOT, "bin", script);
	check(fs.existsSync(scriptPath), `${script} exists in bin/`, scriptPath);
	if (fs.existsSync(scriptPath)) {
		const src = fs.readFileSync(scriptPath, "utf8");
		check(!AX_PATTERN.test(src), `bin/${script} has no ax/SurrealDB reference`, src);
	}
}

console.log(`\n${failures === 0 ? "✅" : "❌"} install path ax/SurrealDB check: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
