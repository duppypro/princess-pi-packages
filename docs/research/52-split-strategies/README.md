# #52 research: sub-turn proportional cost attribution — experiment results

Date: 2026-07-14 · Branch: `52-phase3-overhead-classes` · Status: research complete, decision pending

## Question (Duppy)

All-or-nothing turn classification presents false confidence: a turn doing several
things bills 100% to one category. Is proportional sub-turn splitting practical?
What do the meters actually support? What are the error bounds?

## Method

- Five independent subagents, each designing a strategy through a distinct lens
  (content-size accountant, causal attribution, bounded-error minimalist,
  cache-rent economist, plus a skeptic quantifying the baseline's error).
  Full proposals preserved verbatim in this directory.
- Strategy-agnostic feature extractor (`research/split-strategies/extract-features.ts`)
  verified against production totals (matches wtft to the cent after message-id dedup).
- Three-way comparison (`research/split-strategies/run-comparison.ts`):
  **baseline** (production latest-stage-wins) vs **assay** (split only meter-proven
  slices) vs **ledger** (rent-on-deposits synthesis of the three ledger proposals),
  run on three real sessions (2 Claude, 1 Pi/gemini). All strategies conserve
  session cost exactly.

## Facts established (all measured, multiple agents converged independently)

1. **The billing unit is the API call, and one call almost never mixes tool
   categories**: strict-mixed messages = 0%, 0%, 0.5% of session cost across the
   three sessions. The motivating scenario (spec-read + code-write + git in one
   turn) does not exist at the billing level — those are 3 separate billed calls.
2. **Dollars a sub-turn splitter can move: 1.9–4.0% per session**, nearly all of
   it prompt↔action reshuffling (a definitional choice, not an error).
3. **85–92% of session dollars are cache economics** (cache_read 42–62%,
   cache_write 0–47%, Pi input 32%): turn-level context properties invariant
   under any within-turn split.
4. **The cache is an append-only ledger, provably**: `cache_read(N) =
   cache_read(N−1) + cache_write(N−1)` holds as exact integer identity for
   85–91% of consecutive turn pairs.
5. **Recache events** (Claude Code rewriting the whole context into the 1h tier:
   `input≤16`, `e1h == cache_creation ≈ prev context`, cache_read collapses to
   system prefix) are **13.7–39.1% of Claude session cost**, currently billed to
   whatever category the neighboring turn ran. Detection is exact meter
   arithmetic (5-condition conjunction), zero estimation.
6. **The fixed harness prefix** (system prompt + tool schemas + CLAUDE.md,
   68–90k tokens) collects 18–25% of session dollars as rent.
7. Char-share attribution is near-exact where content is visible (r=0.98
   no-thinking output; r=0.9994 incremental cache writes) but visible content
   explains only a **median 38% of cache_write** (unlogged system-reminders,
   attachments) and Claude hides thinking (50–95% of output tokens invisible).

## Results (per-category $ share, three strategies)

### f2661571 (Claude, $58.57, 316 msgs)

| category | baseline | assay | ledger |
|---|---|---|---|
| plan | 3.9% | 1.2% | 0.2% |
| spec | 5.8% | 5.8% | 15.7% |
| code | 10.9% | 8.7% | 19.7% |
| git | 19.2% | 10.8% | 9.2% |
| prompt | 22.3% | 11.6% | 17.7% |
| compaction | 0% | 0.4% | 0.5% |
| **recache** | 0% | **39.1%** | 0% |
| **overhead** | 0% | 0% | **20.4%** |
| other | 32.0% | 16.4% | 13.4% |

### 8548d7f1 (Claude, $36.13, 193 msgs)

| category | baseline | assay | ledger |
|---|---|---|---|
| prompt | 32.7% | 25.3% | 24.2% |
| recache | 0% | 13.7% | 0% |
| overhead | 0% | 0% | 23.7% |
| other | 44.4% | 40.9% | 37.2% |

(work categories shift ≤4pp)

### Pi/gemini (5.6M, $63.93, 1202 msgs)

| category | baseline | assay | ledger |
|---|---|---|---|
| spec | 5.5% | 5.5% | 11.1% |
| code | 44.0% | 43.8% | 38.4% |
| git | 13.3% | 13.2% | 3.5% |
| prompt | 10.5% | 11.0% | 27.5% |
| other | 23.1% | 23.0% | 10.0% |

Assay ≈ baseline on Pi (no cache-write meter to assay). Ledger redistributes
substantially — git shrinks 4× (git turns were paying rent on context others
deposited), prompt grows 2.6× (user text + narration rent).

## Interpretation

- The within-turn "false confidence" is real but tiny (≤4% movable). The BIG
  false confidence is baseline billing **13–39% of Claude session cost
  (recache + compaction) to work categories** when it is context maintenance —
  and that fix requires no estimation at all.
- The ledger view is coherent and answers a different question ("what content is
  the money paying for" vs "what were we doing when it left"). Its variation vs
  baseline is large (±10–20pp per category) but rides on modeled composition
  (~38–55% of deposits directly measured). If shipped, it should be a separate
  view (`--by=rent`), never a silent replacement.
- Skeptic's re-decision thresholds for per-tool splitting: adopt only if
  strict-mixed cost share > 5% or movable dollars > 10%. Today: 0–0.5% and
  1.9–4.0% — an order of magnitude below.

## Recache trigger analysis (2026-07-14, follow-up — `debug/recache-trigger-analysis.mjs`)

Question (Duppy): is recache caused by model change, effort change, wall-clock gaps,
or an under-the-hood cheaper-model swap?

Measured over 16 recache events across 3 Claude sessions:

| Candidate trigger | Verdict | Evidence |
|---|---|---|
| Model change (incl. hidden/mode routing) | **Ruled out** | `message.model` (API *response* side — a server swap would show) identical across all 16 events; one model id per session; a per-model cache swap would leave the old cache idle, not rewrite it |
| Effort/thinking change | No signal | No mode/effort command entries adjacent to any event |
| Branch jump (resume/rewind fork) | **Ruled out** | 0/16 events; 15 branch jumps on normal turns caused no recache |
| Compaction | Excluded by signature | separate marker, separately tracked |
| **Wall-clock gap (1h TTL expiry)** | **Primary: 11/16** | every event gap > 65min exceeds the 1h tier; control turns p90 gap = 0.7–3min |
| **Early-context mutation** | **Secondary: ≥3/16 confirmed** | memory-file/MEMORY.md writes in the turns immediately preceding short-gap (0.1–19min) recaches; 2–3 short-gap events remain unexplained (invisible client-side prefix change suspected) |

Structural finding: at every recache the *surviving* cache_read is a constant
~11–16k tokens per session — smaller than the session bootstrap and alive even
after 23h gaps. That is the **static harness prefix** (system prompt + tool
schemas), shared byte-identical across all sessions org-wide and kept warm by
other traffic. Recache = death of the *session-specific* segment only, either by
TTL (idle > 1h) or by content invalidation at the segment's front — where
CLAUDE.md and the memory files are injected, which is why a mid-session memory
write on a 250k-token context can instantly cost a full context rewrite
(~250k × cache-write rate).

Practical levers: resuming a big session after >1h costs one recache (unavoidable,
now visible); mid-session memory/CLAUDE.md writes on large contexts trigger
avoidable recaches (batch them, or accept the known price).

## Recommendation

1. **Adopt now (Phase 3 scope):** compaction meter-split (already approved) +
   **recache detection** as a T1-exact overhead class. Both are meter arithmetic,
   cheap at beat rate, and move the largest honestly-movable dollars.
2. **Decline:** per-tool proportional splitting within turns (moves ≤0.5%
   cross-category; thresholds not met). Optional cheap add: text/thinking→prompt
   carve of the output meter (±30% error on 2–5% of cost).
3. **Road for later:** `--by=rent` ledger view as its own issue if the "what is
   my context costing me" question earns a chart.
