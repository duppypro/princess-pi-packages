// Unit tests for #117/#119 — the OFFLINE listing surface (no `ps`, no network):
//   - buildListSummary: table-only output (no title), empty-state, ~/ paths, SERVED DIRECTORY header
//   - buildNoDirHint: the no-directory agent-prompt suggestion + --list pointer
// Discovery itself (ps aux parsing) needs live processes and is covered by the manual
// Code Approved checks in the spec, not here.
// Run: bun run tests/serve-117-list.test.ts
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import { type ServerInstance } from "../extensions/lib/serve/domain.js";
import { buildListSummary, buildNoDirHint } from "../extensions/lib/serve/tui.js";

let passed = 0;
function ok(name: string, fn: () => void) {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const mk = (port: number, dir: string, url: string): ServerInstance => ({ port, dir, url, title: "T" });

// Built from the RUNNING user's home, not a literal. The behaviour under test is
// "shorten $HOME to ~", so a hardcoded /home/princess-pi asserted it only for one
// username and failed for every other — including CI's /home/runner (#228).
const HOME = os.homedir();
const server1 = mk(8080, path.join(HOME, "git-projects/princess-pi-packages/dist"), "https://foo.princess-pi.dev/");
const server2 = mk(8081, path.join(HOME, "git-projects/rogue-savvy/dist"), "http://127.0.0.1:8081");
const server3 = mk(9090, path.join(HOME, ".local/share/some-served-dir"), "https://other.princess-pi.dev/");
const all = [server1, server2, server3];

console.log("buildListSummary");
ok("empty → user empty-state", () => {
	assert.equal(buildListSummary([]), "No servers are currently running.");
});
ok("single server → table with header", () => {
	const out = buildListSummary([server1]);
	assert.ok(out.includes("SERVED DIRECTORY") && out.includes("PORT") && out.includes("TYPE") && out.includes("URL"));
	assert.ok(out.includes("8080"));
	assert.ok(out.includes("https://foo.princess-pi.dev/"));
});
ok("no title line — table only (#119)", () => {
	const out = buildListSummary([server1]);
	assert.ok(!out.includes("🚀"));
	assert.ok(!out.includes("Servers active"));
	assert.ok(out.includes("SERVED DIRECTORY")); // now ANSI-colored, so check contains not startsWith
});
ok("all servers listed regardless of directory location (#119)", () => {
	const out = buildListSummary(all);
	assert.ok(out.includes("8080"));
	assert.ok(out.includes("8081"));
	assert.ok(out.includes("9090"));
	assert.ok(out.includes("princess-pi-packages/dist"));
	assert.ok(out.includes("rogue-savvy/dist"));
	assert.ok(out.includes(".local/share/some-served-dir"));
});
ok("home directory shortened to ~/ in paths", () => {
	const out = buildListSummary(all);
	assert.ok(out.includes("~/git-projects/princess-pi-packages/dist"));
	assert.ok(out.includes("~/git-projects/rogue-savvy/dist"));
	assert.ok(out.includes("~/.local/share/some-served-dir"));
	assert.ok(!out.includes(`${HOME}/`), `raw home path leaked into the listing:\n${out}`);
});

console.log("buildNoDirHint");
ok("suggests an agent prompt to find a servable dir", () => {
	assert.ok(/find the servable build\/output dir/i.test(buildNoDirHint()));
});
ok("points at --list and starting nothing", () => {
	const hint = buildNoDirHint();
	assert.ok(hint.includes("serve --list"));
	assert.ok(/nothing started/i.test(hint));
});
ok("does NOT mention the old public/docs default", () => {
	assert.ok(!/public\/|docs\//.test(buildNoDirHint()));
});
ok("does NOT mention --list-all (collapsed into --list, #119)", () => {
	assert.ok(!buildNoDirHint().includes("--list-all"));
});

console.log(`\n${passed} passed`);
