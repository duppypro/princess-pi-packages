/**
 * Sandbox registry (#394).
 *
 * ~20 suites build throwaway directories with `mkdtempSync` and almost none
 * removed them: measured on this VPS, /tmp held 135,065 entries, ~6 GB of it
 * from `guardrail-case-*` alone. Disk was not tight — the problem is unbounded
 * growth with no owner, and every suite re-deciding the question.
 *
 * `process.on("exit")` rather than an `afterAll` or a line at the bottom of the
 * file: most suites here are standalone scripts that call `process.exit` on
 * failure, and a sandbox is most worth removing on the run that failed.
 *
 * One registry per process, which is one suite — tests/run.ts gives each suite
 * its own process.
 */

import { mkdtempSync, rmSync } from "node:fs";

const SANDBOXES: string[] = [];

process.on("exit", () => {
	for (const root of SANDBOXES.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// A sandbox that cannot be removed must not change the suite's exit
			// code — the test result is the answer here, not the cleanup.
		}
	}
});

/** Register an already-created directory for removal at process exit. */
export function trackSandbox(dir: string): string {
	SANDBOXES.push(dir);
	return dir;
}

/** `mkdtempSync` plus registration — the one-call form. */
export function mkSandbox(prefix: string): string {
	return trackSandbox(mkdtempSync(prefix));
}
