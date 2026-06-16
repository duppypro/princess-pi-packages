# Spec: `uniqs` (Uniq Stream) — Dynamic Streaming Log Deduplicator

This specification defines the behavior, architecture, and testing of `uniqs` (previously referred to as `dedupwcount`), a modern CLI utility designed to compress duplicate lines dynamically on standard output from real-time streaming inputs (e.g., `tail -f`).

---

## 1. Make vs Buy Analysis

| Tool | dynamic/In-place Rewriting | Fuzzy/Near-Dup Collapse | Range Accumulation | Periodicity Detection (FFT) | Streaming/Tail Friendly |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`uniq` (standard unix)** | ❌ No | ❌ No | ❌ No | ❌ No | ⚠️ Delayed (requires EOF or stream change) |
| **`uniq -c`** | ❌ No | ❌ No | ❌ No | ❌ No | ⚠️ Delayed (only flushes after value changes) |
| **Chrome DevTools Console** |  Yes (Badge) | ❌ No | ❌ No | ❌ No |  Yes (Browser-bound only) |
| **`pino-pretty` / `bunyan`** | ❌ No | ❌ No | ❌ No | ❌ No |  Yes |
| **`uniqs` (Proposed)** |  **Yes** |  **Yes** |  **Yes** |  **Yes** |  **Yes** |

### Conclusion: **Make**
No existing command-line utility provides real-time, in-place collapsing of identical/near-identical log lines with range-tracking and periodicity analysis. Building a lightweight, fast Node.js/TypeScript-based CLI tool offers maximum value and fits perfectly into the Princess-Pi tooling environment.

---

## 2. Name Proposal
We propose **`uniqs`** (Uniq Stream) or **`squish`** as better names for the tool:
*   **`uniqs`**: Direct reference to Unix `uniq` but with an `s` denoting "stream/streaming". Extremely intuitive for command-line users.
*   **`squish`**: Playful, aligning with Pi's `/smush` extension, suggesting compaction of repetitive logs.
*   *Legacy reference*: We will alias `dedupwcount` to `uniqs` for backwards compatibility.

---

## 3. Features & User Experience (UX)

### Feature A: Live In-place Deduplication
When consecutive identical lines are received via standard input, `uniqs` prints the original line once, and then prints a dynamic, live-updating badge on a sub-line below it, rewriting it in-place using carriage returns (`\r`) and ANSI escape sequences.

**Example Input Stream:**
```text
12:00:01 [INFO] Connected to Database
12:00:02 [INFO] Connected to Database
12:00:03 [INFO] Connected to Database
12:00:04 [INFO] User logged in
```

**Live Terminal Output States:**
1. *After Line 1:*
   ```text
   12:00:01 [INFO] Connected to Database
   ```
2. *After Line 2:*
   ```text
   12:00:01 [INFO] Connected to Database
   ☝️ +1
   ```
3. *After Line 3:* (Line 2 is cleared and rewritten)
   ```text
   12:00:01 [INFO] Connected to Database
   ☝️ +2
   ```
4. *After Line 4:* (The sub-line badge is finalized, and the new line is printed)
   ```text
   12:00:01 [INFO] Connected to Database
   ☝️ +2
   12:00:04 [INFO] User logged in
   ```

---

### Feature B: Fuzzy/Near-Duplicate Matching with Variable Extraction
Logs often differ only by a single variable (e.g., port number, thread ID, timestamp, process ID). If two consecutive lines match in structure but differ only by numbers or specific words, they are treated as "near-duplicates".

`uniqs` decomposes consecutive lines into static templates and variable placeholder slots.

**Example Input Stream:**
```text
Connection failed on port 3001
Connection failed on port 3002
Connection failed on port 3003
```

**Live Terminal Output States:**
1. *After Line 1:*
   ```text
   Connection failed on port 3001
   ```
2. *After Line 2:*
   ```text
   Connection failed on port [3001-3002] ☝️ +1
   ```
3. *After Line 3:*
   ```text
   Connection failed on port [3001-3003] ☝️ +2
   ```

---

### Feature C: Smart Range & Sequence Accumulation
For matching variable slots, `uniqs` collects and analyzes the sequence of values. It formats them based on mathematical properties:
*   **Continuous Monotonic Ranges**: `[3-45]` (smooth increase or decrease)
*   **Gapped Ranges**: `[3-16, 19-45]` (smooth ranges separated by gaps)
*   **Discrete Values**: `[1, 3, 5, 8]`
*   **Directionality**: Detects if values are strictly increasing (monotonic up) or decreasing (monotonic down).

---

### Feature D: Periodicity Detection & Autocorrelation (FFT-like)
To help developers understand the frequency of repetitive logs, `uniqs` tracks the millisecond arrival interval between consecutive duplicate/near-duplicate events.
*   **Simple Periodicity**: If events arrive at a constant interval, it displays `(every 5s)`.
*   **Complex/Multiple Periodicities**: For complex logs, an autocorrelation or discrete Fourier transform (DFT) is executed on the arrival times to detect dominant frequencies, displaying messages like `(every ~12s and ~70s)`.

