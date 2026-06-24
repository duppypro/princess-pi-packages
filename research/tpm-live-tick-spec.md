# Spec: TPM Live Tick Refresh and Cache

This specification introduces live-refresh capability for the Tokens Per Minute (TPM) widget in the Pi Agent, synchronizes with the external tmux status bar, and avoids redundant parsing across multiple running agent harnesses.

## Proposed Changes

### 1. CLI Flags for Tick Interval
Add `--tick` and `-t` command-line flags to specify the background update interval of the widget.
- **Flag Name:** `tick` (string) and `t` (string)
- **Format:** Supports values in seconds (`2` or `2s`) or milliseconds (`500ms`).
- **Default:** `1s` (1 second refresh).
- **Parsing Helper:** Converts the string into milliseconds (`tickMs`).

### 2. Background Refresh Timer
Implement a background refresh timer in `extensions/rate-limiter.ts`:
- **Start:** On `session_start`, start a `setInterval` that triggers `updateRateLimiterWidget` using the last known `ExtensionContext`.
- **Interval Adjustments:** During a rate-limiter cooldown / coffee break, set the tick interval to `1000ms` (1 second) to ensure the visual countdown smoothly counts down. Return to the user-specified tick interval when idle.
- **Stop:** On `session_shutdown`, clear the interval to prevent timer leaks.

### 3. File-Based Stats Cache to Avoid Double Parsing
To sync seamlessly with external consumers (like the tmux status bar script) and support concurrent Pi agent sessions, we implement a file-based caching mechanism.
- **Cache File:** `/tmp/pi-rate-limit-stats.json`
- **Schema:**
  ```json
  {
    "timestamp": 1782188800000,
    "stats": {
      "g3.5fla": { "tpm": 120000, "lastActiveAge": 15000 },
      "c3.5son": { "tpm": 45000, "lastActiveAge": 5000 }
    }
  }
  ```
- **Read Logic:** Before scanning all `.jsonl` log files, the extension checks if the cache file exists and is "fresh" (age is less than `tickMs` or at least `1000ms`).
- **Write Logic:** If the cache is stale or missing, the extension performs the full log parsing scan, aggregates the active TPM metrics, and writes them to the cache file.
- **Session-Specific Metric:** The hosting session's `sessionTpm` is calculated by reading *only* the hosting session's specific log file, which is extremely fast and light. This is merged with the cached global stats.

### 4. Tmux Script Integration (`tpm_meter.js`)
Update `/home/princess-pi/.config/tmux/tpm_meter.js` to first attempt to read from the `/tmp/pi-rate-limit-stats.json` cache if it exists and is less than 5 seconds old, falling back to full parsing of logs if stale or missing.
