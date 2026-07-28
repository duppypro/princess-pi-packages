// Tests for the cascade ACL resolver (#32): union up to $HOME, sibling isolation,
// fail-closed on empty, comment/invalid handling.
// Run: npx tsx tests/serve-acl-cascade.test.ts
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCascadeAcl, parseAclContent } from "../extensions/lib/serve/acl-cascade.js";

function mkAcl(dir: string, ...emails: string[]) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".serve-acl"), emails.join("\n") + "\n");
}

async function run() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acl-cascade-"));
	const home = root; // treat the temp root as $HOME for the resolver
	const acme = path.join(home, "git", "clients", "acme");
	const beta = path.join(home, "git", "clients", "beta");

	mkAcl(home, "duppy@example.com");          // cascade root -> everything
	mkAcl(acme, "acme-reviewer@acme.com");      // acme subtree only
	mkAcl(beta, "beta-reviewer@beta.com");      // beta subtree only

	// --- Test 1: union cascades DOWN (leaf + ancestors up to home) ---
	const acmeList = resolveCascadeAcl(acme, home);
	assert.deepStrictEqual(acmeList, ["acme-reviewer@acme.com", "duppy@example.com"],
		"acme share = its own reviewer + the home cascade root");
	console.log("✓ Test 1: cascade unions leaf .serve-acl with ancestors up to $HOME");

	// --- Test 2: HARD isolation between sibling subtrees ---
	const betaList = resolveCascadeAcl(beta, home);
	assert.ok(!betaList.includes("acme-reviewer@acme.com"), "beta must NOT see acme's reviewer");
	assert.ok(!acmeList.includes("beta-reviewer@beta.com"), "acme must NOT see beta's reviewer");
	assert.ok(betaList.includes("duppy@example.com"), "shared ancestor still applies to beta");
	console.log("✓ Test 2: sibling subtrees are isolated; only common ancestors are shared");

	// --- Test 3: fail closed when no .serve-acl exists anywhere up to home ---
	const lonelyHome = fs.mkdtempSync(path.join(os.tmpdir(), "acl-empty-"));
	const lonelyDir = path.join(lonelyHome, "a", "b");
	fs.mkdirSync(lonelyDir, { recursive: true });
	assert.throws(() => resolveCascadeAcl(lonelyDir, lonelyHome), /No reviewers authorized/,
		"empty effective ACL must throw (fail closed)");
	console.log("✓ Test 3: empty effective ACL refuses to serve");

	// --- Test 4: comments + trailing comments + dedupe ---
	assert.deepStrictEqual(
		parseAclContent("# header\n a@b.com  # me\n\nc@d.com\n a@b.com\n"),
		["a@b.com", "c@d.com", "a@b.com"],
		"parser strips comments/whitespace (dedupe happens in resolver)");
	console.log("✓ Test 4: comment + whitespace handling");

	// --- Test 5: malformed address is a hard error ---
	assert.throws(() => parseAclContent("not-an-email\n"), /Invalid email/,
		"a line without @/. must throw");
	console.log("✓ Test 5: invalid email throws");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("\nAll #32 cascade-ACL tests passed.");
}

run().catch((err) => { console.error(err); process.exit(1); });
