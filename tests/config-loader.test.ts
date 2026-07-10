// --- Config Loader Tests (#20) ---
//
// Creates temporary directory structures to verify hierarchical resolution,
// deep merge semantics, array replacement, null unsetting, and error resilience.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We import from the TS source directly (test runner resolves via tsx).
// The loader uses process.cwd() — we must chdir into the temp tree for walk-up tests.
const originalCwd = process.cwd();

let testDir: string;
let pass = 0;
let fail = 0;

function ok(label: string, condition: boolean, detail?: string) {
	if (condition) {
		pass++;
		console.log(`  ✅ ${label}`);
	} else {
		fail++;
		console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function setup() {
	testDir = mkdtempSync(join(tmpdir(), "config-loader-test-"));
	process.chdir(testDir);
	// Isolate from real user config (prevents old-path fallback from leaking in)
	process.env.XDG_CONFIG_HOME = join(testDir, ".config");
}

function teardown() {
	process.chdir(originalCwd);
	rmSync(testDir, { recursive: true, force: true });
}

// --- Test 1: Defaults only (no config files exist) ---

setup();
{
	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 10 });
	ok("defaults only — preserves interval", config.interval === "1h");
	ok("defaults only — preserves limit", config.limit === 10);
	ok("defaults only — returns new object", config !== (loadConfig as any).defaultsRef);
}
teardown();

// --- Test 2: XDG global config ---

setup();
{
	const xdgDir = join(testDir, ".config", "princess-pi-packages");
	mkdirSync(xdgDir, { recursive: true });
	writeFileSync(join(xdgDir, "wtft.json"), JSON.stringify({ interval: "2h", width: 120 }));

	// Override XDG_CONFIG_HOME to point to our temp tree
	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(testDir, ".config");

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 10 });

	ok("XDG global — overrides interval", config.interval === "2h");
	ok("XDG global — adds width", config.width === 120);
	ok("XDG global — keeps default limit", config.limit === 10);

	process.env.XDG_CONFIG_HOME = prevXdg;
}
teardown();

// --- Test 3: Project override (CWD) overrides XDG ---

setup();
{
	const xdgDir = join(testDir, ".config", "princess-pi-packages");
	mkdirSync(xdgDir, { recursive: true });
	writeFileSync(join(xdgDir, "wtft.json"), JSON.stringify({ interval: "2h", limit: 10 }));

	const projectDir = join(testDir, ".princess-pi-packages");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "wtft.json"), JSON.stringify({ limit: 5 }));

	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(testDir, ".config");

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 100, width: 80 });

	ok("project override — CWD limit wins over XDG", config.limit === 5);
	ok("project override — XDG interval preserved", config.interval === "2h");
	ok("project override — default width preserved", config.width === 80);

	process.env.XDG_CONFIG_HOME = prevXdg;
}
teardown();

// --- Test 4: Walk-up — nearest project wins ---

setup();
{
	// Deep nested project structure
	const deep = join(testDir, "projects", "sub", "deep");
	mkdirSync(join(deep, ".princess-pi-packages"), { recursive: true });
	writeFileSync(join(deep, ".princess-pi-packages", "wtft.json"), JSON.stringify({ limit: 5 }));

	const mid = join(testDir, "projects");
	mkdirSync(join(mid, ".princess-pi-packages"), { recursive: true });
	writeFileSync(join(mid, ".princess-pi-packages", "wtft.json"), JSON.stringify({ limit: 20, width: 100 }));

	process.chdir(deep);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 100, width: 80 });

	ok("walk-up — CWD limit wins (nearest)", config.limit === 5);
	ok("walk-up — mid width is merged", config.width === 100);
	ok("walk-up — default interval preserved", config.interval === "1h");
}
teardown();

// --- Test 5: null unsets ---

