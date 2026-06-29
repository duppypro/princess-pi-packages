// Regression test for #39: `serve --kill` must actually terminate the process and must
// fail loud (return false) when it cannot — never silently report success.
// Run: npx tsx tests/serve-kill.test.ts
import * as assert from "node:assert";
import { spawn } from "node:child_process";
import { killServerInstance, isProcessAlive, confirmProcessKilled } from "../extensions/lib/serve/process.js";
import type { ServerInstance } from "../extensions/lib/serve/domain.js";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
	// --- Test 1: kills via the PID captured at discovery, and confirms it's gone ---
	const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
	child.unref();
	const pid = child.pid!;
	assert.ok(isProcessAlive(pid), "child should be alive after spawn");

	const server: ServerInstance = { port: 65431, dir: "/tmp/x", url: "x", title: "x", pid };
	const killed = await killServerInstance(server);
	assert.strictEqual(killed, true, "killServerInstance should return true when the PID is killed");
	assert.ok(!isProcessAlive(pid), "process must actually be gone after kill");
	console.log("✓ Test 1: pid-based kill terminates the process and confirms death");

	// --- Test 2: fail loud — no pid and nothing on the port => false, not a silent success ---
	const ghost: ServerInstance = { port: 59997, dir: "/tmp/none", url: "x", title: "x" }; // no pid
	const result = await killServerInstance(ghost);
	assert.strictEqual(result, false, "must return false when no PID can be resolved (#39: no silent no-op)");
	console.log("✓ Test 2: returns false (fail-loud) when no PID is resolvable");

	// --- Test 3: confirmProcessKilled detects an already-dead pid quickly ---
	const child2 = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
	child2.unref();
	process.kill(child2.pid!, "SIGKILL");
	await sleep(50);
	assert.strictEqual(await confirmProcessKilled(child2.pid!), true, "confirmProcessKilled should see the dead pid");
	console.log("✓ Test 3: confirmProcessKilled detects a terminated pid");

	console.log("\nAll #39 kill-path tests passed.");
}

run().catch((e) => { console.error("TEST FAILED:", e); process.exit(1); });
