> ⚠️ **OBSOLETE (#32):** URLs are no longer path-based (`/preview/` or `/live/`) — `/serve` now
> uses **subdomain-per-slug** (`<label>.<machine>.preview.princess-pi.dev`). See
> `docs/SPEC_SECURE_DYNAMIC_SERVE.md`. Kept for history (relates to issue #33).

# Spec Draft: Change /serve URL path from /preview/ to /live/

## Goal
Update the dynamic secure `/serve` pathing prefix from `/preview/` to `/live/` to match Duppy's requested naming convention.

## Changes Required

### 1. Source Code Files
Change the public URLs to print `https://princess-pi.dev/live/...` instead of `https://princess-pi.dev/preview/...`:
- `extensions/lib/serve/process.ts` (around line 77)
- `extensions/serve.ts` (around line 342)
- `bin/serve.ts` (around line 193)
- `bin/serve.mjs` (around line 81 and line 523)

### 2. Documentation / Specifications
Update the reference documentation:
- `docs/SPEC_SECURE_DYNAMIC_SERVE.html`

## Verification Plan
1. Compile the code using `npm run build`.
2. Verify that there are no remaining instances of `/preview/` in the modified source files.
