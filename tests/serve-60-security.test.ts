// Acceptance tests for #60 (folded into Phase 6A, #64):
//   F1 — directory-boundary traversal: "/a/bc".startsWith("/a/b") must NOT grant access,
//        and a symlink inside the root must not serve targets outside the REAL root.
//   F2 — directory-index reflection: crafted filenames / paths render HTML-escaped.
// Run: npx tsx tests/serve-60-security.test.ts
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = 61934;
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Raw request — fetch() would normalize "../" client-side, hiding the traversal.
function rawGet(reqPath: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path: reqPath, method: "GET" },
			(res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			}
		);
		req.on("error", reject);
		req.end();
	});
}

async function run() {
	// --- Fixture: root "b" and SIBLING "bc" sharing the string prefix ---
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "serve60-"));
	const root = path.join(base, "b");
	const sibling = path.join(base, "bc");
	fs.mkdirSync(root);
	fs.mkdirSync(sibling);
	fs.writeFileSync(path.join(root, "hello.txt"), "hello from inside");
	fs.writeFileSync(path.join(sibling, "secret.txt"), "SIBLING-SECRET");
	fs.writeFileSync(path.join(base, "outside.txt"), "OUTSIDE-SECRET");
	fs.writeFileSync(path.join(root, `<img src=x onerror=alert(1)>.txt`), "xss bait");
	fs.symlinkSync(path.join(base, "outside.txt"), path.join(root, "link-escape.txt"));

	const runner = path.resolve("extensions/lib/serve/run-live-server.js");
	const child: ChildProcess = spawn("node", [runner, root, "--slug", "t60", "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
	try {
		let up = false;
		for (let i = 0; i < 40 && !up; i++) {
			await sleep(250);
			try { await rawGet("/hello.txt"); up = true; } catch {}
		}
		assert.ok(up, "live server should come up");

		// --- Baseline: legit file still served (guard against over-blocking) ---
		const ok = await rawGet("/hello.txt");
		assert.strictEqual(ok.status, 200);
		assert.match(ok.body, /hello from inside/);
		console.log("✓ baseline: in-root file serves 200");

		// --- F1a: sibling-dir traversal via ".." must be 403 (old code served it) ---
		const sib = await rawGet("/..%2Fbc%2Fsecret.txt");
		assert.strictEqual(sib.status, 403, `sibling-dir traversal must 403, got ${sib.status}`);
		assert.ok(!sib.body.includes("SIBLING-SECRET"), "sibling secret must not leak");
		console.log("✓ F1a: sibling-dir traversal (/a/b -> /a/bc) -> 403");

		// --- F1b: symlink escaping the real root must be 403 ---
		const link = await rawGet("/link-escape.txt");
		assert.strictEqual(link.status, 403, `symlink escape must 403, got ${link.status}`);
		assert.ok(!link.body.includes("OUTSIDE-SECRET"), "symlink target must not leak");
		console.log("✓ F1b: symlink escape -> 403");

		// --- F2: crafted filename renders escaped in the directory index ---
		const idx = await rawGet("/");
		assert.strictEqual(idx.status, 200);
		assert.ok(!idx.body.includes("<img src=x"), "raw markup from filename must not reach the listing");
		assert.ok(idx.body.includes("&lt;img src=x"), "filename must render HTML-escaped");
		console.log("✓ F2: crafted filename is escaped in the listing");
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(base, { recursive: true, force: true });
	}
	console.log("ALL #60 ACCEPTANCE TESTS PASSED");
}

run().catch((err) => { console.error(err); process.exit(1); });
