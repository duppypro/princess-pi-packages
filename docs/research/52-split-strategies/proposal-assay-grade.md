# Proposal: Assay-Grade Attribution (split only what the meters prove)

*Subagent lens: THE BOUNDED-ERROR MINIMALIST — preserved verbatim, 2026-07-14*

## 1. Strategy name + core principle

**Assay-Grade Attribution.** A message's cost is split across categories only where the transcript contains a *near-exact measurement* of the split — a meter equality or a fully-logged content decomposition of the exact tokens that meter billed. Everything else stays whole at the turn-level category (the status quo, which is honest as a billing floor), or moves to an explicitly-rendered overhead bucket when the meters prove the cost was context maintenance rather than work. Every split ships with a tier label: **T1 = exact** (meter arithmetic, error ≈ 0), **T2 = bounded** (char-share of fully-logged output blocks, error ≤ ±30% relative), **T0 = whole** (no split, no new error introduced). The chart renders T0 exactly as today; the strategy never converts confident-but-wrong into confident-looking pixels.

Measured on the three real sessions, these rules split **~30–40% of Claude session cost** at T1/T2 confidence and leave 60–70% whole; on the Gemini-backed Pi session only ~6% is splittable (no cache-write meter to assay).

## 2. Per-meter assignment rules

Definitions per logical assistant message *m* (Claude: dedup JSONL lines by `message.id`, main chain and each sidechain treated as separate context chains; Pi: each `role:"assistant"` entry): `it, ot, cr, cw` = input/output/cache_read/cache_write tokens; `e1h` = `cache_creation.ephemeral_1h_input_tokens`; `prev_ctx = it+cr+cw` of the previous message *in the same chain*; `blocks` = content blocks with char counts; `cat(b)` = existing per-tool→category map; `turn_cat` = existing latest-stage-wins turn category.

**OUTPUT (`ot × out_rate`):**
1. **Redaction guard (T0):** if `Σ block_chars / 4 < 0.5 × ot`, the log doesn't contain what was billed (observed: re-cache turns bill 2,873 thinking tokens against an empty `thinking` string). Whole meter → `turn_cat`.
2. **No tool blocks (T1):** whole meter → `turn_cat` (prompt). Exact — nothing to split.
3. **All tool blocks in one category C (T1 + optional T2):** meter → C. *T2 carve-out:* move `(text_chars + thinking_chars) / Σ block_chars × ot` to `prompt`. The blocks *are* the billed output, so the proportion is grounded; the only error is tokenizer-density variance between prose and code/JSON (≈3.2–4.6 chars/token → ≤ ±30% relative on the carved slice).
4. **Tool blocks in ≥2 categories (T2):** char-share across categories + prompt, scaled to `ot`. Empirically nearly irrelevant: 0.4% / 0% / 0% of output cost in the three sessions — **one API call almost never mixes tool categories**.

**CACHE_WRITE (`cw × cw_rate`):**
1. **Compaction (T1, existing):** compaction-flagged turn → `compaction`.
2. **Re-cache signature (T1, new):** all of — `cw > 30k` ∧ `e1h == cw` ∧ `it ≤ 16` ∧ `cr < 0.2×(cr+cw)` ∧ `|(cw+cr) − prev_ctx| < 0.15×prev_ctx` ∧ `len(usage.iterations) ≤ 1`. This is Claude Code rewriting the *entire prior context* into the 1h cache tier (cache_read collapses to the ~16k system prefix; cache_creation reproduces the previous context to within 15%). Assign `cw × cw_rate` to an explicit **`recache`** overhead bucket (render like compaction); the message's other meters follow their own rules. In session f2661571 this is 11 events = 83.8% of all cache-write tokens = **29.9% of the entire $48 session**, currently silently attributed to whatever tool the neighboring turn ran.
3. **Everything else (T0):** whole meter → `turn_cat`. Reconciliation on real sessions kills the component split: predicted inter-turn delta has **median predicted/actual = 0.36–0.38** — the API writes ~2.6× what the logged conversation accounts for (unlogged system-reminders, file-state attachments, queued injections). Only 0–3% of turns reconcile within ±33%. No defensible error bar exists → no split.

**CACHE_READ (`cr × cr_rate`) — T0, never split.** It is the price of carrying *all prior history* to take this turn's action; no measurement in the transcript apportions history to this turn's sub-operations. Whole meter → `turn_cat` (status quo).

