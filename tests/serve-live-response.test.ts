import * as https from "node:https";
import * as http from "node:http";
import * as assert from "node:assert";

// Helper to make a request to NGINX on localhost simulating princess-pi.dev Host header
function requestNginx(path: string, customHeaders: Record<string, string> = {}): Promise<{ statusCode: number; headers: any; body: string }> {
	return new Promise((resolve, reject) => {
		const agent = new https.Agent({ rejectUnauthorized: false });
		const req = https.get(
			`https://127.0.0.1${path}`,
			{
				agent,
				headers: {
					Host: "princess-pi.dev",
					...customHeaders
				},
				timeout: 1000
			},
			(res) => {
				res.on("error", () => {});
				let data = "";
				res.on("data", (chunk) => { data += chunk; });
				res.on("end", () => {
					resolve({
						statusCode: res.statusCode || 0,
						headers: res.headers,
						body: data
					});
				});
			}
		);
		req.on("error", reject);
	});
}

async function runTests() {
	console.log("🧪 Running Automated Live NGINX Response Tests...");

	try {
		// Invariant: an unauthenticated request must be blocked. The former Test 2/3
		// asserted a static ?token= URL bypass (a committed backdoor secret)
		// granted 200 + a princess_bypass_token session cookie — deleted with the token
		// itself (#38 F2 → #59). Access is via the real gate (Google OAuth / Cloudflare
		// Access), which this loopback test can't exercise, so we assert only the denial.
		console.log("\nTest 1: Requesting /live/ without credentials should be denied...");
		const res1 = await requestNginx("/live/princess-pi-packages/docs/");
		console.log(`- Status: ${res1.statusCode}`);
		console.log(`- Body: ${res1.body.trim()}`);
		assert.strictEqual(res1.statusCode, 403);
		assert.match(res1.body, /Forbidden/);
		console.log("✅ Test 1 Passed: Unauthorized access blocked with 403!");

		console.log("\n🎉 LIVE NGINX DENIAL TEST PASSED SUCCESSFULLY!");
	} catch (err: any) {
		console.error("\n❌ Live Session Test Failed:", err.message);
		process.exit(1);
	}
}

runTests();
