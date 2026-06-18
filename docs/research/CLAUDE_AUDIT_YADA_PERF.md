# Audit: yada's claimed 32.7x speedup from chunk-buffered stdin

**Auditor:** Claude, working the same GitHub issue (#4) in a parallel worktree (`claude-dedup`)
**Subject:** `bin/yada.ts` commits `ce36599` and `452d605`, and `SPEC_YADA.md`/`SPEC_YADA.html`'s performance section
**Verdict:** The 32x number is real, but mis-attributed. It came from skipping redundant per-line analysis recomputation, not from switching `readline` to chunk-buffered `stdin` reading. The benchmark that produced the number also can't currently be run by anyone else, because it references a file that was never committed.

This is written to be actionable — three concrete fixes are listed at the bottom.

## Finding 1: The benchmark referenced in the spec cannot run

`tests/benchmark.ts` (originally `test/benchmark.ts`, commit `ce36599`) line 13:
```js
const yadaReadlineBin = path.join(process.cwd(), "bin/yada-readline.ts");
```
`bin/yada-readline.ts` has never existed in this repo's history (`git log --all -- '*yada-readline*'` returns nothing). Running the benchmark as committed throws:
```
Error: Cannot find module '.../bin/yada-readline.ts'
```
So the 32.7x figure recorded in the spec is not reproducible from what's actually in the repo — whoever ran it originally must have had a local, uncommitted `yada-readline.ts` that got lost before committing.

## Finding 2: Two unrelated changes got bundled under one "32x speedup" claim — only one of them is the real fix

**Commit `ce36599`** ("Implement high-performance chunk-based stream reader and benchmark") replaced `readline.createInterface` with manual `stdin.on("data")` + leftover-buffer line splitting. This is purely an I/O-layer change — it affects how bytes become lines, nothing else.

**Commit `452d605`** ("Optimize yada stream processing to O(N) and achieve 32x speedup on 17k lines") — the entire diff to `bin/yada.ts` is:
```diff
-    renderBlock(activeBlock);
+    if (isTTY && !isFastMode) {
+      renderBlock(activeBlock);
+    }
```
`renderBlock()` recomputes range formatting *and* periodicity/autocorrelation analysis (`analyzePeriodicity` scans the entire timestamp array on every call) each time it runs. Before this guard, it ran on **every duplicate line**, even in non-interactive/redirected mode (`cat file | yada`). For a burst of N duplicate lines, that's O(1)+O(2)+...+O(N) = **O(N²)** work for that one burst. The guard makes `renderBlock` only run when actually needed for live TTY output, restoring O(N) behavior.

This fix is entirely orthogonal to the I/O reading strategy — it would have produced the same speedup with `readline` left in place untouched.

## Finding 3: Empirical check — the I/O swap alone is worth ~3-5%, not 32x

To isolate the two changes, the chunked-stdin swap alone (without the render-skip fix, since this codebase never had that bug) was ported into `claude-dedup`'s own dedup tool and benchmarked **in-process** against a `readline` baseline — avoiding subprocess-spawn overhead, which dominates timing at this scale and is a likely secondary reason the original subprocess-based benchmark methodology produced unreliable numbers even before hitting the missing-file error.

| Lines | readline | chunked | speedup |
|---|---|---|---|
| 17,000 | ~30–35ms | ~28–34ms | 1.01–1.05x |
| 300,000 | ~508ms | ~495ms | 1.03x |

The ratio holds flat from 17k to 300k lines. If `readline` itself were the source of an O(N²) blowup, this ratio would widen sharply with N — it doesn't, which independently confirms `readline` was never the actual bottleneck.

Source for this comparison: `claude-dedup`'s `extensions/lib/dedup/io-readline.ts`, `io-chunked.ts`, and `benchmark.ts` (in-process, synthetic 17k/300k-line fixtures, 5 iterations + 1 warmup).

## Recommendations

1. **Fix the benchmark** — either commit a real `bin/yada-readline.ts` baseline, or rewrite `tests/benchmark.ts` to not reference a nonexistent file. As-is, the headline performance claim is unverifiable by anyone who isn't the original author's exact local state.
2. **Re-attribute the speedup** in `SPEC_YADA.html`/commit messages: the win is "skip redundant render-time analysis recomputation in non-interactive mode" (`452d605`), not "chunk-buffered stdin reading" (`ce36599`). Both changes are reasonable to keep, but only one explains the measured number — readers will draw the wrong lesson otherwise (e.g. "always replace readline with manual chunking for perf," which this data doesn't support).
3. **Benchmark in-process, not via subprocess spawn**, when measuring something this fast. Driving the parsing function directly against an injected stream (`Readable.from(...)`) eliminates node/tsx startup cost from the measurement entirely, which otherwise can swamp a real-but-small difference (or, as happened here, hide the fact that the harness can't even run).

## Reproduction
```bash
# Finding 1 — benchmark is broken:
cd pi-dedup && npx tsx tests/benchmark.ts   # -> Cannot find module bin/yada-readline.ts

# Finding 2 — see the actual one-line fix:
git show 452d605 -- bin/yada.ts

# Finding 3 — in-process comparison:
cd claude-dedup && npx tsx extensions/lib/dedup/benchmark.ts
```
