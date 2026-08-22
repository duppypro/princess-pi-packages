/**
 * #435: tests/lib/sandbox.ts must actually REMOVE the sandboxes it registers.
 *
 * tests/sandbox-cleanup-contract.test.ts already checks that every call site
 * registers. It scans source text, so it stayed green while #394 shipped a
 * registry that removed nothing — the exact vacuous-assertion class #408 is
 * about. This suite asserts the behaviour instead: it builds a fixture suite,
 * runs it the way tests/run.ts runs every suite, and looks on disk afterwards.
 *
 * Two execution paths, both real, and neither one covers the other:
 *
 *   runner     `bun test <file>`  — what tests/run.ts spawns for all 97 suites
 *   standalone `bun <file>`       — a suite run by hand, and the path that
 *                                   calls process.exit on failure
 *
 * Measured on bun 1.3.14: the runner NEVER emits `exit`, so the
 * process.on("exit") handler #394 relies on fires only on the standalone path.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkSandbox } from "./lib/sandbox";

/** The bun this was measured against. See "the runner still swallows exit" below. */
const MEASURED_BUN = "1.3.14";

const SANDBOX_LIB = join(import.meta.dir, "lib", "sandbox.ts");

/**
 * A fixture suite that creates one sandbox through the registry and records
 * where it put it. The marker is written OUTSIDE the sandbox, so it survives
 * the removal we are trying to observe.
 */
function writeFixture(dir: string, opts: { runner: boolean }): { file: string; marker: string } {
	const marker = join(dir, "marker.txt");
	const file = join(dir, opts.runner ? "probe.test.ts" : "probe.ts");
	const body = [
		`import { mkSandbox } from ${JSON.stringify(SANDBOX_LIB)};`,
		`import { writeFileSync } from "node:fs";`,
		`import { tmpdir } from "node:os";`,
		`import { join } from "node:path";`,
		`const made = mkSandbox(join(tmpdir(), ${JSON.stringify(`sbxprobe-${opts.runner ? "run" : "std"}-`)}));`,
		`writeFileSync(${JSON.stringify(marker)}, made);`,
		opts.runner
			? `import { test, expect } from "bun:test";\ntest("trivial", () => { expect(1).toBe(1); });`
			: `if (made.length === 0) process.exit(1);`,
	].join("\n");
	writeFileSync(file, body);
	return { file, marker };
}

function runFixture(argv: string[], cwd: string): void {
	const res = spawnSync("bun", argv, { cwd, encoding: "utf8" });
	if (res.status !== 0) throw new Error(`fixture exited ${res.status}: ${res.stderr || res.stdout}`);
}

describe("#435 a registered sandbox is really gone afterwards", () => {
	test("runner path (`bun test <file>`) — the one tests/run.ts uses for every suite", () => {
		const dir = mkSandbox(join(tmpdir(), "sbx435-runner-"));
		const { file, marker } = writeFixture(dir, { runner: true });

		runFixture(["test", file], dir);

		// Non-vacuous: prove the fixture ran and really made a sandbox before
		// asserting it is gone. Without this, a fixture that silently failed to
		// start would satisfy the removal assertion by never creating anything.
		expect(existsSync(marker)).toBe(true);
		const made = readFileSync(marker, "utf8").trim();
		expect(made).toContain("sbxprobe-run-");

		expect(existsSync(made)).toBe(false);
	});

	test("standalone path (`bun <file>`) — where process.on(\"exit\") does fire", () => {
		const dir = mkSandbox(join(tmpdir(), "sbx435-standalone-"));
		const { file, marker } = writeFixture(dir, { runner: false });

		runFixture([file], dir);

		expect(existsSync(marker)).toBe(true);
		const made = readFileSync(marker, "utf8").trim();
		expect(made).toContain("sbxprobe-std-");

		expect(existsSync(made)).toBe(false);
	});
});

describe("#435 the mechanism, pinned", () => {
	/**
	 * Deliberately asserts a bun DEFECT. When this goes red, bun has started
	 * emitting `exit` under its own runner: that is good news, and the fix is to
	 * update MEASURED_BUN and this expectation — NOT to delete the afterAll hook
	 * in tests/lib/sandbox.ts, which still carries the standalone path and every
	 * older bun a contributor may have installed.
	 */
	test(`bun ${MEASURED_BUN}: the runner still swallows process.on("exit")`, () => {
		const dir = mkSandbox(join(tmpdir(), "sbx435-exitprobe-"));
		const fired = join(dir, "fired.txt");
		const file = join(dir, "exit.test.ts");
		writeFileSync(file, [
			`import { test, expect } from "bun:test";`,
			`import { writeFileSync } from "node:fs";`,
			`process.on("exit", () => { writeFileSync(${JSON.stringify(fired)}, "fired"); });`,
			`test("trivial", () => { expect(1).toBe(1); });`,
		].join("\n"));

		runFixture(["test", file], dir);

		expect(existsSync(fired)).toBe(false);
	});
});
