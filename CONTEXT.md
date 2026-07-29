# Princess Pi Packages

Multi-tool repo for the Princess Pi coding agent: development server, cost tracking, git workflow, and CLI utilities.

## Language — Serve

**Server instance**:
A running process that serves a local directory on a loopback port. Discovered by parsing `ps aux` for `run-live-server` or `http-server` processes.
_Avoid_: Service, daemon, listener

**Live server**:
A server instance running the native Node.js `run-live-server.js` process. Injects SSE client scripts into HTML, watches files for changes, and pushes live-reload events. The default mode — `--static` is the exception.
_Avoid_: Dev server, hot-reload server

**Static server**:
A server instance running `npx http-server`. Serves files as-is — no injection, no watchers, no live-reload. Opted into with `--static` / `-s`.
_Avoid_: Production server, plain server

**Slug**:
A short, URL-safe name that identifies a published preview. Passed via `--as <slug>`. The public URL is `https://<slug>.princess-pi.dev/`. Stored in the process cmdline (`--slug`) for servers started with `--as`, and in `~/.pi-certs/serve-slugs.json` for servers published after start.
_Avoid_: Label, hostname, alias

**Publish**:
Creating the Cloudflare resources for a slug: a Tunnel ingress rule (`<slug>.princess-pi.dev → 127.0.0.1:<port>`) and a per-slug Access application gated by email OTP. Done by `publishSlug()` in `cloudflare.js`. Writes to the slug map. Multiple slugs can point to the same port — one directory can have several public URLs.
_Avoid_: Deploy, expose, register

**Alias**:
Adding a new public URL to an already-running server instance. Running `serve <dir> --as <new-slug>` on a directory that's already being served publishes an additional slug pointing to the existing port — no new process spawned. The slug map accumulates slugs per port.
_Avoid_: Republish, rename, reassign

**Unpublish**:
Removing the Cloudflare ingress rule and Access application for a slug. Done by `unpublishSlug()` on `--kill`. Removes the entry from the slug map. Idempotent — safe to call on already-unpublished slugs.
_Avoid_: Takedown, deregister, remove

**Slug map**:
Persistence file at `~/.pi-certs/serve-slugs.json` mapping port numbers to arrays of slugs. Written on publish, read during server discovery, cleaned on unpublish. Exists so `--list` can show the public URL for servers that were published after they started (no `--slug` in their process cmdline).
_Avoid_: Port registry, slug cache

**Orphan**:
A Cloudflare Tunnel ingress rule whose corresponding local server process no longer exists. Created by crash-without-kill. Reaped on every `serve` invocation by `reapOrphans()`.
_Avoid_: Stale rule, dangling ingress, zombie

**Reap**:
The process of scanning Cloudflare Tunnel ingress rules and deleting any that point to ports with no matching local process. Best-effort — failure does not block serving.
_Avoid_: Cleanup, sweep, GC

**Access application**:
A Cloudflare Access resource created per slug. Carries the email allow-list from the served directory's `.serve-acl` file. Authenticates visitors via email One-Time-PIN before they reach the origin.
_Avoid_: Auth app, OAuth app, gate

**Serve ACL**:
The `.serve-acl` file in a served directory. One email per line. Parsed by `parseAclFile()` and fed into the Access application's allow policy on publish.
_Avoid_: Allow-list file, email list

**Loopback**:
The address `127.0.0.1` that all serve processes bind to. No server listens on external interfaces — public access is exclusively through Cloudflare Tunnel.
_Avoid_: Localhost, local-only, internal

**Edge**:
Cloudflare's network. Handles TLS termination (HTTPS), Tunnel ingress routing, and Access authentication. The local serve process never touches certificates or encryption.
_Avoid_: Cloudflare, CDN, proxy

**Discovery**:
The process of finding running server instances by scanning `ps aux` output (`discoverServers()` in `process.ts`). Runs on session start, on a 4-second tick for the widget, and on every `--list` / `--kill` invocation. Reads both process cmdline and the slug map.
_Avoid_: Scan, enumeration, detection

**Health check**:
An HTTP GET to a server's URL to determine if it's online. Used in `--kill` to report before/after status. Returns `[+] Online (200 OK)` or `[-] Offline (<reason>)`.
_Avoid_: Probe, ping, status check

**Card**:
A box-drawn status display for a single server instance. Used post-start (shows URL + type + log path), post-kill (shows URL + before/after health status), and on republish. Dynamic-width with gray borders. Rendered by `formatServerCard()` / `formatServerCardKilled()` in `tui.ts`.
_Avoid_: Box, panel, block

**Table**:
An aligned-column status display for multiple server instances. Columns: `SERVED DIRECTORY`, `PORT`, `TYPE`, `URL`. Bold magenta ANSI coloring. Used by `--list` and the Pi TUI widget. Rendered by `formatServerTable()` in `tui.ts`.
_Avoid_: List view, grid, rows

**Widget**:
The Pi TUI panel that displays the server table below the editor. Registered as `serve-ports`. Visible/hidden via `--show` / `--hide` (Pi only). Updated on session start, on a 4-second tick, and after every serve/kill operation.
_Avoid_: Panel, sidebar, status bar
