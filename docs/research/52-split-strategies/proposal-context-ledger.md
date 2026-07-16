# Proposal: The Context Ledger (cache-rent attribution)

*Subagent lens: THE CACHE-RENT ECONOMIST — preserved verbatim, 2026-07-14*

## 1. Strategy name + core principle

**"The Context Ledger."** Every token in the context window was *deposited* by some past sub-operation, and `cache_read` is *rent* charged on the entire accumulated ledger every subsequent API call until compaction (or TTL expiry) evicts it. The strategy maintains a running per-session ledger `L: category → deposited tokens`. Each message's `cache_write` is a deposit event, split among the sub-operations that put content into context this turn and credited to their categories; each message's `cache_read` is a rent payment, split across the ledger's *current composition* — so the 40k-token spec read at turn 5 keeps charging the "spec" category rent on every one of the next 300 turns. `output` and `input` remain turn-local, split by char share among the message's own blocks. Compaction closes the books: the ledger is wiped and the summary is a fresh deposit. Nothing depreciates before eviction, because the API's meter doesn't depreciate: byte 1 of turn 1 costs exactly as much rent at turn 300 as fresh content — the ledger only mirrors the landlord.

This is grounded in a verified identity, not metaphor: on the sampled session, `cache_read(N) = cache_read(N-1) + cache_creation(N-1)` held within 2% for **588/646 entries (91%)** — the cache is literally an append-only ledger and rent is charged on its running total.

## 2. Per-meter assignment rules

State per session (and per sidechain — Task agents have separate contexts, keep one ledger each): `L` (13 floats, one per category), `pending` (list of `{chars, category}` accumulated since the last assistant API call), `d` (tokens-per-char density estimate, EMA, init **0.29** — assumption: midpoint of prose ≈ 1/4 and code/JSON ≈ 1/3).

**Preprocessing (required):** dedup assistant entries by `message.id` — Claude Code writes one JSONL line per content block, repeating the same `usage`. On the sample session, 646 assistant entries collapse to 325 API calls; skipping this doubles every meter.

**Event ingestion (between assistant calls):**
- Each `tool_result` (user-type entry): push `{chars: len(content), category: toolCategory(matching tool_use)}` to `pending`. Uses the *existing* per-tool→category mapping, including latest-stage-wins for file ops (a Read of `spec.md` → spec, Write of `foo.test.ts` → tests).
- User text (typed prompt or system-reminder): push `{chars, category: "prompt"}`.
- The previous assistant message's own blocks also deposit (they re-enter the next request): each `tool_use` block → `{chars: len(JSON.stringify(input)), category: toolCategory}`; `text`/`thinking` block chars → spread pro-rata over that message's tool categories, else the turn's fallback category.

**Per assistant API call with usage `u`, model pricing `P` (per-meter rates from `MODEL_PRICING`, tier-resolved as today):**

- **`cache_write`** (deposit event): for each pending item, `explained_i = chars_i × d`. If `Σ explained > u.cw`, rescale pro-rata to sum to `u.cw`. `residual = u.cw − Σ explained` → category **"other"** (this is unlogged harness injections — per-request system-reminders, file-state notices, thinking signatures — plus tokenizer slack; attributing it to visible ops would launder harness overhead into user categories). Credit `L[k_i] += explained_i`, `L[other] += residual`. Dollar split of `u.cw × P.cacheWrite` follows the same proportions. Update `d ← 0.9·d + 0.1·clamp(u.cw / Σchars, 0.15, 0.5)` when `Σchars > 1000`.
- **`cache_read`** (rent event): `$rent = u.cr × P.cacheRead`, split across categories proportional to `L[k] / ΣL`. First call of a session has `cr=0` and a large `cw` (system prompt + tool defs + CLAUDE.md): that bootstrap deposit goes to **"other"** (harness), measured exactly.
- **`output`**: `$ = u.out × P.output`, split by char share among this message's own blocks: `tool_use` → its tool's category; `text`/`thinking` → pro-rata over the message's tool categories, else fallback category. (Claude hides reasoning inside `output_tokens`; char share of the *visible* thinking block is the best offline proxy — assumption.)
- **`input`**: 100% to the turn's fallback category. Measured median on the sample: **2 tokens/call** (0.0% of $) — any rule is fine; don't spend code on it.

**Books-balancing (chain maintenance):** after each call, set `ΣL := u.cr + u.cw` by scaling all of `L` proportionally (composition preserved). This pins the ledger to the meter via the verified identity, absorbing TTL expiry re-writes and small drift without composition damage.

**Compaction:** on `compact_boundary` (Claude logs it with `compactMetadata.preTokens`; sample: `preTokens=717518`, next call `cr=0, cw=43411` — the summary is 6% of what it replaced): wipe `L`, deposit the post-boundary `cw` to **"compaction"**. All subsequent rent on the summary accrues to compaction — truthful: the original depositors' liability is extinguished; everyone now rents the summarizer's condensation. *Option (labeled assumption): carry forward the pre-compaction composition into the summary deposit, on the theory that the summary re-encodes spec/code content proportionally. Rejected as default — it's unfalsifiable from the transcript, and tagging it "compaction" makes compaction's cost-shifting visible in the chart, which is the point of the category.*

**Pi / non-caching providers:** the sampled Pi session (gemini) has `cacheRead=0, cacheWrite=0` — the full context is re-sent as `input` every call. Same ledger, different meter: split `input × P.input` by ledger composition, with `pending` deposits tracked in chars only (`ΣL := chars-model`, no meter to rebalance against; when Pi provides `cost.*` in dollars, use those directly as the per-meter totals). The lens degrades gracefully because rent-on-accumulated-context is the economics of *any* conversation loop, cached or not.

