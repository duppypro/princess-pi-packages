/**
 * #394 — every suite that builds a sandbox removes it.
 *
 * Measured on this VPS before the fix: /tmp held 135,065 entries, dominated by
 * abandoned test sandboxes — 51,638 `guardrail-case-*` (~6.1 GB at the sampled
 * 124 KB each), 11,270 `pr-threads-coverage-*`, 7,036 `pr-cleanup-*`. Disk was
 * not tight; the defect is unbounded growth that no single suite owns.
 *
 * Fixing the suites without this check just resets the counter: the next suite
 * to call `mkdtempSync` reintroduces it, and nothing goes red.
 *
 * NOT vacuous (#408): the same scanner runs against inline samples below, one
 * registered and one not, so it is proven able to report a violation.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TESTS_DIR = import.meta.dir;

/** Call sites of `mkdtempSync` that are NOT registered for removal. */
function unregisteredCallSites(source: string): number {
	// No `process.on("exit")` exemption. It was a whole-FILE text match, so any
	// exit handler — including one that restores an env var and never touches a
	// directory — exempted every mkdtempSync call in the file (pr-review round 1,
	// reasoning lens, Medium). tests/serve-181-registry.test.ts is exactly that
	// shape: its handler restores REGISTRY_PATH and swept nothing. Every suite
	// that had its own sweep also wraps its calls now, so the strict rule costs
	// nothing and the false-negative class is gone.
	// `mkSandbox` is not counted at all: it contains no `mkdtempSync` call of its
	// own to find, so a file using it has nothing left to register.
	// `*`, not `?`, on the property chain: `nodeFs.promises.mkdtempSync(` has two
	// dots, and with `?` the lookbehind rejected every start position, so a
	// deeper chain matched NOTHING and reported zero unregistered calls — a
	// false negative in the check whose whole job is to have none (pr-review
	// round 3, correctness lens).
	const calls = source.match(/(?<![.\w])(?:[A-Za-z_$][\w$]*\.)*mkdtempSync\(/g) ?? [];
	const registered = source.match(/trackSandbox\((?:[A-Za-z_$][\w$]*\.)*mkdtempSync\(/g) ?? [];
	return calls.length - registered.length;
}

describe("#394 test sandboxes are removed", () => {
	const suites = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.ts"));

	test("the suite list is real, so an empty result cannot mean 'nothing looked'", () => {
		expect(suites.length).toBeGreaterThan(50);
	});

	test("no suite creates a sandbox it never registers for removal", () => {
		const offenders: string[] = [];
		for (const name of suites) {
			// This file's own "mkdtempSync" occurrences are string literals inside
			// the scanner's samples below, not calls. Skipping it by name keeps the
			// samples honest — rewriting them to dodge the scan would make the
			// non-vacuity proof test something other than the real spelling.
			if (name === "sandbox-cleanup-contract.test.ts") continue;
			const source = readFileSync(join(TESTS_DIR, name), "utf8");
			const n = unregisteredCallSites(source);
			if (n > 0) offenders.push(`${name} (${n} unregistered mkdtempSync call(s))`);
		}
		expect(offenders).toEqual([]);
	});

	test("the scanner reports an unregistered call — proof it can fail", () => {
		expect(
			unregisteredCallSites(`const d = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));`),
		).toBe(1);
		expect(
			unregisteredCallSites(`const d = trackSandbox(fs.mkdtempSync(join(tmpdir(), "x-")));`),
		).toBe(0);
		expect(unregisteredCallSites(`const d = mkSandbox(join(tmpdir(), "x-"));`)).toBe(0);
		// An unrelated exit handler no longer exempts anything: this sample's
		// handler removes `root`, which is not what mkdtempSync returned.
		expect(
			unregisteredCallSites(
				`process.on("exit", () => rmSync(root));\nconst d = mkdtempSync("x-");`,
			),
		).toBe(1);
	});
});
