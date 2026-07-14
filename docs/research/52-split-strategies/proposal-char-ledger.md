# Proposal: The Char-Ledger — strict content-size proportional attribution

*Subagent lens: THE CONTENT-SIZE ACCOUNTANT — preserved verbatim, 2026-07-14*

## 1. Strategy name + core principle

**Char-Ledger Proportional Attribution.** Every billed token is the tokenization of concrete bytes that appear somewhere in the transcript; therefore every meter is divided by the character-shares of exactly the content that generated it — tool_use argument bytes, text/thinking bytes for `output`; the delta appended since the previous API call for `cache_write`/`input`; the cumulative context prefix for `cache_read`. Cost is conserved (splits always sum to the billed meter, priced per-meter via MODEL_PRICING), never re-estimated. Where bytes exist, attribution is measurement; where they don't (hidden reasoning, system-prompt overhead), the residual is labeled — never silently smeared.

**Measured evidence (from the three real sessions):**

| Prediction | Session | n | Pearson r | chars/token median (IQR) |
|---|---|---|---|---|
| output_tokens vs message content chars, **no thinking blocks** | f2661571 / 8548d7f1 | 127 / 33 | **0.98 / 0.98** | 1.93 [1.34,2.44] / 1.88 |
| output_tokens vs content chars, **with thinking** (Claude summarizes thinking in transcript) | f2661571 / 8548d7f1 | 189 / 160 | 0.53 / 0.71 | 0.64 / 0.95 |
| output vs content chars, Pi/gemini (thinking fully logged) | Pi session | 1188 | **0.90** | 2.85 [2.16,3.34] |
| cache_creation vs (prev asst content + tool results)/4, **incremental subset** | f2661571 / 8548d7f1 | 227 / 119 | **0.9994 / 0.88** | — |
| cache_creation vs same, **all calls** (rebuilds dominate) | f2661571 / 8548d7f1 | 315 / 192 | 0.13 / 0.26 | — |
| cache_read vs cumulative context chars | f2661571 / 8548d7f1 | 315 / 193 | 0.78 / 0.56 | 1.80 / 2.79; intercept 90k / 68k tok |
| Pi per-call input-delta vs pending chars | Pi session | 965 | 0.04 (noisy per-call; median 3.58 chars/tok is centered) | — |

Dollar composition at Anthropic rate ratios (in=1, cw=1.25, cr=0.1, out=5): **cache_read 50–55%, cache_write 30–36%, output 9–20%, input ≈0%.** Also verified: Claude Code repeats identical `usage` on every per-block entry sharing one `message.id` — usage MUST be deduped by `message.id` or every meter is over-counted ~2–3×; and 91–92% of cache_write tokens come from cache *rebuilds*, not the current turn's delta.

## 2. Per-meter assignment rules

**Shared machinery.**
- `cat(block)`: tool_use → existing tool→category map; text → `prompt`; tool_result → category of the tool_use it answers (track `tool_use_id` → category).
- `CPT` (chars-per-token): calibrated per session as the running median of `content_chars / output_tokens` over **no-thinking** assistant messages (measured ~1.9 Claude, ~2.9 Pi/gemini); fallback 2.0 until 5 samples exist. One constant, applied to all categories.
- **Context ledger** `L[cat]`: running char totals of everything appended to the conversation, in order: user text → `prompt`; tool_result chars → its tool's category; assistant text → `prompt`; tool_use args → tool's category; thinking chars → same-message non-thinking shares (assumption). Plus a fixed `overhead` entry = first API call's `cache_creation + input` tokens × CPT (the system prompt + tool schemas + CLAUDE.md; measured 68–90k tokens). At a compaction event, reset `L` to `{compaction: summary_chars, overhead: unchanged}`.
- Dedupe usage by `message.id`; sum content chars across all entries sharing the id. Skip `isSidechain` entries into a separate per-sidechain ledger.

**output_tokens** (9–20% of $): `share(cat) = chars of the message's blocks mapped to cat / total visible chars`; `$out × share`. Thinking bytes (Pi: full; Claude: summary) count toward the same-message split pro-rata over non-thinking blocks — *assumption*: reasoning serves the actions it emits. The hidden-reasoning excess (`output_tokens − visible_chars/CPT`, Claude only) rides the same pro-rata split, but is tracked as an `estimated` sub-total so the UI can hatch it.

**input_tokens** (≈0–0.4% of $): the uncached suffix ≈ the delta items appended since the last call; split by their char-shares. Negligible either way — measured 590 tokens across an entire 4MB session.

