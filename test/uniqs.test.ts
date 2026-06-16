#!/usr/bin/env -S node --experimental-strip-types
/**
 * Automated test suite for uniqs CLI tool.
 */

import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const uniqsBin = path.join(process.cwd(), "bin/uniqs.ts");

// Helper to run uniqs bin with stdin input and optional args
function runUniqs(input: string, args: string[] = []): string {
  const result = spawnSync("node", ["--experimental-strip-types", uniqsBin, ...args], {
    input,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed with code ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

console.log("🏃 Running uniqs test suite...");

// Test Case 1: Perfect consecutive duplicates collapsing
try {
  console.log("  [Test 1] Perfect Duplicates...");
  const input = "Hello\nHello\nHello\nWorld\n";
  const output = runUniqs(input, ["-p"]);
  const expected = "Hello ☝️ +2\nWorld\n";
  assert.strictEqual(output, expected);
  console.log("  ✅ Passed [Test 1]");
} catch (err) {
  console.error("  ❌ Failed [Test 1]:", err);
  process.exit(1);
}

// Test Case 2: Near-duplicates (Single Numeric Slot)
try {
  console.log("  [Test 2] Near-Duplicates (Single Numeric Slot)...");
  const input = "Port 8080 active\nPort 8081 active\nPort 8085 active\n";
  const output = runUniqs(input, ["-p"]);
  const expected = "Port [8080-8081, 8085] active ☝️ +2\n";
  assert.strictEqual(output, expected);
  console.log("  ✅ Passed [Test 2]");
} catch (err) {
  console.error("  ❌ Failed [Test 2]:", err);
  process.exit(1);
}

// Test Case 3: Log Timestamp Parsing and Periodicity
try {
  console.log("  [Test 3] ISO 8601 Timestamp & Periodicity Detection...");
  const input = [
    "2026-06-16T12:00:00.000Z Request handled",
    "2026-06-16T12:00:05.000Z Request handled",
    "2026-06-16T12:00:10.000Z Request handled",
    "2026-06-16T12:00:15.000Z Request handled"
  ].join("\n") + "\n";
  const output = runUniqs(input);
  const expected = "2026-06-16T12:00:00.000Z Request handled ☝️ +3 (every ~5s)\n";
  assert.strictEqual(output, expected);
  console.log("  ✅ Passed [Test 3]");
} catch (err) {
  console.error("  ❌ Failed [Test 3]:", err);
  process.exit(1);
}

// Test Case 4: Apache / Common Log Format Timestamps
try {
  console.log("  [Test 4] Apache Log Format Timestamps...");
  const input = [
    "[10/Oct/2000:13:55:36 -0700] GET /index.html",
    "[10/Oct/2000:13:55:46 -0700] GET /index.html",
    "[10/Oct/2000:13:55:56 -0700] GET /index.html"
  ].join("\n") + "\n";
  const output = runUniqs(input);
  const expected = "[10/Oct/2000:13:55:36 -0700] GET /index.html ☝️ +2 (every ~10s)\n";
  assert.strictEqual(output, expected);
  console.log("  ✅ Passed [Test 4]");
} catch (err) {
  console.error("  ❌ Failed [Test 4]:", err);
  process.exit(1);
}

// Test Case 5: Custom Badge Format
try {
  console.log("  [Test 5] Custom Badge Format...");
  const input = "Hello\nHello\n";
  const output = runUniqs(input, ["-p", "-f", "[collapsed: {count}]"]);
  const expected = "Hello [collapsed: 1]\n";
  assert.strictEqual(output, expected);
  console.log("  ✅ Passed [Test 5]");
} catch (err) {
  console.error("  ❌ Failed [Test 5]:", err);
  process.exit(1);
}

// Test Case 6: Multiple Periodicities (Autocorrelation/Clustering)
try {
  console.log("  [Test 6] Multi-frequency Periodicity...");
  // Timestamps with two distinct repeating patterns: 5s and 10s
  const input = [
    "2026-06-16T12:00:00.000Z Tick",
    "2026-06-16T12:00:05.000Z Tick", // delta = 5s
    "2026-06-16T12:00:15.000Z Tick", // delta = 10s
    "2026-06-16T12:00:20.000Z Tick", // delta = 5s
    "2026-06-16T12:00:30.000Z Tick", // delta = 10s
    "2026-06-16T12:00:35.000Z Tick"  // delta = 5s
  ].join("\n") + "\n";
  const output = runUniqs(input);
  const expected = "2026-06-16T12:00:00.000Z Tick ☝️ +5 (every ~5s and ~10s)\n";
  assert.strictEqual(output, expected);
  console.log("  ✅ Passed [Test 6]");
} catch (err) {
  console.error("  ❌ Failed [Test 6]:", err);
  process.exit(1);
}

console.log("\n🎉 All tests passed successfully!");
