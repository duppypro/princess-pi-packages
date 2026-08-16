# Unit Authoring Standard

**Status: Spec Approved** (Duppy, 2026-08-15). Normative rules for handing a process to an init
system without it breaking after deploy.

**Scope.** This standard is bound to **the init system**, not to a host or a tool. Today that means
**systemd user units** on Linux; the launchd half does not exist yet (see *Open*).

**It is depended on from two directions, and belongs to neither.** `serve-standard.md` needs it for
`kind = "service"` tenants; `scheduled-work-standard.md` needs it for on-box Job timers. Every rule
below therefore has to hold for both a long-running service and a periodic timer. If the two
consumers ever require *different* rules, ADR 0002's split was wrong and this document should be
absorbed into whichever one survives.

**Why these rules read oddly specific.** Each was derived from an observed failure on this box, and
carries the measurement rather than a principle. They are cheap to follow and expensive to
rediscover.

---

## 1. Units and timers

1.1 A supervised process — a service tenant, or an on-box Job run as a timer — **MUST** run as a
systemd **user** unit, and **MUST NOT** require root or `sudo ln -s` into `/etc/systemd/system`.
*Why:* `Linger=yes` is set (verified), so user units survive logout, and no root in the deploy path
means no root in the blast radius. (An on-box Job **MAY** instead be a cron entry — see §1.7 for
which rules bind it.)

1.2 `ExecStart` **MUST** name an **absolute** interpreter path. **MUST NOT** use a bare command name.
*Why, measured:* a user unit's `PATH` is
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin`
— **no `~/bin`, no nvm**. A bare `bun` or `node` resolves in an interactive shell and fails under
systemd, so the failure appears only after deploy. Cron's `PATH` is thinner still, which is why this
rule binds timers as hard as it binds services.

1.3 Unit files **MUST** use the `%h` specifier, never `~`. *Why:* systemd is not a shell; `~` does
not expand in `ExecStart`. `%h` is verified to expand in real unit files, in both
`WorkingDirectory=` and command arguments.

1.4 The interpreter **SHOULD** be reached through a path the operator owns (`%h/bin/<tool>`,
symlinked). *Why:* it does not remove a coupling to wherever the binary really lives, but it
centralizes it — one symlink to repoint instead of every unit and timer. Real case: `bun` lives
inside `~/.nvm/versions/node/v22.22.3/`, so an `nvm uninstall` would take a service's runtime with it.

1.5 A unit **in this standard's scope** (§1.1 — a service tenant, or an on-box Job timer) **MUST** log
to the state root via `StandardOutput=append:`/`StandardError=append:`. *Why:* the state root is the
per-`Env` location that `scheduled-work-standard.md` §4.1 backs up and that survives `rsync --delete`;
the journal is neither owned by the app nor retained on the app's terms. A unit outside §1.1's scope
— the tunnel itself, say — **MAY** log to the journal, because nothing about it is per-app.

1.6 A unit **SHOULD** set `Restart=on-failure` with a `RestartSec` backoff. *Why:* the deploy
sequence waits for a unit to become active before health-checking it, so the restart policy is what
makes "active" mean anything.

1.7 **Cron entries meet §1.2 and §1.3 only.** The rest of §1 is unit-file syntax that cron has no
equivalent for: there is no `StandardOutput=`, no `Restart=`, no `%h`. A cron entry **MUST** use
absolute paths throughout — for the interpreter *and* for every path argument, since it cannot use a
specifier — and **MUST** redirect its own output to the state root, because §1.5's mechanism is not
available to it. *Why this rule exists at all:* `scheduled-work-standard.md` §2.2 permits an on-box
Job to be a timer **or** a cron entry, and "comply with this standard in full" would otherwise be
unsatisfiable for the cron half.

---

## 2. Worked example

The only user unit currently on this box, reproduced **verbatim** — its value is that it is real, not
that it is exemplary:

```ini
# --- cloudflared as princess-pi: no root daemon on the internet ingress path ---
[Unit]
Description=cloudflared tunnel (serve-preview)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config %h/.cloudflared/config.yml tunnel run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

It demonstrates the absolute interpreter path (§1.2), `%h` rather than `~` (§1.3), and
`Restart=on-failure` with a backoff (§1.6). It is **not** a tenant — it is the tunnel itself — which is
why it declares no port and carries no manifest, and why §1.5 does not bind it: it logs to the journal,
which §1.5 permits for a unit outside §1.1's scope.

**Do not copy it into a tenant or a Job unit as-is.** Anything inside §1.1's scope needs the two lines
this unit does not have:

```ini
StandardOutput=append:%h/.local/state/<app>/<env>/<app>.log
StandardError=append:%h/.local/state/<app>/<env>/<app>.err
```

*Why this is called out rather than quietly fixed in the example:* editing the block to satisfy §1.5
would make the one verified artifact in this document a fiction, and the failure mode this standard
exists to prevent is exactly a rule that was never checked against the box.

---

## 3. Secrets — mechanism

*(The policy — per-`Env` files, per-brand namespacing — lives in `serve-standard.md` §5. The rules
below are systemd mechanism and stay here.)*

3.1 Secrets **MUST** be loaded via `EnvironmentFile=`, and the unit **MUST** write the path as
`%h/.config/secrets/<app>-<env>.env` — never `~/…`. *Why:* §1.3 exists precisely because systemd does
not expand `~`, and `EnvironmentFile=` is the place that failure is quietest: the unit starts, the
file is silently not found, and the service runs **without its secrets** rather than refusing to
start. The file itself lives at `~/.config/secrets/<app>-<env>.env` when you are talking to a human
or a shell; `%h` is how a unit says the same thing.

3.2 That file **MUST** be mode `0600`, inside a `0700` directory that holds credentials only. The
*why* for "credentials only" is policy and lives in `serve-standard.md` §5.4 — it is what lets one
anchored rule replace a per-file list.

3.3 Secrets **MUST NOT** be committed, and **MUST NOT** be passed as `Environment=` literals in a
unit file. *Why:* `Environment=` values are world-readable via `systemctl show`.

---

## 4. Prohibitions

**MUST NOT**:

- require root, or install into `/etc/systemd/system` (§1.1)
- use a bare command name in `ExecStart` or a cron entry (§1.2)
- use `~` anywhere in a unit or timer (§1.3)
- pass a secret as an `Environment=` literal (§3.3)

---

## Open, and deliberately not ruled on

**The launchd half.** macOS uses launchd, and `serve-standard.md` §4.1 currently forbids
`kind = "service"` there because of it. Enabling it needs a second set of rules with its own measured
reasons — `~/Library/LaunchAgents/*.plist`, `RunAtLoad`/`KeepAlive` in place of `Restart=`,
`StandardOutPath` in place of `StandardOutput=append:`. The awkward one is §1.3: systemd's rule exists
*because* `~` does not expand, and plists have no specifier at all, so the launchd half may need a
generator rather than a hand-authoring rule. Tracked as #287.

**Whether this document survives at all.** Nothing generates unit files today; they are hand-written,
which is why these are authoring rules. If this repo later grows a unit generator, every rule here
collapses into that tool's implementation and this standard disappears. That would be a good outcome,
not a regression.
