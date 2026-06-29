# Spec Draft: Keep Generated Preview URLs Un-truncated and Clickable

## Goal
Ensure `/serve` URL outputs in the CLI are fully un-truncated and clickable by removing terminal-UI right-border box padding from the URL line.

## Detailed Plan

### 1. Update tui.ts
In `extensions/lib/serve/tui.ts`:
- Inside `buildKilledSummary`:
  - Change URL line to use full `server.url` instead of `urlPadded`.
  - Remove the trailing `${borderStyle}│\x1b[0m` border so terminals do not append `│` to clicked links.
- Inside `buildDiscoveredSummary`:
  - Change URL line to use full `server.url` instead of `urlPadded`.
  - Remove the trailing `${borderStyle}│\x1b[0m` border.

## Verification Plan
1. Compile using `npm run build`.
2. Run `/serve` and verify that the full, un-truncated URL with `?token=...` is printed and contains no trailing `│` characters.
