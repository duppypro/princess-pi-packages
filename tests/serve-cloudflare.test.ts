// Tests for the Cloudflare/Terraform driver's pure helpers (#32): slug->label,
// collision suffixing, hostname/url construction. (Terraform apply itself is verified
// live after onboarding — see docs/SPEC_SECURE_DYNAMIC_SERVE.md §11.)
// Run: npx tsx tests/serve-cloudflare.test.ts
import * as assert from "node:assert";
import { slugify, labelFor, hostnameFor, gatedUrlFor } from "../extensions/lib/serve/cloudflare.js";

async function run() {
	// --- Test 1: slugify makes a DNS-safe label from a repo/sub/dir slug ---
	assert.strictEqual(slugify("princess-pi-packages/docs"), "princess-pi-packages-docs");
	assert.strictEqual(slugify("My_Repo/Feature Branch!"), "my-repo-feature-branch");
	assert.strictEqual(slugify("--weird__/--"), "weird");
	console.log("✓ Test 1: slugify produces lowercase, hyphenated, trimmed DNS labels");

	// --- Test 2: no collision -> base label; reuse existing label for the same slug ---
	const shares: any = {
		"repo-docs": { slug: "repo/docs", hostname: "x", port: 1, dir: "/x", emails: [] },
	};
	assert.strictEqual(labelFor("repo/docs", shares), "repo-docs", "same slug reuses its label");
	assert.strictEqual(labelFor("repo/other", shares), "repo-other", "distinct slug, no collision -> base");
	console.log("✓ Test 2: labelFor reuses same-slug label and passes through non-colliding bases");

	// --- Test 3: DIFFERENT slug colliding on the same base gets a deterministic hash suffix ---
	const collide: any = {
		"repo-docs": { slug: "repo/docs", hostname: "x", port: 1, dir: "/x", emails: [] },
	};
	// "repo.docs" and "repo/docs" both slugify to "repo-docs" -> collision for the new one
	const a = labelFor("repo.docs", collide);
	const b = labelFor("repo.docs", collide);
	assert.notStrictEqual(a, "repo-docs", "colliding distinct slug must not reuse the base label");
	assert.match(a, /^repo-docs-[0-9a-f]{6}$/, "suffix is a 6-hex hash");
	assert.strictEqual(a, b, "suffix is deterministic for the same slug");
	console.log("✓ Test 3: collision -> deterministic -<6hex> suffix");

	// --- Test 4: hostname + url construction ---
	assert.strictEqual(hostnameFor("repo-docs", "vps"), "repo-docs.vps.preview.princess-pi.dev");
	assert.strictEqual(gatedUrlFor("repo-docs", "vps"), "https://repo-docs.vps.preview.princess-pi.dev/");
	console.log("✓ Test 4: hostname/url built as <label>.<machine>.preview.princess-pi.dev");

	console.log("\nAll #32 Cloudflare-driver helper tests passed.");
}

run().catch((err) => { console.error(err); process.exit(1); });
