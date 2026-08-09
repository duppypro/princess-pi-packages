# Adding a harness to wtft

Three steps. **No shared file is edited** — not `wtft-renderer.ts`, not `wtft-cost.ts`,
not `wtft-daemon-lib.ts`, not the selector's shared logic. If your harness needs one of
those touched, the seam is in the wrong place; file an issue rather than widening it.

---

## 1. `discovery` — where do this harness's transcripts live?

```ts
interface HarnessDiscovery {
  readonly id: string;     // must equal the directory name
  readonly label: string;  // selector column, e.g. "Codex"
  discover(targetCwd: string | null): SessionCandidate[];
  resolveSessionById(sessionId: string): string | null;
}
```

`discover` returns candidates for a target directory. You decide what a `null` target
means for your harness — Claude Code falls back to `process.cwd()`, Pi treats it as "no
filter". Both are policies, and both live inside their own discovery module.

If your harness records a `cwd` on its transcript entries, apply the **union rule**:
include a transcript when its project-dir slug matches the target **or** its own recorded
last-cwd does. `resolveLastCwd()` from `harness/session-cwd.ts` does the tail scan and
memoises it. Union, not replacement — a last-cwd-only rule silently drops sessions whose
directory slug is a parent of their cwd.

`resolveSessionById` is what lets a running daemon follow a session whose transcript moved
(#155). Return the newest match when an id appears more than once.

## 2. `parse` — what does this harness's entry schema mean?

```ts
interface HarnessParseAdapter {
  readonly id: string;
  matchAssistant(entry: any): AssistantTurn | null;
  readBlock(block: any): ParsedBlock | null;
  readControlEntry(entry: any): ControlSignal | null;
}
```

This is **schema knowledge only**. Translate field locations and field names; do not
compute anything.

- `matchAssistant` — return `null` unless this entry is your harness's assistant turn.
  Fill `usage` with Anthropic-compat names, and set `nativeCost` only if your harness
  records a per-turn cost of its own (Pi does; Claude Code does not).
- `readBlock` — one content block. Map your tool argument names to `files` / `commands`.
  Set `handled: false` for a tool you did not branch on, so shared category mapping gets a
  shot at it.
- `readControlEntry` — recognize non-assistant entries that change how following turns
  read: model switches, thinking level, compaction markers, interrupts. Every registered
  adapter is consulted for every entry, first match wins.

Cost, cache-miss observation, the meter-split, dedup, classification and every renderer are
inherited. That is the point.

## 3. Register it

**In-repo** — put the two files at `extensions/lib/harness/<id>/discovery.ts` and
`extensions/lib/harness/<id>/parse.ts`, then `bun run build`. `build.ts` scans the
directory and regenerates `harness/builtins.generated.ts`; your harness is in the table.

**Out-of-tree** — ship `.mjs` and point config at it. No rebuild:

```jsonc
// ~/.config/princess-pi-packages/wtft-harnesses.json
{
  "codex": {
    "label": "Codex",
    "discovery": "~/.config/princess-pi-packages/harness/codex/discovery.mjs",
    "parse":     "~/.config/princess-pi-packages/harness/codex/parse.mjs"
  }
}
```

`.mjs` only — stock node cannot import `.ts`, and requiring node ≥ 22.6 type-stripping from
a global install was ruled out in #31.

The same file disables a built-in:

```jsonc
{ "pi": { "enabled": false } }
```

---

## The worked example

`research/156-codex-harness-sketch/` is a complete third harness with a schema deliberately
unlike both built-ins — `{kind: "turn"}` assistant entries, `{op: "call"}` tool blocks, and
a third set of usage field names. It is exercised end to end by
`tests/wtft-issue-156-harness-seam.test.ts`, which asserts it discovers, parses, prices and
classifies through the registry with no shared file edited.

That test is the acceptance criterion for the seam. If it ever needs a change in
`extensions/lib/*.ts` to keep passing, the seam moved and the design is not done.

---

*Built by the AI Princess Pi. Inspired by her human, Duppy (github.com/duppypro)*
