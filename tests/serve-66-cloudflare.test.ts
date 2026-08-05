// Unit tests for Phase 6B (#66) cloudflare.js — the OFFLINE surface only (no network):
//   - flattenSubdomainToLabel: slug → valid DNS label rules
//   - loadCfEnv: parses cf.env; missing file / missing keys → clear error
//   - parseAclFile: reads + validates .serve-acl emails; invalid/empty → throw
// The live edge path (ingress upsert, Access app, reserved-label rejection against the real
// zone, reap) is the VPS+laptop test in the runbook 6B Code Approved list — not unit-testable
// without a Cloudflare account, so it is intentionally out of scope here.
// Run: bun run tests/serve-66-cloudflare.test.ts
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { flattenSubdomainToLabel, loadCfEnv, parseAclFile, aclEntriesToInclude } from "../extensions/lib/serve/cloudflare.js";

let passed = 0;
function ok(name: string, fn: () => void) {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log("flattenSubdomainToLabel");
ok("lowercases and keeps valid chars", () => assert.equal(flattenSubdomainToLabel("MyClient"), "myclient"));
ok("maps invalid chars to '-' and collapses", () => assert.equal(flattenSubdomainToLabel("acme_corp/site"), "acme-corp-site"));
ok("trims leading/trailing dashes", () => assert.equal(flattenSubdomainToLabel("--Foo.Bar--"), "foo-bar"));
ok("caps at 63 chars, no trailing dash", () => {
	const out = flattenSubdomainToLabel("a".repeat(80));
	assert.ok(out.length <= 63 && !out.endsWith("-"));
});
ok("empty flatten throws", () => assert.throws(() => flattenSubdomainToLabel("___"), /empty DNS label/));

console.log("loadCfEnv");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf66-"));
ok("parses a complete cf.env", () => {
	const p = path.join(tmp, "cf.env");
	fs.writeFileSync(p, `CF_API_TOKEN=tok\nCF_ACCOUNT_ID=acc\nCF_ZONE_ID="zone"\nCF_TUNNEL_ID='tun'\n# comment\n`);
	const cf = loadCfEnv(p);
	assert.deepEqual(cf, { token: "tok", accountId: "acc", zoneId: "zone", tunnelId: "tun" });
});
ok("missing file → clear, actionable error", () =>
	assert.throws(() => loadCfEnv(path.join(tmp, "nope.env")), /not found or unreadable/));
ok("missing required key → names it", () => {
	const p = path.join(tmp, "partial.env");
	fs.writeFileSync(p, `CF_API_TOKEN=tok\nCF_ACCOUNT_ID=acc\n`);
	assert.throws(() => loadCfEnv(p), /missing required key\(s\): CF_ZONE_ID, CF_TUNNEL_ID/);
});

console.log("parseAclFile");
ok("reads + validates emails, strips comments", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "acl66-"));
	fs.writeFileSync(path.join(d, ".serve-acl"), `# who\na@x.com\nb@y.com  # inline\n`);
	assert.deepEqual(parseAclFile(d), ["a@x.com", "b@y.com"]);
});
ok("accepts @domain rules alongside addresses", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "acl66-"));
	fs.writeFileSync(path.join(d, ".serve-acl"), `@roguelivestock.com\nmelissa@roguelivestock.com  # individual\n`);
	assert.deepEqual(parseAclFile(d), ["@roguelivestock.com", "melissa@roguelivestock.com"]);
});
ok("malformed @domain (no dot) throws", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "acl66-"));
	fs.writeFileSync(path.join(d, ".serve-acl"), `@localhost\n`);
	assert.throws(() => parseAclFile(d), /Invalid domain rule/);
});
ok("invalid email throws", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "acl66-"));
	fs.writeFileSync(path.join(d, ".serve-acl"), `not-an-email\n`);
	assert.throws(() => parseAclFile(d), /Invalid email/);
});
ok("all-comment file → 'at least one' error", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "acl66-"));
	fs.writeFileSync(path.join(d, ".serve-acl"), `# only comments\n`);
	assert.throws(() => parseAclFile(d), /at least one valid email/);
});

console.log("aclEntriesToInclude");
ok("maps a single address to an email rule", () =>
	assert.deepEqual(aclEntriesToInclude(["a@x.com"]), [{ email: { email: "a@x.com" } }]));
ok("maps an @domain entry to an email_domain rule", () =>
	assert.deepEqual(aclEntriesToInclude(["@roguelivestock.com"]), [{ email_domain: { domain: "roguelivestock.com" } }]));
ok("maps a mixed list preserving order", () =>
	assert.deepEqual(aclEntriesToInclude(["@r.com", "m@r.com"]), [
		{ email_domain: { domain: "r.com" } },
		{ email: { email: "m@r.com" } },
	]));

console.log(`\n${passed} assertions passed.`);