**cache_write** (30–36% of $): compute `E = delta_chars/CPT` where delta = previous assistant message content + all tool results/user text since the previous API call.
- If `cc ≤ 2E + 500` (**incremental**, 60–72% of calls, 8–9% of cw tokens): split `cc` by delta-item char-shares. This is the lens at its most honest — r=0.9994.
- Else (**rebuild**, 91–92% of cw tokens): assign `min(cc, E)` to delta shares; split the excess by the context ledger `L` shares including `overhead`. Rationale: a rebuild literally re-tokenizes the prefix, and the prefix's byte composition is fully measured; "the 10k-char spec you keep in context costs you again at every rebuild" is a true statement about marginal cost.

**cache_read** (50–55% of $ — the meter that decides the chart): split each message's `cr` by ledger shares `L[cat]/ΣL` *at that call*, including `overhead`. The measured intercept says **30–45% of cache_read dollars (≈18–25% of total session $) are the fixed harness prefix** — the ledger routes that to `overhead`, not to any work category. r=0.78/0.56 with a correct slope; residual comes from hidden thinking in the prefix and mid-session shape changes.

Pi/gemini (no cache): all context bills as `input`; apply the cache_read rule (ledger split) to `input` instead. Per-call deltas are noisy (r=0.04) but the ratio is centered (3.58 chars/tok), so aggregate category totals are unbiased.

## 3. What it covers vs leaves unattributed

By dollars, typical Claude session: **~55–65% assigned by direct byte measurement** (visible output ≈ 6–14%, incremental cache_write ≈ 3%, cache_read/rebuild content portion via ledger ≈ 45–55% — ledger is byte-measured, though "re-read cost belongs to whoever put the bytes there" is an attribution *policy*, flagged as such). **~18–25% explicitly routed to `overhead`** (system prompt slice of cache_read/rebuilds) — visible as its own bar, not smeared. **~8–15% assigned by labeled assumption** (hidden-reasoning excess pro-rata; thinking-byte routing). Residual token mismatch (CPT error) is absorbed by proportional scaling, so conservation holds exactly.

## 4. Error bounds

- **Provably right:** conservation (Σ splits = billed $, always); the per-meter price weighting; incremental cache_write attribution (r=0.9994); no-thinking output attribution (r=0.98).
- **Estimated:** single CPT across categories. Measured per-message chars/token IQR [1.3, 2.4] ⇒ prose vs dense JSON tokenize up to ~1.8× apart; worst-case relative skew *between two categories inside one mixed message* ≈ ±30–45%. Across a session it averages down.
- **Worst-case skew:** a thinking-heavy message (median: visible bytes explain only 35–50% of output tokens) that reasons about the spec but emits one small Bash call sends ~2× its fair output cost to `git`. Bounded by output being ≤20% of $. Ledger attribution of cache_read means a category that dumped 200k chars once (e.g. a giant `grep` result) keeps accruing read-cost forever — arguably correct, but it will surprise users; worst case a single early mega-result dominates all later cache_read splits.

## 5. Failure modes

- **Usage duplication:** not deduping by `message.id` inflates everything 2–3× (verified in both Claude files). Hard requirement.
- **Compaction:** ledger diverges from the real prefix unless reset at the compaction boundary; missing the event mis-attributes all subsequent cache_read.
- **Base64/images in tool results:** bytes ≫ tokens (vision pricing differs); must cap media blocks or count them at a media-specific ratio, else they hijack ledger shares.
- **Signature fields:** Pi `textSignature` / Claude thinking signatures are large base64 that are *not* billed content — must be excluded from char counts.
- **Truncated tool results** in the transcript (some MCP outputs) undercount their category.
- **Model switch mid-session:** CPT and MODEL_PRICING both change; recalibrate per model id.
- **Sidechains/subagents:** interleaved entries corrupt the ledger unless partitioned by `isSidechain`/session.
- **Zero-visible-content messages** (interrupted, pure-thinking): no bytes to split → fall back to current all-or-nothing category.

## 6. Cheapness at 667ms beat

Yes, comfortably. Everything is a single ordered pass with O(bytes) string-length arithmetic — no tokenizer, no lookback beyond one previous message, plus a 13-float ledger and a per-`message.id` dedup set (bounded, evictable after each turn completes). Memory: ledger + CPT samples + open message groups ≈ a few KB per session.

**Honest limit of this lens:** it is excellent exactly where bytes exist (output without hidden reasoning, incremental cache writes — r 0.98–0.999) and it degrades to *policy* where they don't (rebuilds, prefix re-reads, hidden reasoning). Its real contribution over all-or-nothing is not precision on the output meter — it's that it forces ~20% of session dollars out of work categories and into a visible `overhead` bar, and prices the "long-lived context is rent" effect that latest-stage-wins hides completely.
