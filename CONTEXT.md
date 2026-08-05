# Princess Pi Packages

Multi-tool repo for the Princess Pi coding agent: development server, cost tracking, git workflow, and CLI utilities.

## Language — Serve

**Server instance**:
A running process that serves a local directory on a loopback port. Discovered by parsing `ps aux` for `run-live-server` or `http-server` processes.
_Avoid_: Service, daemon, listener

**Live server**:
A server instance running the native Node.js `run-live-server.js` process. Injects SSE client scripts into HTML, watches files for changes, and pushes live-reload events. This is the default mode — no flag needed. `--static` overrides it.
_Avoid_: Dev server, hot-reload server

**Static server**:
A server instance running `npx http-server`. Serves files as-is — no injection, no watchers, no live-reload. Opted into with `--static` / `-s`.
_Avoid_: Production server, plain server

**Sub-domain**:
A short, URL-safe name that identifies a published preview. Passed via `--pub <subdomain>` (`--as` is a legacy synonym). The public URL is `https://<subdomain>.princess-pi.dev/`. Stored in the process cmdline (`--subdomain`) for servers started with `--pub`, and in `~/.config/princess-pi-packages/serve/subdomains.json` for servers published after start.
_Avoid_: Slug, label, hostname, alias

**Publish**:
Creating the Cloudflare resources for a sub-domain: a Tunnel ingress rule (`<subdomain>.princess-pi.dev → 127.0.0.1:<port>`) and a per-subdomain Access application gated by email OTP. Done by `publishSubdomain()` in `cloudflare.js`. Writes to the sub-domain map. Multiple sub-domains can point to the same port — one directory can have several public URLs.
_Avoid_: Deploy, expose, register

**Alias**:
Adding a new public URL to an already-running server instance. Running `serve <dir> --pub <new-name>` on a directory that's already being served publishes an additional sub-domain pointing to the existing port — no new process spawned. The sub-domain map accumulates sub-domains per port.
_Avoid_: Republish, rename, reassign

**Unpublish**:
Removing the Cloudflare ingress rule and Access application for a sub-domain. Done by `unpublishSubdomain()` on `--kill`. Removes the entry from the sub-domain map. Idempotent — safe to call on already-unsub-domains.
_Avoid_: Takedown, deregister, remove

**Sub-domain map**:
Persistence file at `~/.config/princess-pi-packages/serve/subdomains.json` mapping port numbers to arrays of sub-domains. Written on publish, read during server discovery, cleaned on unpublish. Exists so `--list` can show the public URL for servers that were published after they started (no `--subdomain` in their process cmdline).
_Avoid_: Port registry, sub-domain cache

**Orphan**:
A Cloudflare Tunnel ingress rule whose corresponding local server process no longer exists. Created by crash-without-kill. Reaped on every `serve` invocation by `reapOrphans()`.
_Avoid_: Stale rule, dangling ingress, zombie

**Reap**:
The process of scanning Cloudflare Tunnel ingress rules and deleting any that point to ports with no matching local process. Best-effort — failure does not block serving.
_Avoid_: Cleanup, sweep, GC

**Access application**:
A Cloudflare Access resource created per sub-domain. Carries the email allow-list from the served directory's `.serve-acl` file. Authenticates visitors via email One-Time-PIN before they reach the origin.
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
The process of finding running server instances by scanning `ps aux` output (`discoverServers()` in `process.ts`). Runs on session start, on a 4-second tick for the widget, and on every `--list` / `--kill` invocation. Reads both process cmdline and the sub-domain map.
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
