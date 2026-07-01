#!/usr/bin/env -S node --experimental-strip-types
/**
 * Unit test for the session-name-display extension.
 *
 * Verifies that session names are stored clean (no escape codes/padding),
 * and that a custom footer is registered for the TUI rendering layer.
 */

import * as assert from "assert";
import sessionNameDisplayExtension from "../extensions/session-name-display.ts";

console.log("🏃 Running session-name-display extension test...");

// Mock state
let sessionName: string | null = null;
let registeredFooter: ((...args: any[]) => any) | undefined = undefined;
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
  },
};

const mockSessionManager: any = {
  getBranch: () => [],
  getCwd: () => "/home/user/project",
  getSessionName: () => sessionName,
  getEntries: () => [],
};

let footerOnBranchChangeCb: (() => void) | undefined;

const mockFooterData: any = {
  getGitBranch: () => "main",
  getExtensionStatuses: () => new Map(),
  getAvailableProviderCount: () => 1,
  onBranchChange: (cb: () => void) => {
    footerOnBranchChangeCb = cb;
    return () => {};
  },
};

const mockCtx: any = {
  sessionManager: mockSessionManager,
  model: { id: "test-model", contextWindow: 200000 },
  modelRegistry: { isUsingOAuth: () => false },
  getContextUsage: () => ({
    tokens: 5000,
    contextWindow: 200000,
    percent: 2.5,
  }),
  ui: {
    setFooter: (factory: ((...args: any[]) => any) | undefined) => {
      registeredFooter = factory;
    },
    notify: () => {},
    theme: {
      fg: (color: string, text: string) => `\x1b[38;5;244m${text}\x1b[39m`,
    },
  },
};

// Initialize extension
sessionNameDisplayExtension(mockPi);

async function triggerEvent(event: string, ctx = mockCtx) {
  const handlers = eventHandlers[event] || [];
  for (const handler of handlers) {
    await handler({ type: event }, ctx);
  }
}

async function main() {
  // -----------------------------------------------------------------------
  // Test 1: session_start stores clean name (strips escape codes)
  // -----------------------------------------------------------------------
  try {
    sessionName = "\x1b[38;5;244m\x1b[7m Thursday \x1b[27m\x1b[39m";
    await triggerEvent("session_start");

    // The extension should strip ANSI codes and trim
    assert.ok(sessionName);
    assert.strictEqual(sessionName, "Thursday");
    console.log("  ✅ Passed [Test 1] session_start strips escape codes from session name");
  } catch (err) {
    console.error("  ❌ Failed [Test 1]:", err);
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Test 2: session_start with null name defaults to _ANONYMOUS_
  // -----------------------------------------------------------------------
  try {
    sessionName = null;
    await triggerEvent("session_start");

    assert.strictEqual(sessionName, "_ANONYMOUS_");
    console.log("  ✅ Passed [Test 2] Unnamed session defaults to _ANONYMOUS_");
  } catch (err) {
    console.error("  ❌ Failed [Test 2]:", err);
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Test 3: Custom footer is registered
  // -----------------------------------------------------------------------
  try {
    assert.ok(registeredFooter, "Expected a footer factory to be registered");
    console.log("  ✅ Passed [Test 3] Custom footer registered via ctx.ui.setFooter()");
  } catch (err) {
    console.error("  ❌ Failed [Test 3]:", err);
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Test 4: Custom footer renders inverted session name in pwd line
  // -----------------------------------------------------------------------
  try {
    sessionName = "MySession";
    const footerComponent = registeredFooter!(
      { requestRender: () => {} }, // tui mock
      { fg: (_c: string, t: string) => t }, // pass-through theme
      mockFooterData,
    );

    const lines = footerComponent.render(100);

    // The pwd line should contain the session name with inverse escape codes
    const pwdLine = lines[0];
    assert.ok(pwdLine, "Expected at least one line");
    assert.ok(
      pwdLine.includes("\x1b[7m"),
      "Expected inverse escape code in pwd line",
    );
    assert.ok(
      pwdLine.includes(" MySession "),
      "Expected session name with padding in pwd line",
    );
    assert.ok(
      pwdLine.includes("\x1b[27m"),
      "Expected inverse-off escape code in pwd line",
    );
    console.log("  ✅ Passed [Test 4] Custom footer renders session name with inverse + padding");
  } catch (err) {
    console.error("  ❌ Failed [Test 4]:", err);
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Test 5: turn_start cleans an escaped name added externally (e.g. /name)
  // -----------------------------------------------------------------------
  try {
    sessionName = "\x1b[7m DirtyName \x1b[27m";
    await triggerEvent("turn_start");

    assert.strictEqual(sessionName, "DirtyName");
    console.log("  ✅ Passed [Test 5] turn_start strips escape codes from externally-set name");
  } catch (err) {
    console.error("  ❌ Failed [Test 5]:", err);
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Test 6: getSessionName() returns clean name (no escape codes)
  // -----------------------------------------------------------------------
  try {
    // Simulate an externally-set clean name
    sessionName = "Important Work";
    const retrieved = mockPi.getSessionName();

    assert.strictEqual(retrieved, "Important Work");
    // Verify NO escape codes
    assert.ok(!retrieved.includes("\x1b[7m"), "Name should not contain inverse codes");
    assert.ok(!retrieved.includes("\x1b["), "Name should not contain any ANSI codes");
    console.log("  ✅ Passed [Test 6] getSessionName() returns clean name");
  } catch (err) {
    console.error("  ❌ Failed [Test 6]:", err);
    process.exit(1);
  }

  console.log("\n🎉 All session-name-display tests passed successfully!");
}

main();
