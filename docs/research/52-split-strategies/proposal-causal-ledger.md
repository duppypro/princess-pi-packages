# Proposal: Causal Ledger (recursive cause-of-tokens attribution)

*Subagent lens: CAUSAL ATTRIBUTION — preserved verbatim, 2026-07-14*

## 1. Strategy name + core principle

**Causal Ledger.** Every token meter on message N is caused by an identifiable earlier operation, and the transcript logs enough to trace it: `cache_write(N)` is exactly the new material that entered context since the last API call (previous turn's output + tool results + user text — each with a known category); `cache_read(N)` is exactly the accumulated pile of every earlier `cache_write` (verified as an exact integer identity, below); `output(N)` is the message's own blocks, char-countable, with thinking assigned to the action it precedes. So the daemon carries two pieces of state forward — a **pending vector** (what entered context since the last assistant message, per category) and a **history vector H** (per-category composition of everything resident in cache) — and each message's four meters are split by those vectors, then priced per meter via MODEL_PRICING. A Read's cost is not just its own tool_use tokens: it earns the next message's cache_write share for its result, and then a slice of *every subsequent message's* cache_read rent, forever (until compaction). That is the honest causal story of why long-context sessions cost what they do.

**Empirical verification** (session `f2661571…` — Claude, 316 logical turns after dedup by `message.id`):
- **Identity A (exact):** `cache_read(N) = cache_read(N−1) + cache_creation(N−1)` holds as an exact integer equality for **269/315** consecutive turn pairs (misses = compaction/breakpoint/sidechain boundaries). E.g. turn at line 17: cr=11658, cw=9527 → next turn cr=21185, exactly. Cache read is literally accumulated history — attributing it to history is measurement, not modeling.
- **Identity B (approx):** `cache_write(N) ≈ output_tokens(N−1) + (result_chars + user_chars)(N−1)/4`. Median relative error **−13%** (p10 −40%, p90 −1%, n=269) — chars/4 slightly under-tokenizes code and system-reminders aren't counted; normalization absorbs the net error. Exact-case example: out=727 + 130-char Bash result (33 tok) → next cw=**760** (727+33, exact). Big-Read case: out=7704 + 2981-char Read result → next cw=8743, predicted 8449 (−3.4%).
- **Why this lens matters in dollars** (same session, priced at cr=0.1×, cw=1.25×, out=5× input): cache_read = **55.0%** of spend, cache_write = **35.7%**, output = **9.2%**, uncached input = 0.0%. Any strategy that only splits output blocks is arguing about 9% of the money; 91% of the money is caused by *previous* operations, which is exactly what this ledger tracks.

## 2. Per-meter assignment rules

Daemon state per session (carried across messages, in message order):
- `H: {category: tokens}` — composition of the resident cache. Seeded on first message: `H[prompt] = first cache_read` (system prompt + CLAUDE.md; use `other` if you prefer).
- `pending: {category: tokens}` — new context material since the last assistant message. Built from three sources, each already category-mapped:
  - previous assistant message's **output vector** (computed in rule OUT below) — its blocks re-enter context verbatim;
  - each **tool result**: `ceil(result_chars/4)` tokens → the category of the tool_use it answers (existing tool→category map; for file-op tools use the file-based category of that specific call). Use the `tool_result` block content length, **not** `toolUseResult` JSON length (the latter overestimates — Write's local log echoes the whole file while the API result is a one-line confirmation);
  - **user/system text** in user entries: `ceil(chars/4)` → `prompt`.

Per assistant message N (after deduping the multiple JSONL rows that share one `message.id`/usage; sum `iterations[]` sub-usages when present):

**OUT (`output_tokens`).** For each block, visible chars: tool_use → `JSON.stringify(input).length` chars to that tool's category; text → chars to `prompt`; thinking → chars to the category of the **next tool_use in the same message** (the action the thinking preceded), else `prompt`. Claude hides thinking text (blocks log 0 chars): `hidden = max(0, output_tokens − ceil(Σ visible_chars/4))`; assign `hidden` to the category of the **first tool_use** in the message, else `prompt`. Normalize the char-derived block weights + hidden so the vector sums to `output_tokens` → `outVec`. (Pi: thinking chars are visible; no hidden term. Pi `usage.reasoning` if present folds into the same thinking rule.)

**CW (`cache_creation_input_tokens`).** Caused by `pending`. Let `P = Σ pending`. If `cw ≤ 2P`: split cw proportionally to `pending` (normalization to the actual meter absorbs the −13% median tokenization error). If `cw > 2P` (breakpoint moved / 5m-ephemeral expiry re-wrote old history): split `P`-worth by `pending`, split the excess `cw − P` by `H` proportions (it is history re-entering cache, causally owned by history). → `cwVec`.

**CR (`cache_read_input_tokens`).** Rent caused by history: split cr proportionally to `H`. When `Σ H` drifts from cr (it will, slowly), the proportional split self-corrects; no rescale of H needed. → `crVec`.

**IN (`input_tokens`).** Claude: 1–3 tokens/turn (measured 593 total across 316 turns) — assign with `cwVec` proportions (same "new material" stream, uncached); rounding to `prompt` changes nothing. **Pi (uncached sessions, cacheRead/Write = 0):** `input` is the whole resent context, so treat it as cr+cw fused: `newTok = min(input, Σ pending)` split by `pending`; remainder `input − newTok` split by `H`. Pi's `cost.{input,output,…}` dollars are then split by the same token proportions per meter.

**State update.** `H += cwVec` (Pi: `H += pendingVec` scaled to newTok); `pending ← outVec` of this message, then accumulate tool results and user text as they stream in before the next assistant message. **Compaction event:** reset `H` to the new (post-compaction) cache size, preserving the old H's *proportions* (the summary summarizes history in kind); the compaction turn's own output → `compaction` category as today. **Sidechains** (`isSidechain: true`): keep a separate ledger keyed by sidechain, or collapse to `agents` wholesale (matches current behavior; the parent's Task result enters the parent's `pending` as `agents`).

**Pricing.** Per message: `$vec = Σ_meter meterVec × MODEL_PRICING[model][meter]`. Conservation holds by construction — each meter's vector is normalized to the meter's actual token count, so per-message and per-session totals are unchanged from today.

## 3. What it covers vs leaves unattributed

- **cr (55% of $):** split by H — recursively built from measured char counts and exact output meters; measurement fidelity decays with recursion depth but every layer is anchored. Call it *measured composition, assumed tokenization*.
- **cw (36% of $):** components directly measured (prev output = exact meter; result/user chars = exact counts); only chars→tokens proportionality assumed. ~95% measured.
- **out (9% of $):** visible blocks measured; **hidden thinking is the one invented rule** (thinking → next action). On Claude, hidden thinking is often 50–95% of output tokens, so roughly 5–8% of total session dollars ride on that assumption. Rationale: extended thinking is elicited by and spent on deciding the imminent action; assigning it to `prompt` instead would call all deliberation "chat".
- **Residual:** none — normalization means every dollar lands in a category. The residual lives inside the *proportions* (tokenization skew), not as an unassigned bucket. If preferred, emit a per-message `confidence = P/cw` diagnostic instead of a residual category.

Net: **≈91% of dollars split on measured quantities** with a single global assumption (within-message chars/4 proportionality); ~9% governed by the thinking rule.

## 4. Error bounds

- **Provably right:** Identity A (cr = Σ past cw) — exact in 269/315 pairs; total cost conservation (vectors sum to actual meters); tool-result → category linkage (tool_use_id join is exact).
- **Estimated:** chars/4 proportionality. Code tokenizes denser (~3.2 chars/tok) than prose (~4.2), so within a mixed pending set, code-heavy components are under-weighted by up to ~25% *relative*; absolute per-message error is bounded by normalization. Thinking rule: unmeasurable by construction (Anthropic hides the text); worst case, 100% of hidden thinking belongs to a different category than the first tool_use — bounding the skew at that message's hidden-thinking dollars (~9% of total, spread across many messages).
- **Worst-case structural skew:** a giant early Read dominates H and collects rent all session. That is the *intended* causal claim, but note it makes the display path-dependent: identical work in different orders yields different category rents. Compaction proportional-reset caps how long any single operation's rent claim survives.

## 5. Failure modes

- **Cache resets / breakpoint moves / 5m-ephemeral expiry** (the 46/315 non-exact pairs): cw balloons with re-written history. Handled by the `cw > 2P` excess-to-H rule; undetected smaller re-writes silently inflate `pending` categories.
- **Compaction:** H proportions are an approximation of what the summary retained; if the summary drops one category's material disproportionately, its rent share is wrong afterward. Detect via `compaction` entries (both harnesses log them).
- **Session resume / first message with warm cache:** cr > 0 with empty H → the whole warm cache lands in `prompt`. Acceptable; optionally persist H across daemon restarts alongside existing per-session state.
- **Truncated/structured tool results** (images, MCP structured content): char count of the logged block ≠ tokens sent; normalization contains it per-message but skews within-pending proportions.
- **Pi zero-usage assistant rows** (observed, `usage` all 0): skip, but still fold their blocks into `pending` if content exists.
- **Interleaved sidechains** writing to the same file: keying pending/H by sidechain-vs-main is required or results cross-contaminate.
- **Claude `thinking` before parallel tool_use batch:** "first tool_use" rule arbitrarily favors the first of N parallel calls; splitting hidden thinking across all tool_use blocks by args-char share is the easy refinement.

## 6. Cheapness

Yes, comfortably. Per message: O(#blocks) char-length sums, one 13-element float vector add, four normalizations — no tokenizer, no regex over content beyond `.length`. State is two 13-float vectors per live session. Verification script processed the full 4.0 MB / 1788-line session (dedup, both identities, dollar shares) in under one second single-threaded; incremental per-beat work at 667ms is microseconds. The only new bookkeeping vs today's daemon is carrying `pending` and `H` forward, which fits its existing in-order message processing loop.
