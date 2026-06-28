# Spec Draft: WTFT Width Variable Rename and Default Increase

## Goal
Resolve the `System Error: width is not defined` when running `wtft --other`. Enhance usability by setting a default maximum width (`maxWidth`) of `240` characters for both bar charts and `--other` histogram.

## Changes Required

### 1. Renames
In `bin/wtft.ts` (and compiled `bin/wtft.mjs`):
- Rename CLI parsed variable `widthOption` -> `maxWidthOption`
- Rename resolved variable `finalWidth` -> `maxWidth`

### 2. Default Width Increase
- Increase the fallback default width from `80` (or `Math.min(240, termColumns, 240)`) to a fixed `240` characters.
- If `--width` is specified, respect it.
- If not specified, default to `240`.
- For the visual bar chart, the output remains constrained by the actual terminal column width via `Math.min(rawWidth, termWidth)` inside `buildWtftLines`.
- For the `--other` command histogram, use `maxWidth` (defaulting to `240`) as the upper limit.

### 3. Help Text & Metadata
- Update help menu text inside `bin/wtft.ts` and `bin/wtft.mjs` to state `default: 240`.
- Update manifest `docs/manifests/wtft-cmd.json` description for `-w, --width` to reflect default of `240` instead of `80`.

## Verification Plan

### Automated Verification
Run existing tests:
```bash
npm test
```
(Specifically checking for any test breakages).

### Manual Verification
1. Run `node bin/wtft.mjs -i 1m -c --other --width 240` inside this repo to ensure no crash occurs and output is properly formatted.
2. Verify visual output width defaults nicely.