~100 lines total; the only novel state is `L`, `pending`, `d`.

## 3. What it covers vs leaves unattributed

Per-meter **totals** are all measured — session dollars are conserved exactly, only shares are modeled. On the sampled Claude session (fable base-tier rates), the $ mix is: **cache_read 53.4%, cache_write 35.9%, output 10.7%, input 0.0%** — i.e. ~89% of all dollars are cache economics, which is what makes this lens worth the trouble.

- **Split by direct measurement:** output char shares (~11% of $) + the within-turn measured portion of deposits. Spot-check: visible pending chars/4 explain a **median 38% (p90 66%)** of `cache_write` per call (after message-id dedup; restricting to <4-min fast-follow turns doesn't improve it, so it's density + unlogged injections, not TTL). With `d≈0.29` and the EMA, expect ~45-55% of cw explained → **~16-20% of $** measured, **~16-20% of $** to "other" as honest residual.
- **Split by model (ledger composition):** all of cache_read, ~53% of $. The composition is *derived from* measured deposits, but every rent split inherits deposit-split error. Errors damp with ledger size: composition is a sum of dozens of deposits, and the single largest (bootstrap system prompt, 10-20k tokens) is measured exactly and correctly parked in "other".

## 4. Error bounds

**Provably right:** every per-meter token count; per-message and session $ totals; the chain identity (91% of entries, verified); bootstrap deposit size; compaction boundary location and summary size; which tool produced which result (hence the *category* of each visible deposit — only its *size in tokens* is estimated).

**Estimated:** chars→tokens density (prose vs JSON vs base64 spans ~2×; the EMA tracks session mix but not per-item mix — worst case a single deposit's size is off ±50% relative); thinking-block attribution (spread pro-rata is a guess at what the deliberation was "about").

**Worst-case skew:** a mis-categorized *early large* deposit compounds — a 50k-token file read at turn 3 tagged spec-when-really-research accrues wrong rent for the whole session: 50k × 300 turns × $0.50/M ≈ **$7.50 mislabeled**, potentially 10-20% of session $. Turn-local attribution's corresponding worst case is larger and systematic: a late-session one-word `git status` turn pays rent on 500k tokens ($0.25) vs $0.015 of actual output — turn-local books 94% of that turn's cost as "git". The ledger's error is a mislabeled deposit; turn-local's error is the entire rent column.

## 5. Failure modes

1. **Missing dedup by `message.id`** — doubles everything (see §2). Hard prerequisite.
2. **TTL expiry / cache-break re-writes** — a `cw` spike re-depositing *old* context gets pro-rata'd to *pending* items. Mitigation built in: the books-balancing step plus the residual→"other" rule bound the damage; a refinement (detect `cw ≫ pending×d` with `cr < ΣL` and re-deposit the excess at *ledger* composition) costs 5 lines if the "other" bucket grows too fat.
3. **Compaction with `preservedSegment`** — Claude keeps a tail segment; full ledger wipe overstates compaction. Fix: re-deposit preserved entries (they're identified by uuid range in `compactMetadata`) at their original categories before wiping the rest.
4. **Sidechains ignored** — Task-agent entries interleave in the same file with `isSidechain: true` and independent contexts; folding them into the main ledger corrupts both. Must key ledgers by sidechain.
5. **Non-text results** (images, very long truncation-marked Bash output) — char counts mislead; falls into residual, acceptable.
6. **Providers without cache meters** (Pi/gemini sample) — no rebalancing anchor; ledger runs on chars alone, composition confidence drops, but totals still come from `cost.total`.

## 6. Cheapness

Yes, comfortably. Processing is strictly incremental — O(1) per new JSONL line (a JSON parse the daemon already does, plus char counts and a 13-float update). No re-scans, no lookback: `L`, `pending`, and `d` are the complete state (~a few hundred bytes per session), persisted in the daemon's existing per-session state between 667ms beats. Full-session replay (cold start) on the 4.0M sample is one linear pass — well under a second of Node.

## 7. Honest assessment (radical lens, audited)

The lens is **more truthful about one specific, dominant thing**: 53% of session dollars (cache_read) are *caused by accumulated context*, and turn-local attribution assigns that rent to whoever happens to be holding the shovel that turn. That's not a modeling opinion — the chain identity makes rent-on-deposits the meter's actual causal structure. Any turn-local split, however clever its within-turn weights, misprices half the session by construction.

Where it is **more elaborate than truthful**: (a) the rent split rides on deposit-size estimates that directly explain only ~38-55% of cache_write — the composition is plausible, not measured; (b) rent attribution is not *avoidability* — you cannot decline to pay rent on the spec while writing code that needs the spec, so "spec cost 30% of the session" invites a false lever ("read specs less") when the real levers are *compact earlier* and *deposit less*; (c) it answers a different question. Turn-local: "what were we doing when the money left?" Ledger: "what content is the money paying for?" Both are honest; a chart should not pretend one is the other.

**Recommendation:** ship the ledger as a second stacked view (`--by=rent` vs the default `--by=activity`), not a replacement — with "other" holding the residual honestly rather than pro-rata laundering, and with the compaction category made visible, because "compact earlier" is the one lever this lens uniquely reveals: on the sample, one compaction replaced a 717k-token rent obligation with a 43k one — a ~94% rent cut that turn-local attribution cannot even see.
