// --- Typecheck gate (#168) ---
//
// `bun run typecheck` existed as a package script that no suite ever called, so two TS7016
// errors sat on main through a Step-5 "Code and Spec Approved" commit without tripping anything.
// A check nobody runs is not a gate. This suite makes tsc fail the test run.
//
// The negative control below (PROBE) is the load-bearing part. A gate that cannot be shown to go
// red is indistinguishable from no gate — which is exactly the illusion that let #168 happen.
//
// Runner: self-contained script (repo convention — see tests/pr-threads-count.test.ts).
// Run with: bun run test typecheck-gate

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---
// Layout
// ---

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * A deliberately ill-typed file, dropped inside `include: ["bin/**\/*.ts"]` so it is checked by
 * the repo's real config rather than a synthetic stand-in. Removed in a finally block; the name
 * is unmistakably disposable so a killed run leaves an obvious orphan rather than a plausible one.
 */
const PROBE = path.join(REPO_ROOT, "bin", "__typecheck_gate_probe__.ts");
const PROBE_SOURCE = `// Temporary negative control written by tests/typecheck-gate.test.ts (#168).
const probe: number = "not a number";
export default probe;
`;

let failures = 0;

function fail(msg: string): void {
	console.error(`❌ ${msg}`);
	failures++;
}

// ---
// Helpers
// ---

/**
 * Run the declared `bun run typecheck` script — the exact command V1 is stated in terms of.
 *
 * Every tsc invocation in this suite goes through here (#264). V5 used to spawn a hardcoded
 * `<REPO_ROOT>/node_modules/.bin/tsc` instead, and the two resolutions disagree in exactly the
 * place all the work happens: a fresh worktree has no `node_modules/` of its own (git does not
 * copy an ignored directory), and `tsc` is not on PATH either. `bun run` still succeeds there,
 * because binary resolution walks UP the ancestor directories and worktrees have lived inside
 * the clone since #257 — so it finds the main clone's `node_modules/.bin/tsc`. The hardcoded
 * path could not, so V1 passed and V5 failed on a byte-identical tree.
 *
 * Extra args are appended to the declared script, so this cannot drift from what the repo
 * actually ships the way a second, parallel tsc invocation silently did.
 */
function runTypecheck(extraArgs: string[] = []): { status: number; output: string; stdout: string } {
	const r = spawnSync("bun", ["run", "typecheck", ...extraArgs], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 120_000,
	});
	return {
		status: r.status ?? -1,
		output: `${r.stdout || ""}${r.stderr || ""}`,
		stdout: r.stdout || "",
	};
}

// ---
// V1 + V4 — the tree typechecks clean, and a failure would show the compiler's own diagnostics
// ---

const clean = runTypecheck();
if (clean.status !== 0) {
	fail(`V1: \`bun run typecheck\` exited ${clean.status}, expected 0. Compiler said:\n${clean.output}`);
}

// ---
// V5 — allowJs is doing the intended work, and only that
// ---
// cloudflare.js is the sole genuinely-.js module in the program. If it is absent from --listFiles
// the flag is not reaching it; if OTHER .js files from the repo appear, allowJs widened the
// program past what the spec claims and the blast radius needs re-examining.

const listed = runTypecheck(["--listFiles"]);
const files = listed.stdout.split("\n").map(l => l.trim()).filter(Boolean);

// A compiler that never ran produces an empty file list, and an empty file list satisfies every
// "is X absent from the program" test in this section. Reporting that as an allowJs finding is
// what #264 is: the gate named the one thing that was NOT wrong, in a worktree where the real
// fault was that it could not invoke tsc at all. Separate the two states before asserting on
// program contents, so a broken toolchain can never again be reported as a config regression.
if (files.length === 0) {
	fail(
		`V5: tsc produced no file list, so allowJs could not be checked at all — this is a broken ` +
		`toolchain, NOT an allowJs failure. \`bun run typecheck --listFiles\` exited ${listed.status}. ` +
		`Run \`bun install\` and re-run.\nCompiler said:\n${listed.output}`,
	);
} else if (!files.some(f => f.endsWith("extensions/lib/serve/cloudflare.js"))) {
	fail("V5: extensions/lib/serve/cloudflare.js is not in the checked program — allowJs is not reaching it.");
}

const repoJs = files.filter(f => f.startsWith(REPO_ROOT + path.sep) && f.endsWith(".js"));
const unexpectedJs = repoJs.filter(f => !f.endsWith("extensions/lib/serve/cloudflare.js"));
if (unexpectedJs.length > 0) {
	fail(
		`V5: allowJs pulled in repo .js modules beyond cloudflare.js — the program widened past the spec:\n` +
		unexpectedJs.map(f => `     ${path.relative(REPO_ROOT, f)}`).join("\n"),
	);
}

// ---
// V3 — the negative control: a real type error must turn this gate red
// ---

if (fs.existsSync(PROBE)) {
	fail(`V3: ${path.relative(REPO_ROOT, PROBE)} already exists — refusing to overwrite. A previous run was interrupted; delete it and re-run.`);
} else {
	try {
		fs.writeFileSync(PROBE, PROBE_SOURCE, "utf8");
		const probed = runTypecheck();
		if (probed.status === 0) {
			fail("V3: typecheck passed with a deliberately ill-typed file in bin/ — the gate does not actually gate.");
		} else if (!/error TS/.test(probed.output)) {
			fail(`V3/V4: typecheck failed but reported no \`error TS\` diagnostic. Output was:\n${probed.output}`);
		} else if (!probed.output.includes("__typecheck_gate_probe__")) {
			fail(`V3: typecheck failed, but not on the probe — something else in the tree is broken:\n${probed.output}`);
		}
	} finally {
		try {
			fs.unlinkSync(PROBE);
		} catch {
			// Already gone, or never written. Nothing to restore.
		}
	}
}

// A stray probe here would poison every later suite and the packaged artifact alike.
if (fs.existsSync(PROBE)) {
	fail(`V3: failed to remove ${path.relative(REPO_ROOT, PROBE)} — remove it by hand before committing.`);
}

// ---
// Verdict
// ---

if (failures > 0) {
	console.error(`\n${failures} typecheck-gate check(s) failed.`);
	process.exit(1);
}
console.log(`✅ typecheck gate: tree is clean, allowJs reaches cloudflare.js only, and a real type error turns it red.`);
