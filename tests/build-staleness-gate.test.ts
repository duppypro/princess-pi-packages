#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @test build-staleness-gate
 * @description The other half of #159: `bin/*.mjs` and
 *   `extensions/lib/harness/builtins.generated.ts` are TRACKED build output
 *   (required so `npm install` from a git URL has something to run without a
 *   build step — see .gitignore). Nothing enforced that a `.ts` commit came
 *   with a rebuild, so a stale `.mjs` could ship silently: `bun link` always
 *   runs the real `.ts` sources through Pi's loader and never notices the
 *   committed `.mjs` is behind.
 *
 *   The check is exactly what the issue proposed: `bun run build && git diff
 *   --exit-code bin/ extensions/lib/harness/builtins.generated.ts`. This
 *   suite runs it as a gate, plus:
 *
 *   - A pre-flight that separates "the committed artifact is stale" from
 *     "the developer has an uncommitted .ts edit not yet built" — the second
 *     is normal WIP, not a defect, and diffing straight through it would
 *     conflate the two AND risk discarding real work on restore.
 *   - A restore, scoped to ONLY the generated files (never bin/*.ts), so a
 *     failing run still leaves the tree exactly as it found it.
 *
 *   Worktree note (verified while writing this suite, see
 *   docs/spec-159-pack-and-smoke.md): this org's worktrees symlink
 *   node_modules into the main clone (~/git-projects/CLAUDE.md). Before a
 *   build.ts fix landed alongside this suite, that made `bun run build`
 *   inside ANY worktree dirty bin/*.mjs on every run — Bun.build stamps
 *   bundled node_modules sources with a boundary comment computed from the
 *   file's REAL (symlink-resolved) path, so the same .ts input produced
 *   `// ../../../princess-pi-packages/node_modules/x.js` from a worktree vs
 *   `// node_modules/x.js` from the main clone. That is a difference in
 *   *where you built*, not in the source — and it would have made this gate
 *   red on every single worktree build, in the one place this org actually
 *   develops. build.ts now canonicalizes those comments before writing the
 *   file; this suite is the check that would have caught the false positive.
 */

import * as assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GENERATED_REGISTRY = "extensions/lib/harness/builtins.generated.ts";

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void) {
	try {
		fn();
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} catch (err) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       ${(err as Error).message.split("\n").join("\n       ")}`);
		failed++;
	}
}

function gitStatusLines(paths: string[]): string[] {
	const out = execFileSync("git", ["status", "--porcelain", "--", ...paths], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	return out.split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

// ---
// Pre-flight: everything a build reads OR writes. If any of it is already
// uncommitted, a fresh build's diff cannot honestly be attributed to
// "committed artifact is stale" — it might just be "source mid-edit, not
// built yet". That is normal WIP, not what this gate exists to catch, and
// restoring afterward would discard it. Report and stop rather than guess.
// ---

const BUILD_INPUTS_AND_OUTPUTS = ["bin/", "extensions/lib/harness/", "build.ts"];
const preExistingDirt = gitStatusLines(BUILD_INPUTS_AND_OUTPUTS);

if (preExistingDirt.length > 0) {
	console.log(
		`${RED}FAIL${RESET} pre-flight: bin/, extensions/lib/harness/, or build.ts already has uncommitted changes`,
	);
	console.log(`       Not a staleness defect — a fresh build's diff can't be trusted while these are`);
	console.log(`       mid-edit, and restoring afterward would discard that work. Commit or stash, then re-run:`);
	for (const l of preExistingDirt) console.log(`       ${l}`);
	console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}1 failed${RESET}`);
	process.exit(1);
}

const generatedMjs = fs
	.readdirSync(path.join(REPO_ROOT, "bin"))
	.filter((f) => f.endsWith(".mjs"))
	.map((f) => path.join("bin", f));
const GENERATED_FILES = [...generatedMjs, GENERATED_REGISTRY];

let exitCode = 0;

try {
	const buildResult = spawnSync("bun", ["run", "build"], { cwd: REPO_ROOT, encoding: "utf8" });

	check("bun run build succeeds", () => {
		assert.strictEqual(
			buildResult.status,
			0,
			`build exited ${buildResult.status}: ${buildResult.stdout}${buildResult.stderr}`,
		);
	});

	if (buildResult.status === 0) {
		const diff = spawnSync("git", ["diff", "--exit-code", "--", ...GENERATED_FILES], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});

		check("fresh build matches committed bin/*.mjs and builtins.generated.ts (no staleness)", () => {
			if (diff.status !== 0) {
				const stat = execFileSync("git", ["diff", "--stat", "--", ...GENERATED_FILES], {
					cwd: REPO_ROOT,
					encoding: "utf8",
				});
				assert.fail(
					`committed artifacts are stale relative to a fresh build. Run \`bun run build\` and commit the ` +
						`result. Changed:\n${stat}`,
				);
			}
		});
	}
} catch (err) {
	console.log(`${RED}Unexpected error:${RESET} ${(err as Error).stack ?? err}`);
	failed++;
	exitCode = 1;
} finally {
	// Restore ONLY the generated files — never bin/*.ts or the harness
	// source dirs, which the pre-flight already proved were clean and which
	// this suite has no business touching either way.
	try { execFileSync("git", ["checkout", "--", ...GENERATED_FILES], { cwd: REPO_ROOT }); } catch {}
	const postDirt = gitStatusLines(GENERATED_FILES);
	if (postDirt.length > 0) {
		console.log(`${RED}FAIL${RESET} post-flight: restore left generated files dirty:`);
		for (const l of postDirt) console.log(`       ${l}`);
		failed++;
	}
}

console.log(`\n${DIM}Known limit: this gate compares a build run on THIS machine, right now, to what is` );
console.log(`committed. It says nothing about whether the commit that introduced a staleness was ever`);
console.log(`built on a different machine or bun version — only that it does not match a build today.${RESET}`);

console.log(`\n${BOLD}Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}${RESET}`);
process.exit(exitCode !== 0 || failed > 0 ? 1 : 0);
