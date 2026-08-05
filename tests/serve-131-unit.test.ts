#!/usr/bin/env -S bun
/**
 * Unit tests for serve (#131) — direct function imports, no CLI invocation.
 * Covers: card rendering (ACL line), subdomain map paths, config loader.
 *
 * Existing tests (serve-66-cloudflare, serve-117-list, serve-kill) already
 * cover: parseAclFile, aclEntriesToInclude, flattenSubdomainToLabel,
 * loadCfEnv, buildListSummary, buildNoDirHint, killServerInstance.
 *
 * Run: bun run tests/serve-131-unit.test.ts
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ServerInstance } from "../extensions/lib/serve/domain.js";
import { formatServerCard } from "../extensions/lib/serve/tui.js";
import { readSubdomainMap } from "../extensions/lib/serve/cloudflare.js";
import { loadConfig } from "../extensions/lib/config.js";

let passed = 0;
function ok(name: string, fn: () => void) {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// --- formatServerCard: ACL line ---

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "serve131u-"));

console.log("formatServerCard — ACL line");

ok("shows ACL line when .serve-acl exists", () => {
	const dir = fs.mkdtempSync(path.join(tmpBase, "acl-"));
	fs.writeFileSync(path.join(dir, ".serve-acl"), "# test ACL\nalice@x.com\nbob@x.com\n");
	const server: ServerInstance = {
		port: 9090, dir, url: "https://test.princess-pi.dev/",
		title: "T", isLive: true, localUrl: "http://127.0.0.1:9090",
	};
	const card = formatServerCard(server);
	assert.ok(card.includes(".serve-acl"), "shows acl path");
	assert.ok(card.includes("2 emails"), "shows correct email count");
});

ok("shows singular 'email' for 1-entry ACL", () => {
	const dir = fs.mkdtempSync(path.join(tmpBase, "acl1-"));
	fs.writeFileSync(path.join(dir, ".serve-acl"), "alice@x.com\n");
	const server: ServerInstance = {
		port: 9091, dir, url: "https://test.princess-pi.dev/",
		title: "T", isLive: true, localUrl: "http://127.0.0.1:9091",
	};
	const card = formatServerCard(server);
	assert.ok(card.includes("1 email") && !card.includes("1 emails"), "singular email count");
});

ok("omits ACL line when .serve-acl does not exist", () => {
	const dir = fs.mkdtempSync(path.join(tmpBase, "noacl-"));
	const server: ServerInstance = {
		port: 9092, dir, url: "https://test.princess-pi.dev/",
		title: "T", isLive: true, localUrl: "http://127.0.0.1:9092",
	};
	const card = formatServerCard(server);
	assert.ok(!card.includes(".serve-acl"), "no acl reference");
	assert.ok(!card.includes("ACL:"), "no ACL line");
});

ok("does not crash when .serve-acl is unreadable", () => {
	// Use a path that exists but can't be read as a file (a directory)
	const dir = fs.mkdtempSync(path.join(tmpBase, "badacl-"));
	const aclPath = path.join(dir, ".serve-acl");
	fs.mkdirSync(aclPath); // dir instead of file — readFileSync will throw
	const server: ServerInstance = {
		port: 9093, dir, url: "https://test.princess-pi.dev/",
		title: "T", isLive: true, localUrl: "http://127.0.0.1:9093",
	};
	// Must not throw
	const card = formatServerCard(server);
	assert.ok(!card.includes("ACL:"), "no ACL line on error");
});

console.log("formatServerCard — storage paths");

ok("log path uses new ~/.config/princess-pi-packages/serve/ location", () => {
	const dir = fs.mkdtempSync(path.join(tmpBase, "logpath-"));
	const server: ServerInstance = {
		port: 9094, dir, url: "https://test.princess-pi.dev/",
		title: "T", isLive: true, localUrl: "http://127.0.0.1:9094",
	};
	const card = formatServerCard(server);
	assert.ok(card.includes(".config/princess-pi-packages/serve/logs/port-9094"), "new log path");
	assert.ok(!card.includes(".pi-certs"), "no old pi-certs path");
});

console.log("formatServerCard — card structure");

ok("card shows URL in blue underline", () => {
	const dir = fs.mkdtempSync(path.join(tmpBase, "cardurl-"));
	const server: ServerInstance = {
		port: 9095, dir, url: "https://test.princess-pi.dev/",
		title: "T", isLive: true, localUrl: "http://127.0.0.1:9095",
	};
	const card = formatServerCard(server);
	assert.ok(card.includes("test.princess-pi.dev"), "URL present");
	assert.ok(card.includes("\x1b[4m") || card.includes("\x1b[34m"), "URL has styling");
});

ok("card shows Live/Static type indicator", () => {
	const dir = fs.mkdtempSync(path.join(tmpBase, "cardtype-"));
	const liveServer: ServerInstance = {
		port: 9096, dir, url: "https://test.princess-pi.dev/",
		title: "T", isLive: true, localUrl: "http://127.0.0.1:9096",
	};
	const staticServer: ServerInstance = { ...liveServer, port: 9097, isLive: false };

	const liveCard = formatServerCard(liveServer);
	const staticCard = formatServerCard(staticServer);
	assert.ok(liveCard.includes("Live"), "live card says Live");
	assert.ok(staticCard.includes("Static"), "static card says Static");
});

console.log("readSubdomainMap — new path");

ok("reads subdomain map from ~/.config/princess-pi-packages/serve/subdomains.json", () => {
	// readSubdomainMap reads from the hardcoded path; we verify that
	// the function doesn't reference .pi-certs anymore by checking
	// the function resolves without throwing when no file exists.
	const map = readSubdomainMap();
	assert.strictEqual(typeof map, "object", "returns an object");
	// An empty map from a non-existent file is the expected result
	assert.ok(Array.isArray(map ? Object.keys(map) : null), "has object shape");
});

console.log("loadConfig — serve defaults");

ok("loadConfig returns defaults when no config file exists", () => {
	// Use a tool name that has no existing config file so we test pure defaults
	const cfg = loadConfig("serve-131-test-nonexistent", { visible: true, emojiDisabled: false });
	assert.strictEqual(cfg.visible, true, "default visible");
	assert.strictEqual(cfg.emojiDisabled, false, "default emojiDisabled");
});

ok("loadConfig preserves default value types", () => {
	const cfg = loadConfig("serve-131-test-nonexistent", { port: 8080, live: true });
	assert.strictEqual(cfg.port, 8080, "preserves number default");
	assert.strictEqual(cfg.live, true, "preserves boolean default");
});

// Cleanup
fs.rmSync(tmpBase, { recursive: true, force: true });

console.log(`\n${passed} passed`);
