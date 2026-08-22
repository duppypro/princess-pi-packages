#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @test config-persistence
 * @description Covers the WRITE side of the config seam (#158).
 *
 *   `tests/config-loader.test.ts` covers resolution (defaults → XDG → CWD →
 *   walk-up). Nothing covered persistence — which is how #158 RC-4a survived:
 *   the Pi extension WRITES `~/.config/princess-pi-packages/wtft.json`, the CLI
 *   READS it, and the test suite drives the CLI. Persisted state crossed from
 *   one surface to the other with no test standing in between.
 *
 *   Three properties are pinned here:
 *
 *   1. The CLI (`bin/wtft.mjs`) is READ-ONLY. This is load-bearing: it is why
 *      running the test suite cannot mutate a developer's saved settings, and
 *      why passing `--cost` in a test is a safe way to state intent rather than
 *      a side effect. If this ever regresses, every `wtft` invocation silently
 *      rewrites the user's config.
 *   2. The Pi extension DOES persist `--tokens`/`--cost`/`--no-emoji`. That is
 *      the documented feature ("Config-persistable" in `--help`), so it should
 *      fail loudly if it stops working, not just when someone notices their
 *      preference no longer sticks.
 *   3. `writeConfig` MERGES into the existing file rather than clobbering it.
 *      A clobber would silently drop every unrelated setting the user has.
 *
 *   Every check runs against a temp `XDG_CONFIG_HOME` set by this file, not by
 *   the runner — the suite must be safe to run standalone, and a test about
 *   config writes is the last place to rely on someone else's isolation.
 */

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void) {
	try {
		fn();
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} catch (err) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       ${(err as Error).message.split("\n")[0]}`);
		failed++;
	}
}

// ---
// Isolation: our own XDG root, restored on the way out.
// ---

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");

const xdgRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-config-persistence-")));
const configDir = path.join(xdgRoot, "princess-pi-packages");
const configPath = path.join(configDir, "wtft.json");
const prevXdg = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = xdgRoot;

/** Seed a config that looks like a real user's — including keys nothing here touches. */
function seedConfig(overrides: Record<string, unknown> = {}): void {
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({
		interval: "6m",
		limit: 10,
		showTicks: true,
		mode: "cumulative",
		timezone: "America/Los_Angeles",
		tokens: true,
		...overrides,
	}, null, 2) + "\n");
}

function readConfigFile(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

console.log("🏃 Running config persistence tests (#158)...\n");

// ---
// 1. The CLI is read-only
// ---

console.log("1. CLI (bin/wtft.mjs) never writes config");

/** Run the CLI and return whether the config file changed byte-for-byte. */
function cliMutatesConfig(args: string[]): boolean {
	const before = fs.readFileSync(configPath);
	try {
		execFileSync(process.execPath, [CLI_BIN, ...args], {
			cwd: REPO_ROOT,
			env: { ...process.env, XDG_CONFIG_HOME: xdgRoot },
			stdio: "ignore",
			timeout: 30_000,
		});
	} catch {
		// Exit status is irrelevant — the question is only whether it wrote.
	}
	return !fs.readFileSync(configPath).equals(before);
}

seedConfig();

check("--cost leaves config byte-identical", () => {
	assert.strictEqual(cliMutatesConfig(["--cost", "-l", "3"]), false);
});

check("--tokens leaves config byte-identical", () => {
	assert.strictEqual(cliMutatesConfig(["--tokens", "-l", "3"]), false);
});

check("--interval/--limit leave config byte-identical", () => {
	assert.strictEqual(cliMutatesConfig(["-i", "3h", "-l", "7"]), false);
});

check("persisted 'tokens: true' survives a --cost CLI run", () => {
	assert.strictEqual(readConfigFile().tokens, true);
});

// ---
// SAFETY GATE — do not run the write tests unless writes are actually isolated.
//
// `loadConfig` honours XDG_CONFIG_HOME; `getConfigPaths` (which `writeConfig`
// targets) does not — it hardcodes `homedir()/.config`. So on any machine with
// XDG_CONFIG_HOME set, wtft READS one file and WRITES another, and a test that
// exercises the write path rewrites the developer's real settings. That is a
// product bug (#158), not a test bug, but this suite is the thing that would
// destroy data if it ran anyway, so it refuses to.
// ---

const { writeConfig, getConfigPaths } = await import("../extensions/lib/config.ts");

const writeTarget = getConfigPaths("wtft").global;
const writesAreIsolated = writeTarget.startsWith(xdgRoot + path.sep);

function checkWrite(label: string, fn: () => void): void {
	if (!writesAreIsolated) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       write path is NOT isolated — refusing to run.`);
		failed++;
		return;
	}
	check(label, fn);
}

if (!writesAreIsolated) {
	console.log(`\n${RED}WRITE PATH NOT ISOLATED${RESET}`);
	console.log(`  XDG_CONFIG_HOME = ${xdgRoot}`);
	console.log(`  writeConfig would target = ${writeTarget}`);
	console.log(`  getConfigPaths() ignores XDG_CONFIG_HOME while loadConfig() honours it.`);
	console.log(`  Every write check below is failed unrun rather than mutating real config.`);
}

