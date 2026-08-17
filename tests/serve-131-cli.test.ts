#!/usr/bin/env -S bun
/**
 * CLI-level tests for serve (#131) — invokes the built bin/serve.mjs binary
 * and asserts on stdout/stderr/exit code. Does NOT require live server processes.
 *
 * Pattern: spawnSync (matches yada.test.ts), one logical assertion per test,
 * expected values are independent known literals (not recomputed).
 *
 * Run: bun run tests/serve-131-cli.test.ts
 */
import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const serveBin = path.join(process.cwd(), "bin/serve.mjs");

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const r = spawnSync("node", [serveBin, ...args], {
		encoding: "utf-8",
		timeout: 10_000,
	});
	return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function runBare(flags: string): { stdout: string; stderr: string; status: number | null } {
	return run(flags.split(/\s+/).filter(Boolean));
}

let passed = 0;
function ok(name: string, fn: () => void) {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log("=== serve --help / --why / --version ===\n");

ok("--help shows manifest-driven output", () => {
	const { stdout } = run(["--help"]);
	assert.ok(stdout.includes("Secure HTTPS Server Utility"), "tagline");
	assert.ok(stdout.includes("Examples:"), "examples section");
	assert.ok(stdout.includes("Usage:"), "usage section");
	assert.ok(stdout.includes("--pub"), "shows --pub flag");
	assert.ok(stdout.includes("--as"), "shows --as (legacy alias)");
	assert.ok(stdout.includes("--help"), "shows --help flag");
	assert.ok(stdout.includes("--why"), "shows --why flag");
	assert.ok(stdout.includes("--version"), "shows --version flag");
});

ok("--help lists --pub before --as", () => {
	const { stdout } = run(["--help"]);
	const pubIdx = stdout.indexOf("--pub");
	const asIdx = stdout.indexOf("--as");
	assert.ok(pubIdx !== -1 && asIdx !== -1, "both flags present");
	assert.ok(pubIdx < asIdx, "--pub appears before --as in help output");
});

ok("--why shows user scenarios", () => {
	const { stdout } = run(["--why"]);
	assert.ok(stdout.includes("Why run"), "why title");
	assert.ok(stdout.includes("won't help"), "includes anti-use-case");
	assert.ok(stdout.includes("--help"), "points to --help");
});

ok("--version shows name and semver", () => {
	const { stdout } = run(["--version"]);
	assert.ok(stdout.trim().startsWith("serve "), "starts with 'serve '");
	assert.ok(/\d+\.\d+\.\d+/.test(stdout), "contains semver");
});

// #134: the printed version and package.json's version came from two different
// files (a manifest and package.json) that only one of them was ever bumped —
// this diverges deliberately from the "independent known literal" pattern above
// because the whole point is to compare the CLI's live output against the
// actual source of truth, not a hand-copied expectation that could itself drift.
ok("--version matches package.json exactly (#134 — no second source of truth)", () => {
	const { stdout } = run(["--version"]);
	const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
	// #178 added `path` / `built-from` lines beneath, so this pins the FIRST line
	// rather than the whole output. #134's actual claim is unchanged: the semver
	// reported must be package.json's, never a separately-maintained copy.
	const first = stdout.trim().split("\n")[0];
	assert.strictEqual(first, `serve ${pkg.version}`, "serve --version must report package.json's version, not a separately-maintained copy");
});

console.log("\n=== serve --list ===\n");

ok("--list outputs server table (or empty-state)", () => {
	const { stdout } = run(["--list"]);
	// Either shows active servers or the empty-state message
	assert.ok(
		stdout.includes("SERVED DIRECTORY") || stdout.includes("No servers are currently running"),
		"shows table header or empty state"
	);
});

ok("-L is alias for --list", () => {
	const { stdout: list1 } = run(["--list"]);
	const { stdout: list2 } = run(["-L"]);
	assert.strictEqual(list1, list2, "-L produces identical output to --list");
});

console.log("\n=== serve --unpub edge cases ===\n");

ok("--unpub with no value shows usage", () => {
	const { stdout } = run(["--unpub"]);
	assert.ok(
		stdout.includes("Usage:") || stdout.includes("subdomain"),
		"shows usage hint"
	);
});

ok("-U with no value shows usage", () => {
	const { stdout } = run(["-U"]);
	assert.ok(
		stdout.includes("Usage:") || stdout.includes("subdomain"),
		"shows usage hint"
	);
});

console.log("\n=== serve --pub / --as edge cases ===\n");

ok("--pub with no value warns", () => {
	const { stderr } = run(["--pub"]);
	assert.ok(
		stderr.includes("--pub") && stderr.includes("value"),
		"warns about missing value"
	);
});

ok("--as with no value warns", () => {
	const { stderr } = run(["--as"]);
	assert.ok(
		stderr.includes("--pub") && stderr.includes("value"),
		"warns about missing value (uses --pub in message)"
	);
});

ok("--pub with multiple dirs warns (requires exactly one)", () => {
	// Use two non-existent dirs — they'll fail existence check, but first the
	// --pub+multiple-dirs check should trigger.
	const { stderr } = run(["./nonexistent-a", "./nonexistent-b", "--pub", "test"]);
	assert.ok(
		stderr.includes("exactly one") || stderr.includes("ignored"),
		"warns about multiple dirs with --pub"
	);
});

console.log("\n=== serve bare invocation (no-default-dirs, #117) ===\n");

ok("bare serve shows --list + hint, no crash", () => {
	const { stdout, stderr } = run([]);
	const combined = stdout + stderr;
	assert.ok(
		combined.includes("No servers are currently running") ||
		combined.includes("No directory given"),
		"shows list or hint"
	);
	assert.ok(
		!combined.includes("public/") && !combined.includes("docs/"),
		"does not mention old default dirs"
	);
});

console.log("\n=== serve --kill edge cases ===\n");

ok("--kill with no targets is a no-op, not a crash", () => {
	const { stdout, stderr } = run(["--kill"]);
	const combined = stdout + stderr;
	assert.ok(
		combined.includes("No targets") || combined.includes("nothing killed"),
		"reports no targets given"
	);
});

console.log("\n=== serve --show / --hide (Pi-only, CLI prints notice) ===\n");

ok("--show in CLI prints Pi-only notice", () => {
	const { stdout } = run(["--show"]);
	assert.ok(stdout.includes("Pi") || stdout.includes("TUI"), "mentions Pi/TUI");
});

ok("--hide in CLI prints Pi-only notice", () => {
	const { stdout } = run(["--hide"]);
	assert.ok(stdout.includes("Pi") || stdout.includes("TUI"), "mentions Pi/TUI");
});

console.log(`\n${passed} passed`);
