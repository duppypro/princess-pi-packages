/**
 * Guard against #326: an unawaited async main() in a standalone suite
 * truncates into a green no-op under `bun test <file>`.
 *
 * The mechanism (see tests/run.ts:8-21 for why `bun test <file>` is used at
 * all): a suite with zero test()/describe() registrations has its process
 * torn down by bun as soon as the module's own SYNCHRONOUS evaluation
 * finishes. It does not drain a real macrotask (setTimeout, I/O, a spawned
 * child) sitting inside an un-awaited async call. Reproduced directly for
 * this issue: a fixture with `main();` (bare) printed its pre-async banner,
 * then never reached a sentinel print placed after
 * `await new Promise(r => setTimeout(r, 300))` inside main() — and still
 * exited 0. Changing the same fixture to `await main();` made the sentinel
 * print and the run take the full ~300ms. #325's divergence suite hit this
 * for real (a daemon-reaping `finally` block that could never run) and fixed
 * it with `await main().catch(...)` — see the comment at the bottom of
 * tests/wtft-tree-navigation-cost-divergence.test.ts.
 *
 * Why this guard is a static source scan, not a runtime "did it produce
 * output" check: `bun test <file>` writes its own banner and
 * "N pass / N fail / Ran N tests" summary UNCONDITIONALLY, even when the
 * suite body truncated before printing anything of its own — verified
 * directly against the reproduction fixture above. "No output" is never true,
 * so it cannot distinguish a truncated run from a completed one. A suite's
 * own console.log lines can't be trusted either: sync prints before the
 * truncation point still show up (both #326-named suites already do this,
 * which is exactly why the defect was latent — "their work evidently
 * completes within synchronous evaluation" per the issue). The one thing
 * that's checkable without running anything is the source itself: every
 * suite that defines `async function main` must drive it with a top-level
 * `await`, full stop. That's deterministic and catches the defect the moment
 * it's written, in this file or any future one — no timing sensitivity, no
 * dependence on whether today's main() happens to avoid a macrotask.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

const TESTS_DIR = import.meta.dirname;
const SELF = "unawaited-main-guard.test.ts";

const suites = fs.readdirSync(TESTS_DIR)
	.filter(f => f.endsWith(".test.ts") && f !== SELF)
	.sort();

/** Suites that declare `async function main(...)` at all — the ones this rule governs. */
const mainDriven = suites.filter(f =>
	/^\s*async function main\s*\(/m.test(fs.readFileSync(path.join(TESTS_DIR, f), "utf8")));

describe("every async main() suite is driven by a top-level await (#326)", () => {
	it("finds the known main()-driven suites at all (guards against a scan that matches nothing)", () => {
		assert.ok(mainDriven.length >= 3,
			`expected to find at least the 3 known main()-driven suites, found ${mainDriven.length}: ${mainDriven.join(", ")}`);
	});

	for (const f of mainDriven) {
		const src = fs.readFileSync(path.join(TESTS_DIR, f), "utf8");

		// `await main();` or `await main().catch(...)` — anything that starts
		// the statement with `await main(`.
		const awaited = /^\s*await\s+main\s*\(/m.test(src);

		// The exact anti-pattern from #326: a bare, fire-and-forget call.
		const bareCall = /^\s*main\(\)\s*;/m.test(src);

		it(`${f} — main() is driven by a top-level await`, () => {
			assert.ok(awaited,
				`${f} defines async function main() but never drives it with a top-level \`await\`. ` +
				`Under \`bun test <file>\` (how tests/run.ts invokes every suite), a suite with zero ` +
				`test()/describe() registrations tears down as soon as synchronous evaluation finishes — ` +
				`an unawaited main() can truncate mid-flight and still exit 0 (#326). ` +
				`Use \`await main();\`, or \`await main().catch(err => { ... process.exit(1); });\` if main() ` +
				`doesn't already handle its own failures.`);
		});

		it(`${f} — does not also call main() a second, unawaited time`, () => {
			assert.ok(!bareCall,
				`${f} has a bare, unawaited \`main();\` call alongside its awaited call — remove the bare one, ` +
				`it races the awaited call and defeats the point of awaiting it.`);
		});
	}
});