// ---
// 2. writeConfig merges rather than clobbers
// ---

console.log("\n2. writeConfig merges into the existing file");

checkWrite("the written key changes", () => {
	seedConfig();
	writeConfig("wtft", { tokens: false });
	assert.strictEqual(readConfigFile().tokens, false);
});

checkWrite("unrelated keys survive a targeted write", () => {
	seedConfig();
	writeConfig("wtft", { tokens: false });
	const c = readConfigFile();
	assert.strictEqual(c.timezone, "America/Los_Angeles");
	assert.strictEqual(c.interval, "6m");
	assert.strictEqual(c.limit, 10);
	assert.strictEqual(c.mode, "cumulative");
	assert.strictEqual(c.showTicks, true);
});

checkWrite("writing to a fresh path creates the file and its directory", () => {
	fs.rmSync(configDir, { recursive: true, force: true });
	writeConfig("wtft", { tokens: true });
	assert.ok(fs.existsSync(configPath));
	assert.strictEqual(readConfigFile().tokens, true);
});

// ---
// 3. The Pi extension DOES persist the mode
// ---

console.log("\n3. Pi extension (/wtft) persists --tokens / --cost / --no-emoji");

// The handler writes config early, then renders. Rendering needs a live Pi TUI,
// which is out of scope here (other suites cover the render path), so the mock
// is permissive and the invocation is wrapped: the assertion is about what
// landed on disk by the time the handler stopped, not how far it got.
function permissiveMock(): any {
	const handler: ProxyHandler<any> = {
		get: (_t, prop) => {
			if (prop === "then") return undefined; // stay await-safe
			return new Proxy(function () { return permissiveMock(); }, handler);
		},
		apply: () => permissiveMock(),
	};
	return new Proxy(function () {}, handler);
}

const registered: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
const mockPi: any = {
	on: () => {},
	registerCommand: (name: string, def: any) => { registered[name] = def; },
	setWidget: () => {},
	removeWidget: () => {},
};

const wtftExtension = (await import("../extensions/wtft.ts")).default;
wtftExtension(mockPi);

check("/wtft command is registered", () => {
	assert.ok(registered.wtft, "expected a 'wtft' command");
});

/** Never invoked unless writesAreIsolated — the handler persists on purpose. */
async function runSlashCommand(args: string): Promise<void> {
	try {
		await registered.wtft.handler(args, permissiveMock());
	} catch {
		// See note above — the write happens before the render.
	}
}

/** checkWrite for an async setup step: skipped wholesale when not isolated. */
async function checkWriteAsync(label: string, setup: () => Promise<void>, fn: () => void): Promise<void> {
	if (!writesAreIsolated) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       write path is NOT isolated — refusing to run.`);
		failed++;
		return;
	}
	await setup();
	check(label, fn);
}

await checkWriteAsync("/wtft --cost persists tokens:false",
	async () => { seedConfig({ tokens: true }); await runSlashCommand("--cost"); },
	() => {
		assert.strictEqual(readConfigFile().tokens, false);
		assert.strictEqual(readConfigFile().timezone, "America/Los_Angeles",
			"unrelated settings must survive");
	});

await checkWriteAsync("/wtft --tokens persists tokens:true",
	async () => { seedConfig({ tokens: false }); await runSlashCommand("--tokens"); },
	() => { assert.strictEqual(readConfigFile().tokens, true); });

await checkWriteAsync("/wtft --no-emoji persists disabledEmoji:true",
	async () => { seedConfig(); await runSlashCommand("--no-emoji"); },
	() => { assert.strictEqual(readConfigFile().disabledEmoji, true); });

await checkWriteAsync("/wtft --emoji persists disabledEmoji:false",
	async () => { seedConfig({ disabledEmoji: true }); await runSlashCommand("--emoji"); },
	() => { assert.strictEqual(readConfigFile().disabledEmoji, false); });

// ---
// The asymmetry this suite exists to pin, stated once more as an assertion:
// the same flag persists through the extension and does not through the CLI.
// ---

console.log("\n4. The CLI/extension asymmetry itself");

await checkWriteAsync("--cost through the extension writes, --tokens through the CLI does not",
	async () => { seedConfig({ tokens: true }); await runSlashCommand("--cost"); },
	() => {
		assert.strictEqual(readConfigFile().tokens, false, "extension should have persisted cost mode");
		assert.strictEqual(cliMutatesConfig(["--tokens", "-l", "3"]), false, "CLI should not have written");
		assert.strictEqual(readConfigFile().tokens, false, "CLI must not have flipped it back");
	});

// ---
// Cleanup
// ---

if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
else process.env.XDG_CONFIG_HOME = prevXdg;
try { fs.rmSync(xdgRoot, { recursive: true, force: true }); } catch {}

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);
