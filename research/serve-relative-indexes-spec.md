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