**Example:**
```text
12:00:01 [ERROR] Backup failed
... (repeats every 10 seconds and 30 seconds)
```
**Finalized Collapsed Output:**
```text
12:00:01 [ERROR] Backup failed
☝️ +120 (every ~10s and ~30s)
```

---

## 4. CLI Configuration & Options

```text
Usage: uniqs [options]

Options:
  -v, --version          output the version number
  -f, --format <string>  custom collapse badge format (default: "☝️ +{count}")
  -s, --similarity <num> similarity threshold between 0.0 and 1.0 (default: 0.85)
  -w, --word-match       use word-based template extraction instead of character-based diffing
  -p, --periodicity      enable advanced periodicity detection
  --no-collapse          disable in-place terminal rewriting (print raw stream with counts when changed)
  -h, --help             display help for command
```

---

## 5. Architectural Design

```
               [stdin Stream]
                     │
                     ▼
             [Line Reader]
                     │
                     ▼
       ┌───────────────────────────┐
       │     Matcher & Template    │
       │         Generator         │◀─── Check similarity with previous line template
       └───────────────────────────┘
                     │
          ┌──────────┴──────────┐
          ▼ Yes                 ▼ No
   [Near-Duplicate]       [New Distinct Line]
          │                     │
          │                     ├──────────────────────────┐
          ▼                     ▼                          ▼
   [Accumulate Slot    [Finalize & Flush Previous]   [Print New Line]
    Values & Time]              │                          │
          │                     ▼                          │
          ▼             [Print Collapsed                   │
   [Rewrite Sub-line]    Summary & Stats]                  │
                                │                          │
                                ▼                          ▼
                        ─────────────────────────────────────
                                     Stdout Terminal
```

### Near-Duplicate Detection Algorithm (The Skeleton Matcher)
To compare consecutive lines `A` and `B` without excessive overhead:
1.  **Word-level Tokenization**: Tokenize lines into words/symbols.
2.  **Structural Fingerprint**: Replace numbers with `{num}` and alphanumeric sequences that differ with `{str}`.
3.  **Similarity Ratio**: If the ratio of matching words to total words exceeds the `--similarity` threshold (default `0.85`), treat them as a template match.
4.  **Slot Extraction**: Extract the differing values and map them to their corresponding slot indices.

### Range Compression Algorithm
Given a sequence of numeric slot values (e.g., `[3, 4, 5, 10, 11, 12, 13, 20]`):
1.  Sort the unique values.
2.  Identify contiguous runs where difference is `1` (or `-1` for descending).
3.  Format as ranges if the run length is $\ge 2$ (e.g., `3-5`, `10-13`).
4.  Join ranges and isolated singletons with commas: `3-5, 10-13, 20`.

### Periodicity Analysis (Autocorrelation)
1.  Store timestamps $t_1, t_2, \dots, t_n$ of matched occurrences.
2.  Compute successive intervals $\Delta_i = t_{i} - t_{i-1}$.
3.  If $n \ge 3$, calculate the mean and standard deviation of $\Delta$.
4.  If standard deviation is very low (<10% of mean), report the interval directly: `every 5s`.
5.  If variance is high, run an autocorrelation function over a set of lag steps to find dominant peak lags. Map peak lags to seconds/minutes and report the top 1-2 periods.

---

## 6. Verification & Test Plan

We will test `uniqs` using automated test suites running mock log streams.

### Test Case 1: Perfect Duplicates
*   **Input**:
    ```text
    Hello
    Hello
    Hello
    World
    ```
*   **Expected Output Log (Final state on standard output)**:
    ```text
    Hello
    ☝️ +2
    World
    ```

### Test Case 2: Near-Duplicates (Single Numeric Slot)
*   **Input**:
    ```text
    Port 8080 active
    Port 8081 active
    Port 8085 active
    ```
*   **Expected Output Log**:
    ```text
    Port 8080 active
    Port [8080-8081, 8085] active ☝️ +2
    ```

### Test Case 3: Mixed Types & Non-Monotonic Numbers
*   **Input**:
    ```text
    Status 200
    Status 500
    Status 200
    Other
    ```
*   **Expected Output Log**:
    ```text
    Status 200
    Status [200, 500] ☝️ +2
    Other
    ```

### Test Case 4: Periodicity Detection
*   **Input**: (Events arriving at exactly 2000ms intervals)
    ```text
    [t=0s] Heartbeat ok
    [t=2s] Heartbeat ok
    [t=4s] Heartbeat ok
    ```
*   **Expected Output Log**:
    ```text
    Heartbeat ok
    ☝️ +2 (every ~2s)
    ```
