#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @test pack-and-smoke
 * @description Tests the artifact we actually ship (#159), not the `bun link`
 *   dev symlink. Dev installs resolve straight into the working tree — no
 *   `files` allowlist filtering, no `prepare`, no stock-node constraint. This
 *   suite closes that gap: `npm pack` the repo, install the tarball into a
 *   fresh temp dir with PLAIN node/npm (bun deliberately excluded from PATH),
 *   then run real commands against the installed package.
 *
 *   Two things this suite caught while it was being written, on THIS repo,
 *   both fixed alongside the suite (see docs/spec-159-pack-and-smoke.md):
 *
 *   1. `package.json`'s "files" allowlist did not include `docs/manifests/`.
 *      Every bin (wtft, yada, serve) reads its own `docs/manifests/*.json` at
 *      runtime for --help/--version/--why (the manifest-driven CLI convention,
 *      see CLAUDE.md). A tarball install had NO docs/ at all, so `wtft
 *      --version` threw `ENOENT ... docs/manifests/wtft-cmd.json` and `yada
 *      --version` crashed uncaught. `bun link` never notices because the
 *      symlink resolves into the full working tree, docs/ included.
 *   2. `build.ts`'s bundler output embedded the ABSOLUTE realpath of
 *      node_modules when node_modules is a symlink (as it is in every
 *      worktree — this org's standard dev layout, see
 *      ~/git-projects/CLAUDE.md). That is a worktree-vs-main-clone artifact of
 *      *where you built*, unrelated to packaging, but it means an unpatched
 *      build.ts would make the sibling `build-staleness-gate` suite red on
 *      every worktree build. Fixed in build.ts by canonicalizing the
 *      bundler's node_modules boundary comments before writing the file.
 *
 * @limit KNOWN, STATED HERE AND IN THE OUTPUT: this suite proves only the
 *   REGISTRY/TARBALL install channel (npm pack → npm install → plain node). It
 *   does NOT exercise the git-URL install channel, which runs `prepare` and
 *   therefore needs bun on PATH — an accepted, documented constraint (domain
 *   standard: "bun-on-PATH may be required only for the git-URL install
 *   channel, never for the registry channel"). "This suite is green" is a
 *   narrower claim than "every install channel is green"; do not read it as
 *   the broader one.
 */

import * as assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

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

const KNOWN_LIMIT =
	`${DIM}Known limit: this suite proves the REGISTRY/TARBALL install channel only\n` +
	`(npm pack -> npm install -> plain node, bun excluded from PATH). It does NOT\n` +
	`exercise the git-URL channel, which runs \`prepare\` and needs bun on PATH -\n` +
	`an accepted constraint (bun-on-PATH is permitted for git-URL installs only,\n` +
	`never for the registry channel). Green here != every install channel green.${RESET}`;

console.log(KNOWN_LIMIT);
console.log();

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
	const d = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(d);
	return d;
}

// `wtft -s <path>` (used in the render check below) auto-spawns a background
// wtft-daemon.mjs — from the INSTALLED tarball copy, singleton via a PID file
// in os.tmpdir() (same convention as tests/wtft-cli-e2e-cost-parity.test.ts).
// Without this, the fixture dir gets deleted out from under a still-running
// daemon: it self-exits once it notices, but leaving that to chance is exactly
// the process-litter this repo's other daemon-spawning suites already guard
// against explicitly.
function killLingeringDaemons() {
	try {
		for (const pf of fs.readdirSync(os.tmpdir())) {
			if (!pf.startsWith("wtft-daemon-") || !pf.endsWith(".pid")) continue;
			try {
				const pid = parseInt(fs.readFileSync(path.join(os.tmpdir(), pf), "utf8").trim(), 10);
				if (pid > 0) process.kill(pid, "SIGTERM");
			} catch {}
		}
	} catch {}
}

// ---
// Guard: `npm pack` fires `prepare`, which re-runs `bun build.ts` and writes
// bin/*.mjs + the generated harness registry. That is meant to be a no-op
// against the committed tree, but only IF the tree was clean going in. If a
// developer already has uncommitted changes there (a hand-edit, or WIP on a
// .ts source not yet built), running this suite and then restoring would
// silently DISCARD that work. Detect the pre-existing state and refuse to
// touch it, rather than guessing.
// ---

const REBUILD_TOUCHED = ["bin/", "extensions/lib/harness/"];

function gitStatusLines(paths: string[]): string[] {
	const out = execFileSync("git", ["status", "--porcelain", "--", ...paths], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	return out.split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

const preExistingDirt = gitStatusLines(REBUILD_TOUCHED);

if (preExistingDirt.length > 0) {
	console.log(`${RED}FAIL${RESET} pre-flight: bin/ or extensions/lib/harness/ already has uncommitted changes`);
	console.log(`       This suite's \`npm pack\` step rebuilds those paths and would clobber the`);
	console.log(`       following on restore. Not a packaging defect — commit or stash, then re-run:`);
	for (const l of preExistingDirt) console.log(`       ${l}`);
	failed++;
	console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
	process.exit(1);
}

let exitCode = 0;

try {
	// ---
	// 1. Pack the repo. This runs FROM the repo (needs bun on PATH for
	//    `prepare` — fine, the repo side is allowed to use bun; only the
	//    consumer/install side must be stock node).
	// ---

	const packDir = mkTemp("pp-pack-");
	const packResult = spawnSync("npm", ["pack", "--pack-destination", packDir, "--silent"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});

	check("npm pack succeeds", () => {
		assert.strictEqual(packResult.status, 0, `npm pack exited ${packResult.status}: ${packResult.stderr}`);
	});

	const tgzFiles = fs.readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
	const tgzPath = tgzFiles[0] ? path.join(packDir, tgzFiles[0]) : "";

	check("tarball produced", () => {
		assert.strictEqual(tgzFiles.length, 1, `expected 1 tarball, found ${tgzFiles.length}: ${tgzFiles.join(", ")}`);
	});

	// Restore whatever `prepare` touched. Safe now — the pre-flight check
	// above proved this scope was clean before we started.
	execFileSync("git", ["checkout", "--", ...REBUILD_TOUCHED], { cwd: REPO_ROOT });
	const postPackDirt = gitStatusLines(REBUILD_TOUCHED);
	check("tree restored after npm pack (no leftover dirt in bin/ or harness/)", () => {
		assert.deepStrictEqual(postPackDirt, [], `still dirty: ${postPackDirt.join(", ")}`);
	});

	if (!tgzPath) {
		console.log(`\n${RED}Cannot continue without a tarball.${RESET}`);
		console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed + 1} failed${RESET}`);
		process.exit(1);
	}

	// ---
	// 2. `files` allowlist coverage. Enumerated from the real filesystem, not
	//    hardcoded — a NEW top-level file under either tree must be caught,
	//    not just the files that existed when this suite was written (the
	//    exact #156 near-miss: extensions/lib/harness/ shipped only because
	//    extensions/ was already allowlisted; a new TOP-LEVEL dir would not
	//    have been so lucky).
	// ---

	const tarballEntries = new Set(
		execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" })
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => l.replace(/^package\//, "")),
	);

	function listFiles(dir: string): string[] {
		const out: string[] = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...listFiles(full));
			else out.push(path.relative(REPO_ROOT, full));
		}
		return out;
	}

	const expectedBinMjs = fs
		.readdirSync(path.join(REPO_ROOT, "bin"))
		.filter((f) => f.endsWith(".mjs"))
		.map((f) => path.join("bin", f));

	check(`all ${expectedBinMjs.length} bin/*.mjs files are in the tarball`, () => {
		const missing = expectedBinMjs.filter((f) => !tarballEntries.has(f));
		assert.deepStrictEqual(missing, [], `missing from tarball: ${missing.join(", ")}`);
	});

	const expectedHarness = listFiles(path.join(REPO_ROOT, "extensions", "lib", "harness"));

	check(`all ${expectedHarness.length} extensions/lib/harness/* files are in the tarball`, () => {
		const missing = expectedHarness.filter((f) => !tarballEntries.has(f));
		assert.deepStrictEqual(missing, [], `missing from tarball: ${missing.join(", ")}`);
	});

	check("docs/manifests/ (read by every bin's --help/--version/--why) is in the tarball", () => {
		const expected = fs
			.readdirSync(path.join(REPO_ROOT, "docs", "manifests"))
			.map((f) => path.join("docs", "manifests", f));
		const missing = expected.filter((f) => !tarballEntries.has(f));
		assert.deepStrictEqual(missing, [], `missing from tarball: ${missing.join(", ")}`);
	});

	// ---
	// 3. Install into a fresh temp dir with a PATH that has no bun on it at
	//    all — proving the registry channel needs none. Only `node` and `npm`
	//    are exposed; everything else comes from a minimal system PATH.
	// ---

	// Resolve a REAL, external `node` — never `process.execPath`. This suite
	// is itself run via `bun test <file>` (tests/run.ts), so under bun
	// `process.execPath` points at the bun binary, not node. Symlinking that
	// in would make "plain node install" a lie the whole test is meant to
	// catch elsewhere.
	const stockBin = mkTemp("pp-stockbin-");
	const nodePath = execFileSync("bash", ["-lc", "command -v node"], { encoding: "utf8" }).trim();
	const npmPath = execFileSync("bash", ["-lc", "command -v npm"], { encoding: "utf8" }).trim();

	check("resolved node is a real node binary, not bun (process.execPath under bun would lie here)", () => {
		const v = execFileSync(nodePath, ["--version"], { encoding: "utf8" });
		assert.ok(/^v\d+\.\d+\.\d+/.test(v.trim()), `unexpected \`node --version\` output: ${v}`);
		const realBasename = path.basename(fs.realpathSync(nodePath));
		assert.strictEqual(realBasename, "node", `resolved binary's real target is "${realBasename}", not "node"`);
	});

	fs.symlinkSync(nodePath, path.join(stockBin, "node"));
	fs.symlinkSync(npmPath, path.join(stockBin, "npm"));
	const stockPath = `${stockBin}:/usr/bin:/bin`;
	const stockEnv = { PATH: stockPath, HOME: process.env.HOME ?? "" };

	check("bun is genuinely unreachable on the stock install PATH", () => {
		const r = spawnSync("bash", ["-c", "command -v bun"], { env: stockEnv, encoding: "utf8" });
		assert.notStrictEqual(r.status, 0, `bun resolved on the stock PATH: ${r.stdout}`);
	});

	const consumerDir = mkTemp("pp-consumer-");
	fs.writeFileSync(
		path.join(consumerDir, "package.json"),
		JSON.stringify({ name: "pack-and-smoke-consumer", version: "0.0.0", private: true }),
	);

	const installResult = spawnSync("npm", ["install", tgzPath, "--no-audit", "--no-fund", "--loglevel=warn"], {
		cwd: consumerDir,
		env: stockEnv,
		encoding: "utf8",
	});

	check("npm install (plain node/npm, no bun on PATH) succeeds", () => {
		assert.strictEqual(installResult.status, 0, `npm install exited ${installResult.status}: ${installResult.stderr}`);
	});

	const wtftBin = path.join(consumerDir, "node_modules", ".bin", "wtft");
	const yadaBin = path.join(consumerDir, "node_modules", ".bin", "yada");
	const serveBin = path.join(consumerDir, "node_modules", ".bin", "serve");

	check("wtft, yada, and serve bins are present after install", () => {
		for (const b of [wtftBin, yadaBin, serveBin]) assert.ok(fs.existsSync(b), `missing: ${b}`);
	});

	// ---
	// 4. Real commands against the installed package. `--version` alone would
	//    not have caught the docs/manifests gap for `-s`/render (it doesn't
	//    read the manifest), so both are run.
	// ---

	function runInstalled(bin: string, args: string[], xdgHome: string) {
		return spawnSync(bin, args, {
			env: { ...stockEnv, XDG_CONFIG_HOME: xdgHome },
			encoding: "utf8",
		});
	}

	const versionResult = runInstalled(wtftBin, ["--version"], mkTemp("pp-xdg-"));

	check(`wtft --version exits 0 and reports ${PKG.version}`, () => {
		assert.strictEqual(versionResult.status, 0, `exit ${versionResult.status}: ${versionResult.stdout}${versionResult.stderr}`);
		assert.ok(
			versionResult.stdout.includes(PKG.version),
			`expected version "${PKG.version}" in: ${versionResult.stdout}`,
		);
	});

	const yadaVersionResult = runInstalled(yadaBin, ["--version"], mkTemp("pp-xdg-"));
	check("yada --version exits 0 (also reads docs/manifests/yada-cmd.json)", () => {
		assert.strictEqual(yadaVersionResult.status, 0, `exit ${yadaVersionResult.status}: ${yadaVersionResult.stdout}${yadaVersionResult.stderr}`);
	});

	// A minimal, real Claude-Code-shaped session so the render exercises
	// actual parsing (message usage -> Interaction -> rendered cost), not
	// just CLI arg handling. No existing fixture under tests/fixtures or
	// tests/data is a session transcript (checked: those are nginx access
	// logs and pricing CSVs for other suites), so this is synthesized inline,
	// same as tests/wtft-cli-e2e-cost-parity.test.ts does for its fixture.
	const fixtureDir = mkTemp("pp-fixture-");
	const fixturePath = path.join(fixtureDir, "pack-and-smoke-fixture.jsonl");
	fs.writeFileSync(
		fixturePath,
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				id: "msg_pack_and_smoke",
				model: "claude-sonnet-4-6",
				timestamp: "2026-08-10T12:00:00.000Z",
				usage: { input_tokens: 1000, output_tokens: 100 },
				content: [{ type: "text", text: "smoke" }],
			},
		}) + "\n",
	);

	const renderResult = runInstalled(
		wtftBin,
		["-s", fixturePath, "--cost", "--no-emoji", "--pad", "0"],
		mkTemp("pp-xdg-"),
	);

	check("wtft -s <fixture> renders a cost bar chart (exit 0, no error banner, a $-figure)", () => {
		assert.strictEqual(renderResult.status, 0, `exit ${renderResult.status}: ${renderResult.stdout}${renderResult.stderr}`);
		assert.ok(!/❌|System Error/.test(renderResult.stdout), `error banner in output:\n${renderResult.stdout}`);
		assert.ok(/\$\d/.test(renderResult.stdout), `no rendered dollar figure in output:\n${renderResult.stdout}`);
	});
} catch (err) {
	console.log(`${RED}Unexpected error:${RESET} ${(err as Error).stack ?? err}`);
	failed++;
	exitCode = 1;
} finally {
	killLingeringDaemons();
	for (const d of tempDirs) {
		try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
	}
	// Belt-and-braces: whatever branch we took, bin/ and the harness registry
	// must not be left dirty relative to what git already has recorded.
	const finalDirt = gitStatusLines(REBUILD_TOUCHED);
	if (finalDirt.length > 0) {
		console.log(`${RED}FAIL${RESET} post-flight: bin/ or extensions/lib/harness/ left dirty, restoring`);
		try { execFileSync("git", ["checkout", "--", ...REBUILD_TOUCHED], { cwd: REPO_ROOT }); } catch {}
		failed++;
	}
}

console.log();
console.log(KNOWN_LIMIT);
console.log(`\n${BOLD}Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}${RESET}`);
process.exit(exitCode !== 0 || failed > 0 ? 1 : 0);
