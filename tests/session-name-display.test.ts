#!/usr/bin/env -S node --experimental-strip-types
/**
 * Unit test for the session-name-display extension.
 */

import * as assert from "assert";
import sessionNameDisplayExtension from "../extensions/session-name-display.ts";

console.log("🏃 Running session-name-display extension test...");

// Mock state
let sessionName: string | null = null;
const eventHandlers: { [event: string]: Function[] } = {};

const mockPi: any = {
  getSessionName: () => sessionName,
  setSessionName: (name: string) => {
    sessionName = name;
  },
  on: (event: string, handler: Function) => {
    if (!eventHandlers[event]) {
      eventHandlers[event] = [];
    }
    eventHandlers[event].push(handler);
  }
};

// Mock sessionManager
const mockSessionManager: any = {
  appendSessionInfo: function (name: string) {
    sessionName = name;
  }
};

const mockCtx: any = {
  ui: {
    theme: {
      fg: (color: string, text: string) => `\x1b[38;5;244m${text}\x1b[39m`
    }
  },
  sessionManager: mockSessionManager
};

// Initialize extension
sessionNameDisplayExtension(mockPi);

// Trigger a mock event
async function triggerEvent(event: string) {
  const handlers = eventHandlers[event] || [];
  for (const handler of handlers) {
    await handler({ type: event }, mockCtx);
  }
}

async function main() {
  // Test Case 1: Start unnamed session
  try {
    sessionName = null;
    await triggerEvent("session_start");
    
    // Should default to _ANONYMOUS_ with styling
    assert.ok(sessionName);
    assert.ok(sessionName.includes("_ANONYMOUS_"));
    assert.strictEqual(sessionName, "\x1b[38;5;244m\x1b[7m _ANONYMOUS_ \x1b[27m\x1b[39m");
    console.log("  ✅ Passed [Test 1] Unnamed session default to _ANONYMOUS_");
  } catch (err) {
    console.error("  ❌ Failed [Test 1]:", err);
    process.exit(1);
  }

  // Test Case 2: Style a set session name during turn_start
  try {
    sessionName = "Thursday";
    await triggerEvent("turn_start");
    
    assert.ok(sessionName);
    assert.ok(sessionName.includes("Thursday"));
    assert.strictEqual(sessionName, "\x1b[38;5;244m\x1b[7m Thursday \x1b[27m\x1b[39m");
    console.log("  ✅ Passed [Test 2] Styled session name on turn_start");
  } catch (err) {
    console.error("  ❌ Failed [Test 2]:", err);
    process.exit(1);
  }

  // Test Case 3: Verify the overridden appendSessionInfo intercepts and styles dynamic renames
  try {
    // Reset wrapper flag if any, but since we are mocking, let's verify mockSessionManager got wrapped
    assert.ok(mockSessionManager.__isSessionNameDisplayWrapped);
    
    // Call appendSessionInfo directly as TUI / `/name` command would
    mockSessionManager.appendSessionInfo("NewSessionName");
    
    // The sessionName should have been automatically intercepted and styled!
    assert.strictEqual(sessionName, "\x1b[38;5;244m\x1b[7m NewSessionName \x1b[27m\x1b[39m");
    console.log("  ✅ Passed [Test 3] Overridden appendSessionInfo styles dynamically");
  } catch (err) {
    console.error("  ❌ Failed [Test 3]:", err);
    process.exit(1);
  }

  // Test Case 4: Verify that ANSI escape sequences are stripped and not nested-wrapped
  try {
    // Call with already-styled name
    mockSessionManager.appendSessionInfo("\x1b[38;5;244m\x1b[7m Thursday \x1b[27m\x1b[39m");
    
    // It should cleanly strip the old formatting and apply fresh formatting
    assert.strictEqual(sessionName, "\x1b[38;5;244m\x1b[7m Thursday \x1b[27m\x1b[39m");
    console.log("  ✅ Passed [Test 4] ANSI escape sequences are cleanly stripped and not nested");
  } catch (err) {
    console.error("  ❌ Failed [Test 4]:", err);
    process.exit(1);
  }

  console.log("\n🎉 All session-name-display tests passed successfully!");
}

main();
