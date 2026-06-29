> ℹ️ **STILL VALID under #32** — and more important now: with subdomain-per-slug
> (`<label>.<machine>.preview.princess-pi.dev`) there is no `/live/<slug>/` path prefix, so
> directory-index links **must** be relative to resolve correctly. The `/live/` references below
> are stale wording; the relative-links requirement stands (issue #37).

# Spec Draft: Use Purely Relative Links in Directory Indexes

## Goal
Resolve root-relative path breakages under `/live/<slug>/` proxy routing by generating purely relative links in local directory index HTML files.

## Detailed Plan

### 1. Update run-live-server.js
Modify `generateDirectoryIndex` in `extensions/lib/serve/run-live-server.js`:
- For parent directory:
  - Change:
    `<a class="parent-dir" href="${parentPath === "." ? "/" : parentPath}">`
  - To:
    `<a class="parent-dir" href="../">`
- For entries:
  - Change:
    `<a href="${relativeHref}/">` and `<a href="${relativeHref}">`
  - To:
    `<a href="${entry.name}/">` and `<a href="${entry.name}">`

## Verification Plan
1. Launch local servers.
2. Run automated test `/live/princess-pi-packages/docs/?token=...` and verify that generated link URLs in directory lists do not contain a leading slash `/`.
