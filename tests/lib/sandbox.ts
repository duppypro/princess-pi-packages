/**
 * Sandbox registry (#394).
 *
 * 53 of this repo's test suites build throwaway directories with `mkdtempSync`,
 * across 114 call sites, and almost none removed them: measured on this VPS,
 * /tmp held 135,065 entries, ~6 GB of it from `guardrail-case-*` alone. (#394's
 * own table lists the twelve worst prefixes, which is where the "~20" in an
 * earlier draft of this comment came from — that was the tail, not the scope.) Disk was not tight — the problem is unbounded
 * growth with no owner, and every suite re-deciding the question.
 *
 * `process.on("exit")` AND `afterAll`, because the repo runs suites two ways and
 * neither hook covers both (#435). Standalone (`bun <file>`) is where suites call
 * `process.exit` on failure — a sandbox is most worth removing on the run that
 * failed — and only the exit handler fires there. The runner (`bun test <file>`,
 * what tests/run.ts spawns) never emits `exit`, and only `afterAll` fires there.
 * `sweep` splices the list, so whichever fires first leaves the other nothing to
 * do and running both is harmless.
 *
 * One registry per process, which is one suite — tests/run.ts gives each suite
 * its own process.
 */

import { mkdtempSync, rmSync } from "node:fs";

const SANDBOXES: string[] = [];

function sweep(): void {
	for (const root of SANDBOXES.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// A sandbox that cannot be removed must not change the suite's exit
			// code — the test result is the answer here, not the cleanup.
		}
	}
}

process.on("exit", sweep);
// ...but ONLY on the standalone path. Bun's test runner never emits `exit`
// (measured on bun 1.3.14), and tests/run.ts spawns every suite as
// `bun test <file>` — so from #394 landing until #435, the registry registered
// 114 call sites and removed nothing on the one path the repo actually uses.
// /tmp went from 135,065 entries to 207,748 with the "fix" in place.
//
// `require` rather than a static import: this module is also loaded by suites
// run as `bun <file>`, where "bun:test" does not resolve at all. Registering at
// module load — not lazily from trackSandbox — puts the hook at the importing
// file's top level, so it runs after that file's whole suite rather than after
// whichever describe block happened to create the first sandbox.
try {
	const runner = require("bun:test") as { afterAll?: (fn: () => void) => void };
	runner.afterAll?.(sweep);
} catch {
	// Not under the test runner. The exit and signal handlers above carry it.
}
// `exit` alone does not fire on a signal — Node's default disposition terminates
// the process without emitting it — so Ctrl-C mid-run left every sandbox built
// so far behind. The two pr-open suites carried their own copy of this for that
// reason; it belongs here, where all 53 get it. Re-raise the conventional code
// afterwards so the caller still sees why the run ended.
process.on("SIGINT", () => { sweep(); process.exit(130); });
process.on("SIGTERM", () => { sweep(); process.exit(143); });

/** Register an already-created directory for removal at process exit. */
export function trackSandbox(dir: string): string {
	SANDBOXES.push(dir);
	return dir;
}

/** `mkdtempSync` plus registration — the one-call form. */
export function mkSandbox(prefix: string): string {
	return trackSandbox(mkdtempSync(prefix));
}
