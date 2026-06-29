import * as https from "node:https";
import * as http from "node:http";
import * as assert from "node:assert";

// Helper to make a request to NGINX on localhost simulating princess-pi.dev Host header
function requestNginx(path: string): Promise<{ statusCode: number; headers: any; body: string }> {
	return new Promise((resolve, reject) => {
		const agent = new https.Agent({ rejectUnauthorized: false });
		const req = https.get(
			`https://127.0.0.1${path}`,
			{
				agent,
				headers: {
					Host: "princess-pi.dev"
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
		// Test 1: Accessing without token should return 403 Forbidden (since OAuth proxy is offline)
		console.log("\nTest 1: Requesting /live/ without token...");
		const res1 = await requestNginx("/live/princess-pi-packages/docs/");
		console.log(`- Status: ${res1.statusCode}`);
		console.log(`- Body: ${res1.body.trim()}`);
		assert.strictEqual(res1.statusCode, 403);
		assert.match(res1.body, /Forbidden/);
		console.log("✅ Test 1 Passed: Unauthorized access blocked with 403!");

		// Test 2: Accessing with correct token bypass
		console.log("\nTest 2: Requesting /live/ with secure bypass token...");
		const res2 = await requestNginx("/live/princess-pi-packages/docs/?token=duppy_live_token_777");
		console.log(`- Status: ${res2.statusCode}`);
		console.log(`- Content-Type: ${res2.headers["content-type"]}`);
		assert.strictEqual(res2.statusCode, 200);
		assert.match(res2.body, /Index of \//);
		console.log("✅ Test 2 Passed: Token bypass allowed with 200 OK!");

		console.log("\n🎉 ALL LIVE RESPONSE TESTS PASSED SUCCESSFULLY!");
	} catch (err: any) {
		console.error("\n❌ Live Response Test Failed:", err.message);
		process.exit(1);
	}
}

runTests();