setup();
{
	const mid = join(testDir, "projects");
	mkdirSync(join(mid, ".princess-pi-packages"), { recursive: true });
	writeFileSync(join(mid, ".princess-pi-packages", "wtft.json"), JSON.stringify({ interval: "2h", width: 100 }));

	const deep = join(testDir, "projects", "sub");
	mkdirSync(join(deep, ".princess-pi-packages"), { recursive: true });
	writeFileSync(join(deep, ".princess-pi-packages", "wtft.json"), JSON.stringify({ interval: "1h", width: null }));

	process.chdir(deep);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "m", width: 80, limit: 50 });

	ok("null unsets — CWD interval wins over mid", config.interval === "1h");
	ok("null unsets — width null clears mid, unset in result", !("width" in config));
	ok("null unsets — limit from defaults preserved", config.limit === 50);
}
teardown();

// --- Test 6: Deep merge on nested objects ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-packages"), { recursive: true });
	writeFileSync(join(testDir, ".princess-pi-packages", "wtft.json"), JSON.stringify({
		cost: { input: 3.00 },
		warning: { threshold: 0.30 },
	}));

	const xdgDir = join(testDir, ".config", "princess-pi-packages");
	mkdirSync(xdgDir, { recursive: true });
	writeFileSync(join(xdgDir, "wtft.json"), JSON.stringify({
		cost: { input: 1.00, output: 15.00 },
		warning: { threshold: 0.20, absolute: 5.00 },
	}));

	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(testDir, ".config");

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { cost: { input: 0, output: 0, cacheRead: 0 } }) as any;

	ok("deep merge — CWD cost.input wins", config.cost.input === 3.00);
	ok("deep merge — XDG cost.output preserved", config.cost.output === 15.00);
	ok("deep merge — default cost.cacheRead preserved", config.cost.cacheRead === 0);
	ok("deep merge — CWD warning.threshold wins", config.warning.threshold === 0.30);
	ok("deep merge — XDG warning.absolute preserved", config.warning.absolute === 5.00);

	process.env.XDG_CONFIG_HOME = prevXdg;
}
teardown();

// --- Test 7: Array replacement ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-packages"), { recursive: true });
	writeFileSync(join(testDir, ".princess-pi-packages", "wtft.json"), JSON.stringify({
		ignore: ["dist", ".next"],
	}));

	const xdgDir = join(testDir, ".config", "princess-pi-packages");
	mkdirSync(xdgDir, { recursive: true });
	writeFileSync(join(xdgDir, "wtft.json"), JSON.stringify({
		ignore: ["node_modules", ".git"],
	}));

	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(testDir, ".config");

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", {}) as any;

	ok("array replace — CWD array wins", Array.isArray(config.ignore) && config.ignore.length === 2);
	ok("array replace — contains CWD values", config.ignore?.[0] === "dist" && config.ignore?.[1] === ".next");

	process.env.XDG_CONFIG_HOME = prevXdg;
}
teardown();

// --- Test 8: JSON with comments ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-packages"), { recursive: true });
	writeFileSync(join(testDir, ".princess-pi-packages", "wtft.json"), `{
		// User preference — faster updates
		"interval": "30m",
		/*
		 * Compact display for small screens
		 */
		"width": 60,
		"limit": /* inline comment */ 5
	}`);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 100 });

	ok("comments — interval from commented JSON", config.interval === "30m");
	ok("comments — width from commented JSON", config.width === 60);
	ok("comments — limit from commented JSON", config.limit === 5);
}
teardown();

// --- Test 9: Missing config file — no error ---

setup();
{
	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("nonexistent", { flag: true });
	ok("missing file — returns defaults", config.flag === true);
}
teardown();

// --- Test 10: Malformed JSON — graceful fallback ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-packages"), { recursive: true });
	writeFileSync(join(testDir, ".princess-pi-packages", "wtft.json"), "{ not valid json at all }");

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h" });
	ok("malformed JSON — returns defaults without crashing", config.interval === "1h");
}
teardown();

// --- Test 11: Top-level non-object — graceful fallback ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-packages"), { recursive: true });
	writeFileSync(join(testDir, ".princess-pi-packages", "wtft.json"), `[1, 2, 3]`);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h" });
	ok("array top-level — returns defaults without crashing", config.interval === "1h");
}
teardown();

// --- Summary ---

console.log(`\n──────────────────────────────`);
console.log(`Results: ${pass} passed, ${fail} failed`);

if (fail > 0) process.exit(1);
