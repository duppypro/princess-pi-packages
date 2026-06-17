#!/usr/bin/env -S node --experimental-strip-types
/**
 * Unit test for the new-session extension.
 */

import * as assert from "assert";
import newSessionExtension from "../extensions/new-session.ts";

console.log("🏃 Running new-session extension test...");

// Mock ExtensionAPI
let registeredCommand: string | null = null;
let registeredHandler: Function | null = null;
let sessionNameSet: string | null = null;
let notifications: string[] = [];

const mockPi: any = {
  registerCommand: (name: string, options: any) => {
    registeredCommand = name;
    registeredHandler = options.handler;
  },
};

// Initialize extension
newSessionExtension(mockPi);

// Assert command was registered
assert.strictEqual(registeredCommand, "nn");
assert.ok(registeredHandler);

// Mock Context to invoke handler
const mockCtx: any = {
  newSession: async (options: any) => {
    const mockNewCtx: any = {
      ui: {
        notify: (msg: string, type: string) => {
          notifications.push(`${type}: ${msg}`);
        },
      },
      sessionManager: {
        appendSessionInfo: (name: string) => {
          sessionNameSet = name;
        },
      },
    };
    await options.withSession(mockNewCtx);
  },
};

// Helper to reset mocks
function resetMockState() {
  sessionNameSet = null;
  notifications = [];
}

async function main() {
  // Test Case 1: Start unnamed session
  try {
    resetMockState();
    await registeredHandler!("", mockCtx);
    assert.strictEqual(sessionNameSet, null);
    assert.deepStrictEqual(notifications, ["info: Started new unnamed session"]);
    console.log("  ✅ Passed [Test 1] Unnamed session");
  } catch (err) {
    console.error("  ❌ Failed [Test 1]:", err);
    process.exit(1);
  }

  // Test Case 2: Start session with direct name
  try {
    resetMockState();
    await registeredHandler!("My Cool Task", mockCtx);
    assert.strictEqual(sessionNameSet, "My Cool Task");
    assert.deepStrictEqual(notifications, ['success: Started new session: "My Cool Task"']);
    console.log("  ✅ Passed [Test 2] Direct name");
  } catch (err) {
    console.error("  ❌ Failed [Test 2]:", err);
    process.exit(1);
  }

  // Test Case 3: Start session with -n flag
  try {
    resetMockState();
    await registeredHandler!("-n 'My Cool Task'", mockCtx);
    assert.strictEqual(sessionNameSet, "My Cool Task");
    assert.deepStrictEqual(notifications, ['success: Started new session: "My Cool Task"']);
    console.log("  ✅ Passed [Test 3] -n flag");
  } catch (err) {
    console.error("  ❌ Failed [Test 3]:", err);
    process.exit(1);
  }

  // Test Case 4: Start session with --name flag and double quotes
  try {
    resetMockState();
    await registeredHandler!('--name "My Cool Task"', mockCtx);
    assert.strictEqual(sessionNameSet, "My Cool Task");
    assert.deepStrictEqual(notifications, ['success: Started new session: "My Cool Task"']);
    console.log("  ✅ Passed [Test 4] --name flag");
  } catch (err) {
    console.error("  ❌ Failed [Test 4]:", err);
    process.exit(1);
  }

  console.log("\n🎉 All new-session tests passed successfully!");
}

main();
