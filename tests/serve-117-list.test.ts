// Unit tests for #117 — the OFFLINE listing surface (no `ps`, no network):
//   - selectServers: "repo" filters by isInsideRepo, "all" passes through
//   - buildListSummary: header + empty-state + line format, both scopes
//   - buildNoDirHint: the no-directory agent-prompt suggestion + --list-all pointer
// Discovery itself (ps aux parsing) needs live processes and is covered by the manual
// Code Approved checks in the spec, not here.
// Run: npx tsx tests/serve-117-list.test.ts
import * as assert from "node:assert";
import * as path from "node:path";
import { selectServers, type ServerInstance } from "../extensions/lib/serve/domain.js";
import { buildListSummary, buildNoDirHint } from "../extensions/lib/serve/tui.js";

let passed = 0;
function ok(name: string, fn: () => void) {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const CWD = "/home/princess-pi/git-projects/princess-pi-packages";
const mk = (port: number, dir: string, url: string): ServerInstance => ({ port, dir, url, title: "T" });

// A server inside cwd, and one in a sibling repo.
const inRepo = mk(8080, path.join(CWD, "dist"), "https://foo.princess-pi.dev/");
const otherRepo = mk(8081, "/home/princess-pi/git-projects/rogue-savvy/dist", "http://127.0.0.1:8081");
const all = [inRepo, otherRepo];

console.log("selectServers");
ok("scope 'repo' keeps only servers under cwd", () => {
	assert.deepEqual(selectServers(all, CWD, "repo"), [inRepo]);
});
ok("scope 'all' returns every server", () => {
	assert.deepEqual(selectServers(all, CWD, "all"), all);
});
ok("scope 'all' returns a copy, not the original array", () => {
	const out = selectServers(all, CWD, "all");
	assert.notStrictEqual(out, all);
	assert.deepEqual(out, all);
});
ok("defaults to 'repo' scope", () => {
	assert.deepEqual(selectServers(all, CWD), [inRepo]);
});

console.log("buildListSummary");
ok("empty repo scope → repo empty-state", () => {
	assert.equal(buildListSummary([], CWD, "repo"), "No servers are currently running in this repository.");
});
ok("empty all scope → user empty-state", () => {
	assert.equal(buildListSummary([], CWD, "all"), "No servers are currently running for this user.");
});
ok("all-scope with only-other-repo servers is NOT empty", () => {
	// regression guard: --list-all must show servers started in other repos
	const out = buildListSummary([otherRepo], CWD, "all");
	assert.ok(out.includes("Servers active for this user (all repos):"));
	assert.ok(out.includes("127.0.0.1:8081"));
});
ok("repo-scope hides other-repo servers", () => {
	assert.equal(buildListSummary([otherRepo], CWD, "repo"), "No servers are currently running in this repository.");
});
ok("repo header + bullet with url and log path", () => {
	const out = buildListSummary(all, CWD, "repo");
	assert.ok(out.includes("🚀 Servers active in this repository:"));
	assert.ok(out.includes("@ https://foo.princess-pi.dev/"));
	assert.ok(out.includes("(Logs: ~/.pi-certs/logs/port-8080-access.log)"));
	assert.ok(!out.includes("8081")); // otherRepo excluded from repo scope
});

console.log("buildNoDirHint");
ok("suggests an agent prompt to find a servable dir", () => {
	assert.ok(/find the servable build\/output dir/i.test(buildNoDirHint()));
});
ok("points at --list-all and starting nothing", () => {
	const hint = buildNoDirHint();
	assert.ok(hint.includes("serve --list-all"));
	assert.ok(/nothing started/i.test(hint));
});
ok("does NOT mention the old public/docs default", () => {
	assert.ok(!/public\/|docs\//.test(buildNoDirHint()));
});

console.log(`\n${passed} passed`);
