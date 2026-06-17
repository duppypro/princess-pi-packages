// In-process benchmark: readline (baseline) vs chunk-buffered stdin reading.
// Run: npx tsx extensions/lib/dedup/benchmark.ts
//
// Unlike pi-dedup's benchmark.ts (which spawns a fresh node+tsx child process
// per timed run), this drives both implementations inside the same process
// against synthetic Readable/Writable streams, so process-startup cost isn't
// mixed into the measurement — only the I/O-parsing strategy itself is timed.
import { Readable, Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { runFilterReadline } from "./io-readline.js";
import { runFilterChunked } from "./io-chunked.js";

type Runner = (input: Readable, output: Writable) => Promise<void>;

// ---
// Synthetic fixture: bursts of near-duplicate lines (5-44 lines, varying
// numeric fields) separated by one-off unique lines — mirrors a noisy
// access/error log shape without depending on another worktree's fixture file.
// ---
function generateFixture(targetLines: number): string {
    const lines: string[] = [];
    let n = 0;
    while (lines.length < targetLines) {
        const burstSize = 5 + Math.floor(Math.random() * 40);
        const port = 5000 + Math.floor(Math.random() * 1000);
        for (let i = 0; i < burstSize && lines.length < targetLines; i++) {
            lines.push(`Connection from 192.168.1.${n % 255} on port ${port + i} timeout after ${3 + (i % 5)}s`);
        }
        if (lines.length < targetLines) {
            lines.push(`GET /api/resource/${n} 200 ${100 + (n % 50)}ms`);
        }
        n++;
    }
    return lines.join("\n") + "\n";
}

// Split into ~64KB pieces to mimic real OS pipe chunk sizes — feeding one
// giant chunk would let readline batch-process unrealistically.
function toChunks(data: string, size = 64 * 1024): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += size) chunks.push(data.slice(i, i + size));
    return chunks;
}

function nullWritable(): Writable {
    return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

async function timeRun(fn: Runner, data: string): Promise<number> {
    const input = Readable.from(toChunks(data));
    const output = nullWritable();
    const start = performance.now();
    await fn(input, output);
    return performance.now() - start;
}

async function runBenchmark(fn: Runner, data: string, iterations: number) {
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
        times.push(await timeRun(fn, data));
    }
    const sum = times.reduce((a, b) => a + b, 0);
    return { avg: sum / iterations, min: Math.min(...times), max: Math.max(...times) };
}

async function main() {
    const LINE_COUNT = 17000;
    const ITERATIONS = 5;
    const fixture = generateFixture(LINE_COUNT);

    console.log(`Benchmarking dedup I/O strategies (${LINE_COUNT} lines, ${ITERATIONS} iterations, in-process)\n`);

    // Untimed warmup run for each, so V8 JIT is settled before measuring.
    await timeRun(runFilterReadline, fixture);
    await timeRun(runFilterChunked, fixture);

    const readlineStats = await runBenchmark(runFilterReadline, fixture, ITERATIONS);
    const chunkedStats = await runBenchmark(runFilterChunked, fixture, ITERATIONS);

    const speedup = readlineStats.avg / chunkedStats.avg;

    console.log("Implementation     Avg(ms)   Min(ms)   Max(ms)   Speedup");
    console.log("-".repeat(60));
    console.log(
        `readline (base)     ${readlineStats.avg.toFixed(1).padStart(7)}   ${readlineStats.min.toFixed(1).padStart(7)}   ${readlineStats.max.toFixed(1).padStart(7)}   1.00x`
    );
    console.log(
        `chunk-buffered      ${chunkedStats.avg.toFixed(1).padStart(7)}   ${chunkedStats.min.toFixed(1).padStart(7)}   ${chunkedStats.max.toFixed(1).padStart(7)}   ${speedup.toFixed(2)}x`
    );
}

main();
