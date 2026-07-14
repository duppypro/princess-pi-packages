# Skeptic report: error bounds of all-or-nothing (latest-stage-wins) cost assignment

*Subagent lens: THE SKEPTIC / ERROR-BOUNDS ANALYST — preserved verbatim, 2026-07-14*

**Method.** Streaming line-by-line sampler over the three real sessions, porting wtft's production classification verbatim (file-path stage rules, `TOOL_CATEGORY_MAP`, bash git/grep detection, latest-stage-wins winner, message-id dedup). Claude meter costs priced at wtft's own fallback rates; Pi meter costs taken from the authoritative `usage.cost.{input,output,cacheRead,cacheWrite}` dollars in the transcript. Char proxies: tool args + text/thinking = output side; tool-result chars (linked by `tool_use_id`/`toolCallId` to the producing op's category) = next message's cache-write side, chars/4 rule. All three files parse in 32–114 ms each.

## 1. How much cost sits in genuinely MIXED messages?

Two definitions, because the answer flips on it:

| Session | msgs | total $ | **STRICT mixed** (≥2 tool-op categories) | **LOOSE mixed** (counting narration text as `prompt`) |
|---|---|---|---|---|
| f2661571 (Claude, 4.0M) | 316 | $58.57 | **0 msgs, 0.0% of $** | 133 msgs, 34.4% of $ |
| 8548d7f1 (Claude, 2.5M) | 193 | $36.13 | **1 msg, 0.5% of $** ($0.19, Bash+WebSearch×2) | 107 msgs, 50.9% of $ |
| Pi 019eb8fc (5.6M) | 1189 | $63.06 | **0 msgs, 0.0% of $** | 323 msgs, 27.0% of $ |

**The brief's motivating scenario ("reads a spec, writes code, runs git in one turn") essentially does not occur at the billing-unit level.** Tools-per-message histograms: Claude session 1 = {0:52, 1:258, 2:5, 5:1}; session 2 = {0:46, 1:140, 2:4, 3:2, 11:1}; Pi = {0:157, 1:1045, 2+: **zero**}. Every multi-tool message but one was a same-category batch (Read+Read, Bash+Bash, TaskCreate×2, Agent×11). The reason is structural: each billed message is one API call, and an agent's spec-read → code-write → git sequence spans 3+ *separately billed* API calls, each already single-category. The mixing problem lives between messages, not inside them.

The only real intra-message mixing is **narration/thinking vs. the one action** (`prompt` vs. tool category) — 27–51% of dollars — and whether that is "misassignment" is a definitional choice, not an error.

## 2. Minority share and misassigned-dollar upper bounds

Cost-weighted minority output-char share of loose-mixed messages: median 30.7% / 22.7% / **81.0%** (mean 35.7 / 28.9 / 70.0%). The Pi 81% is telling: thinking+text chars dwarf tool-arg chars, so a char-share splitter would mostly reassign action dollars *to `prompt`* — the winner category often holds <20% of the chars it "won."

| Bound | f2661571 | 8548d7f1 | Pi |
|---|---|---|---|
| **A** — naive: whole message cost × minority char share (pretends every meter splits) | $7.20 = 12.3% | $5.32 = 14.7% | $11.90 = 18.9% |
| A restricted to strict-mixed | $0.00 = 0.0% | $0.16 = 0.5% | $0.00 = 0.0% |
| **B** — dollars a sub-turn splitter can actually move: output meter × minority share + cache-write × result-traceable fraction × minority result share | **$1.09 = 1.9%** | **$1.45 = 4.0%** | **$1.21 = 1.9%** |

Since ≥99.5% of cost sits in messages with ≤1 tool category, essentially all of Bound A is prompt↔action reshuffling, not cross-stage correction. Bound A is also dishonest: it splits cache-read dollars by this message's output chars, which no mechanism justifies.

## 3. Meter dominance — and whether the dominant meter even depends on splitting

| Meter | f2661571 | 8548d7f1 | Pi | Splittable sub-turn? |
|---|---|---|---|---|
| cache_read | **45.3%** | **42.0%** | **61.5%** | **No** — it's the entire replayed conversation history; no sub-op of the current message owns it |
| cache_write | 47.1% | 40.6% | 0.0% | Barely — only the slice traceable to the previous turn's tool results; measured movable: 0.4% / 0.6% / 0% |
| input | 0.0% | 0.4% | 32.4% | No — same context property as cache_read (Pi just bills it uncached) |
| output | 7.6% | 17.0% | 6.1% | Yes — args+text chars split it cleanly; movable: 1.5% / 3.4% / 1.9% |

**92–98% of every session's dollars are a turn-level context property whose attribution is invariant under any sub-turn split.** Sub-turn splitting can only redistribute the output meter and a result-traceable sliver of cache_write. If anyone wants to relitigate who pays for the history in cache_read, that is a *cross-message historical attribution* scheme (a different, much hairier project), not sub-turn splitting.

## 4. Verdict

**The single decision number: movable dollars (Bound B) = 1.9–4.0% of session cost** (≈ $1.09–$1.45 on $36–$63 sessions). And the portion correcting *genuine* multi-category tool mixing — the thing splitting is sold as fixing — is **0.0–0.5%**. The rest of Bound B is moving money between "prompt" and the action category, which latest-stage-wins already resolves by deliberate policy, arguably more legibly.

Proportional splitting is **not worth its complexity** on this evidence. It adds a char-counting + result-linking + per-meter pricing pipeline to move ~2–4 cents per dollar, most of it into `prompt`, while the dominant meters stay turn-level no matter what. Decision rule for the future: re-run this sampler; adopt splitting only if strict-mixed cost share exceeds ~5% or Bound B exceeds ~10% of session cost (e.g., if harnesses start batching many heterogeneous parallel tool calls per API call — session 2's Agent×11 message hints that world is possible). Today's measurements are an order of magnitude below both thresholds.

**Error bars on these numbers.** chars/4 tokenization (±30% on char-share proxies — doesn't change conclusions, shares are ratios); Claude priced at sonnet-class rates for a Fable-model session (absolute $ off by a constant factor; meter *shares* shift little since all rates scale roughly together); text-dedup by prefix-hash across Claude's re-logged lines (worst case slightly undercounts text chars, which would only shrink loose-mixed further); Pi meter dollars are exact (transcript-native).
