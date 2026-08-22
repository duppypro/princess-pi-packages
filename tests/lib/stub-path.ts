/**
 * The sandbox-PATH invariant (#395).
 *
 * btw#59 forensics measured 507 live reviewer calls and 8.2M cache-write tokens
 * in one day, billed by test suites: two pr-open sandboxes built a PATH that
 * carried no `claude` stub at all, so `pr-open`'s review gate reached the real
 * reviewer. Those two suites were fixed by adding a stub — but nothing asserted
 * the invariant, so the next suite that builds a sandbox the same way
 * reintroduces it silently, and a per-session cost view cannot see it.
 *
 * This is the assertion the fix was missing: whatever env a suite is about to
 * hand a subprocess, `claude` must resolve INSIDE the sandbox.
 */

import { spawnSync } from "node:child_process";

/**
 * Throw unless `command -v <bin>` under `env` resolves to a path inside `root`.
 *
 * Resolution is done by bash under the exact env the suite will use, not by
 * reading the PATH string: a stub that exists but is not executable, or is
 * shadowed by an earlier entry, is the failure this is here to catch, and only
 * a real lookup sees either.
 */
export function assertStubbedInSandbox(
	env: NodeJS.ProcessEnv,
	root: string,
	bin = "claude",
): void {
	const r = spawnSync("bash", ["-c", `command -v ${bin}`], { env, encoding: "utf8" });
	const resolved = (r.stdout || "").trim();
	if (!resolved) {
		throw new Error(
			`sandbox PATH resolves no '${bin}' at all — a suite that shells out to it ` +
				`would reach whatever the host later installs (#395)`,
		);
	}
	if (!resolved.startsWith(root)) {
		throw new Error(
			`sandbox PATH resolves '${bin}' to ${resolved}, OUTSIDE the sandbox ${root} — ` +
				`this is the shape that billed 507 real reviewer calls in one day (#395)`,
		);
	}
}
