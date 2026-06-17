#!/usr/bin/env -S node --experimental-strip-types
/**
 * Performance comparison benchmark for yada CLI:
 * Chunk Buffering vs. Readline (Baseline).
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { performance } from "perf_hooks";

const yadaChunkBin = path.join(process.cwd(), "bin/yada.ts");
const yadaReadlineBin = path.join(process.cwd(), "bin/yada-readline.ts");
const logFixture = path.join(process.cwd(), "tests/fixtures/access-17k.log");

interface BenchResult {
  avgTime: number;
  minTime: number;
  maxTime: number;
}

function runBenchmark(binPath: string, iterations = 3): BenchResult {
  const times: number[] = [];
  const logData = fs.readFileSync(logFixture, "utf-8");

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const result = spawnSync("node", ["--experimental-strip-types", binPath], {
      input: logData,
      encoding: "utf-8",
    });
    const duration = performance.now() - start;

    if (result.status !== 0) {
      throw new Error(`Benchmark failed on ${path.basename(binPath)}, iteration ${i}: ${result.stderr}`);
    }
    times.push(duration);
  }

  const sum = times.reduce((a, b) => a + b, 0);
  return {
    avgTime: sum / iterations,
    minTime: Math.min(...times),
    maxTime: Math.max(...times),
  };
}

console.log("⏱️  Running Side-by-Side Performance Comparison (17,000 lines, 3 iterations)...");

console.log("\n⏳ Benchmarking Baseline (Readline)...");
const readlineStats = runBenchmark(yadaReadlineBin);

console.log("⏳ Benchmarking Optimized (Chunk Buffering)...");
const chunkStats = runBenchmark(yadaChunkBin);

console.log("\n📊 Performance Comparison Results:");
console.log("=========================================================================");
console.log(`| Implementation     | Avg Time   | Min Time   | Max Time   | Speedup   |`);
console.log("-------------------------------------------------------------------------");

const speedup = readlineStats.avgTime / chunkStats.avgTime;
const speedupStr = speedup >= 1 
  ? `\x1b[32m${speedup.toFixed(2)}x faster\x1b[0m` 
  : `\x1b[31m${(1 / speedup).toFixed(2)}x slower\x1b[0m`;

console.log(`| Readline (Base)    | ${readlineStats.avgTime.toFixed(2).padStart(8)}ms | ${readlineStats.minTime.toFixed(2).padStart(8)}ms | ${readlineStats.maxTime.toFixed(2).padStart(8)}ms |   1.00x   |`);
console.log(`| Chunk Buffering    | ${chunkStats.avgTime.toFixed(2).padStart(8)}ms | ${chunkStats.minTime.toFixed(2).padStart(8)}ms | ${chunkStats.maxTime.toFixed(2).padStart(8)}ms | ${speedupStr.padEnd(20)} |`);
console.log("=========================================================================");
