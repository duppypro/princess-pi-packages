#!/usr/bin/env -S node --experimental-strip-types
/**
 * Performance benchmark for yada CLI.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { performance } from "perf_hooks";

const yadaBin = path.join(process.cwd(), "bin/yada.ts");
const logFixture = path.join(process.cwd(), "test/fixtures/access-17k.log");

function runBenchmark(iterations = 5): { avgTime: number; minTime: number; maxTime: number } {
  const times: number[] = [];
  const logData = fs.readFileSync(logFixture, "utf-8");

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const result = spawnSync("node", ["--experimental-strip-types", yadaBin], {
      input: logData,
      encoding: "utf-8",
    });
    const duration = performance.now() - start;

    if (result.status !== 0) {
      throw new Error(`Benchmark failed on iteration ${i}: ${result.stderr}`);
    }
    times.push(duration);
  }

  const sum = times.reduce((a, b) => a + b, 0);
  const avgTime = sum / iterations;
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);

  return { avgTime, minTime, maxTime };
}

console.log("⏱️ Taking performance benchmark of yada on 17000 lines (5 iterations)...");
const stats = runBenchmark();
console.log(`\n📊 Baseline Benchmark Results:`);
console.log(`  - Average Execution Time: ${stats.avgTime.toFixed(2)}ms`);
console.log(`  - Minimum Execution Time: ${stats.minTime.toFixed(2)}ms`);
console.log(`  - Maximum Execution Time: ${stats.maxTime.toFixed(2)}ms`);