**INPUT (`it × in_rate`) — T0.** Claude: ~0–0.4% of cost. Pi/Gemini (implicit caching): `input` is uncached context resend — same ambiguity as cache_read → `turn_cat`.

**Server tool fees (T1):** `server_tool_use.web_search_requests × per-request rate` → `web`. Exact count, exact price (already handled; keep).

## 3. What it covers vs leaves unattributed

| Session | T1 exact | T2 bounded (±30%) | T0 left whole at turn category |
|---|---|---|---|
| f2661571 (Claude, $48.22, 316 msgs) | **37.2%** (recache 29.9 + compaction 0.3 + output whole-meter 7.0) | 2.1% (output text carve) | 60.7% (cache_read 54.3 + residual cw ~6 + input) |
| 8548d7f1 (Claude, $18.38, 193 msgs) | **26.8%** (recache 10.3 + compaction 0.6 + output 15.9) | 4.9% | 68.3% |
| Pi juice (Gemini, $63.06, 1202 msgs) | **3.1%** (output whole-meter) | 3.0% | 93.9% (input 32.4 + cacheRead 61.5) |

The residual is not a new "unattributed" smear — it stays exactly where today's chart puts it (turn category), so the chart's change is purely additive: a new `recache` overhead segment plus finer output attribution.

## 4. Error bounds

- **T1 recache/compaction:** $ amount is meter × published rate — exact. Detection false-positive requires a genuine work turn to satisfy a 5-way meter conjunction including `cw+cr` reproducing the previous context within 15% — not observed; probability negligible. False negatives just leave cost at turn level (fails safe).
- **T1 output whole-meter:** exact by construction. Only inherited error is the tool→category map itself (shared with the status quo).
- **T2 char-share:** numerator and denominator come from the same fully-logged block set scaled to the true meter, so absolute tokenization error cancels; residual error is *differential* density. Worst-case relative skew ±30% on slices worth 2–5% of session cost → **≤ ±1.5% of total session cost**, the strategy's entire worst-case introduced error.
- **T0:** introduces zero error (no split made).

## 5. Failure modes

- **Harness version drift:** the recache signature depends on current Claude Code cache behavior (1h tier, whole-context rewrite, `it≤16`). A client update that changes the pattern silently drops rule coverage to zero — degrades to status quo, never misattributes. Mitigation: log signature hit-rate; alert if a session has `cw` cost >20% with zero recache/compaction hits.
- **`iterations[] > 1`:** aggregated usage across several API calls could blend a recache into a work turn and blur the signature. Guard is explicit (`len(iterations) ≤ 1`); observed n=1 on all 509 sampled messages. If multi-iteration usage appears, apply rules per-iteration instead.
- **Redacted/empty thinking blocks:** billed output tokens absent from the log break char-shares; the redaction guard detects this from the meters themselves and falls back to T0.
- **Sidechains/subagents:** `prev_ctx` must be tracked per chain (`isSidechain` + parent lineage); crossing chains fabricates recache matches.
- **Pi + Anthropic models:** Pi's `cacheWrite` meter exists but the recache conjunction is Claude-Code-specific; until a Pi signature is verified, Pi cache_write stays T0.

## 6. Cheapness

Yes, comfortably within the 667ms beat. Per new assistant message: one pass over content blocks for char counts (already parsed for classification), ~20 comparisons/multiplications for the meter rules, and one remembered scalar per chain (`prev_ctx`). No lookahead, no cross-message reflow. Memory: O(#chains) scalars.

## Summary of findings

- **Biggest single discovery:** Claude Code periodically rewrites the entire conversation into the 1h cache tier. In session f2661571 this is **29.9% of total session cost** ($14 of $48) currently misattributed to work categories. Detecting it is a 5-condition meter conjunction — exact, cheap, fails safe.
- **Proportional cache_write splitting is indefensible:** logged inter-turn content predicts only ~38% of actual cache-write tokens (median).
- **Output splitting barely needs proportions:** 99.6–100% of output cost sits in messages whose tool calls are single-category.
- **Coverage:** ~30–40% of Claude session cost splittable at high confidence; ~6% for the Gemini Pi session; the remainder (dominated by cache_read at 50–62%) stays at turn level, unchanged from today.
