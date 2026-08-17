/**
 * @test build-stamp
 *
 * #178: running a CLI from a feature worktree executes the MAIN CLONE's build,
 * silently, so a branch can never exercise its own CLI change by using the CLI.
 * The fix is direction 1+2 from the issue: make the running artifact identify
 * itself. These tests pin the observable half — what `--version` must say — not
 * the build plumbing, which is free to change.
 *
 * The load-bearing assertion is the `path ` line: it is what tells you WHICH
 * build ran without your having to remember a sha.
 */
import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { stampSuffix, formatVersion, STAMP_BASENAME, type BuildStamp } from "../extensions/lib/build-stamp.ts";

let failures = 0;
function ok(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`  PASS  ${name}`);
	} catch (err) {
		failures++;
		console.log(`  FAIL  ${name}`);
		console.log(`        ${(err as Error).message}`);
	}
}

const repoRoot = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

console.log("\n=== stamp suffix shape ===\n");

ok("clean tree → +<sha>", () => {
	const s: BuildStamp = { sha: "8aa37d3", dirty: false, dev: 0, builtFrom: "/x" };
	assert.strictEqual(stampSuffix(s), "+8aa37d3");
});

ok("dirty tree → +<sha>-dev-<n>", () => {
	const s: BuildStamp = { sha: "8aa37d3", dirty: true, dev: 2, builtFrom: "/x" };
	assert.strictEqual(stampSuffix(s), "+8aa37d3-dev-2");
});

ok("first dirty build after a commit is -dev-0, not -dev-1", () => {
	const s: BuildStamp = { sha: "8aa37d3", dirty: true, dev: 0, builtFrom: "/x" };
	assert.strictEqual(stampSuffix(s), "+8aa37d3-dev-0");
});

console.log("\n=== formatVersion ===\n");

ok("always emits a path line, even with no stamp present", () => {
	// A URL that certainly has no sidecar beside it.
	const out = formatVersion("tool", "9.9.9", `file://${path.join(repoRoot, "tests", "no-such-dir", "x.mjs")}`);
	assert.ok(/^path \//m.test(out), `expected a 'path /...' line, got:\n${out}`);
});

ok("unbuilt .ts source is reported as +source, never as a build", () => {
	const out = formatVersion("serve", "1.1.0", `file://${path.join(repoRoot, "extensions", "serve.ts")}`);
	assert.ok(out.includes("serve 1.1.0+source"), `expected '+source', got:\n${out}`);
});

console.log("\n=== built CLIs report their own location (#178) ===\n");

// The regression this issue exists for. Each built CLI must answer --version
// with a semver line AND the resolved path of the artifact that answered.
for (const tool of ["serve", "yada", "wtft"]) {
	const bin = path.join(repoRoot, "bin", `${tool}.mjs`);

	ok(`${tool} --version reports package.json's semver`, () => {
		const r = spawnSync("node", [bin, "--version"], { encoding: "utf8" });
		const out = `${r.stdout}${r.stderr}`;
		assert.ok(out.includes(pkg.version), `expected version ${pkg.version} in:\n${out}`);
	});

	ok(`${tool} --version reports the resolved path of the running artifact`, () => {
		const r = spawnSync("node", [bin, "--version"], { encoding: "utf8" });
		const out = `${r.stdout}${r.stderr}`;
		const line = out.split("\n").find(l => l.startsWith("path "));
		assert.ok(line, `no 'path ' line in:\n${out}`);
		assert.strictEqual(line!.slice(5).trim(), fs.realpathSync(bin), `path line must name THIS artifact:\n${out}`);
	});

	ok(`${tool} --version carries the build stamp when a sidecar exists`, () => {
		const sidecar = path.join(repoRoot, "bin", STAMP_BASENAME);
		if (!fs.existsSync(sidecar)) {
			throw new Error(`no ${sidecar} — build.ts must deposit one (run bun run build)`);
		}
		const stamp = JSON.parse(fs.readFileSync(sidecar, "utf8")) as BuildStamp;
		const r = spawnSync("node", [bin, "--version"], { encoding: "utf8" });
		const out = `${r.stdout}${r.stderr}`;
		assert.ok(out.includes(stampSuffix(stamp)), `expected ${stampSuffix(stamp)} in:\n${out}`);
		assert.ok(out.includes(`built-from ${stamp.builtFrom}`), `expected built-from line in:\n${out}`);
	});
}

console.log("\n=== the sidecar must never dirty the tracked tree ===\n");

ok("bin/build-stamp.json is gitignored", () => {
	const r = spawnSync("git", ["check-ignore", "-q", `bin/${STAMP_BASENAME}`], { cwd: repoRoot });
	assert.strictEqual(r.status, 0, `bin/${STAMP_BASENAME} must be gitignored — a per-build file in a tracked path breaks the staleness gate`);
});

console.log(failures === 0 ? "\nAll build-stamp checks passed.\n" : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
