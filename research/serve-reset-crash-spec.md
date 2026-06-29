# Spec Draft: Add IncomingMessage Error Listeners to Prevent Process Crashes

## Goal
Prevent the Pi Coding Agent from crashing/exiting when performing HTTP client status checks that receive unexpected TCP connection resets (`ECONNRESET`).

## Detailed Plan

### 1. Fix response stream error handling
In `/extensions/lib/serve/process.ts`:
- Inside `checkServerStatus(url)`:
  - Add `res.on("error", () => {})` to catch any socket/stream errors.
  - Call `res.resume()` to consume/discard the body stream safely.
- Inside `fetchPageTitle(url)`:
  - Add `res.on("error", () => {})` to catch any stream errors.
- Inside `getPublicIp()`:
  - Add `res.on("error", () => {})` to catch stream errors.

## Verification Plan
1. Compile using `npm run build`.
2. Verify that stopping servers or receiving connection resets does not trigger any unhandled exceptions in the Node process.
