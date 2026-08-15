# Scheduled Work Standard

**Status: Spec Approved** (Duppy, 2026-08-15). Normative rules for recurring work owned by the
operator — the manager that holds the schedule, the Jobs it runs, and the backups that are the first
real Job.

**Scope.** This standard is bound to **a singleton long-lived host**. That is the one genuinely
host-shaped concern in the former VPS Tenancy Standard, and the one most likely to move to a cloud
service on its own. It is written to stay **liftable**: nothing here assumes this particular box, and
where a rule depends on systemd it hands off rather than inlines. Split by **ADR 0002**.

**Companions.** Vocabulary: `tenancy-glossary.md` (**Job**, **Lane**, **Operator**, **State root**).
Timers and their absolute-path rules: `unit-authoring-standard.md`. Jobs whose work is performed by
an LLM agent: `agent-job-standard.md`. Where irreplaceable data must live: `serve-standard.md` §1.

**How to read it.** **MUST** is a rule whose violation has produced, or would produce, a real
failure. **SHOULD** is a strong default with named exceptions. **⚠ NOT YET ENFORCEABLE** rules are
collected in §6.

---

## 1. The manager

1.1 **Exactly one scheduled-work manager MUST be active at a time, portfolio-wide.** *Why:* Jobs are
not idempotent. Two managers mean two backups racing one destination, two records for one cadence
with no way to tell which ran, and — for an **Agent Job** — a doubled LLM bill for work whose output
is non-deterministic. For this class of work **at-most-once beats at-least-once**: a missed run is
visible and recoverable, a duplicated run may be neither.

1.2 The manager **MUST** be identifiable, and a second manager **MUST** be unable to start while the
first holds the schedule — a lease, lock, or heartbeat that fails closed. **⚠ NOT YET ENFORCEABLE**
(§6). *Why:* this rule exists to be *detected*, not merely declared. An unenforced constraint is a
wish, and this one fails silently and expensively.

1.3 Moving the manager — to another box, or to a cloud service — **MUST** be a **handoff, never an
overlap**. The old manager stops holding the schedule before the new one starts. *Why:* the migration
window is precisely the split-brain this standard exists to prevent, and it is the one moment
somebody is tempted to run both "just to be safe."

1.4 While the manager is down, nothing runs, and that **MUST** be treated as a visible outage rather
than absorbed. *Why:* the singleton buys correctness by giving up availability. That trade is
accepted deliberately (ADR 0002, *Roads not taken*), and it is only safe if the outage is loud.

---

## 2. Jobs and lanes

2.1 A Job **MUST** declare a **lane**, and the lane **MUST** be derived rather than chosen: a Job
needing local state — the state root, a secrets file, a repo clone, the tunnel — is **on-box**; a Job
whose entire input is the network is **off-box**. *Why:* the alternative is shipping credentials off
the box to reach local things, which converts a local dependency into a permanent
secret-distribution problem.

2.2 An **on-box** Job **MUST** be a timer or cron entry owned by the operator, meeting
`unit-authoring-standard.md` in full — including the absolute-interpreter rule. *Why:* cron's `PATH`
is thinner than a user unit's; a bare command name fails at 3am in something nobody is watching.

2.3 An **off-box** Job **MUST** run on an ephemeral GitHub-hosted runner from a **private**
repository, and **MUST NOT** use a self-hosted runner on this box. *Why:* a self-hosted runner
reintroduces the entire local blast radius while keeping every inconvenience of Actions.

2.4 A Job's **lane and its destination are independent choices**, and a Job **MAY** run on-box while
writing off-box. See §3.3.

2.5 A Job whose work is performed by an LLM agent rather than a deterministic script is an **Agent
Job**, and **MUST** additionally meet `agent-job-standard.md`.

---

## 3. The record

3.1 An on-box Job that can fail silently **MUST** write an outcome to the state root. An off-box
Job's record is its GitHub issue.

3.2 The outcome **MUST** be machine-readable — a structured record with stable keys, not prose.
*Why:* the next reader is a program or an agent deciding whether the Job is healthy, and a reworded
log line is a silent breaking change.

3.3 A Job that reports success **MUST** have verified the thing it claims, not the step it ran. See
§4.3 for what that means for a backup.

---

## 4. Backup and restore

4.1 Anything irreplaceable **MUST** live in the state root and **MUST** have a backup Job **before it
holds real user data**. *Why:* every other artifact regenerates — release dirs from git, configs from
dotfiles, Cloudflare state from `serve`. Nothing currently backs up `~/.local/state`.

4.2 A backup's destination **MUST** leave the source's failure domain. An on-box lane writing an
on-box target **MUST NOT** be called a backup. *Why:* a copy beside the original protects against
deletion and corruption but not against losing the box, which is the failure the backup exists for.
The lane is derived from where the *input* lives (§2.1); the destination is a separate decision.

4.3 **A backup Job's success criterion MUST be a restore rehearsal, not a backup completion.** The
Job **MUST** restore into a scratch location and assert a known invariant — schema present, row count
not below the last recorded count, and a **canary** record returning byte-identical. *Why:* "the
backup command exited 0" passes for years and fails exactly once, at the only moment it matters. A
backup that has never been restored is a file, not a backup.

4.4 Backup cadence and rehearsal cadence **MAY** differ — nightly backup, weekly rehearsal is a
reasonable default. But a subject whose most recent rehearsal is older than the declared rehearsal
interval **MUST** be reported as **unprotected**. *Why:* otherwise a rehearsal that quietly stopped
running looks identical to one that is passing.

4.5 A live SQLite database **MUST NOT** be copied with `cp` or `rsync`. Use `VACUUM INTO`, or a
driver's `backup()`. *Why:* a copy taken mid-write is a corrupt database that **restores cleanly and
fails later** — the worst failure shape available.

4.6 `sqlite3 <db> ".backup <dest>"` **MUST NOT** be used in a Job on this box: the `sqlite3` CLI is
not installed (verified). Either install it deliberately or use an in-process route.

4.7 A backup **MUST** be verified by opening it — `PRAGMA integrity_check` returning `ok`, and a
known row present. *Why:* a backup job producing an unopenable file is worse than none, because it
reports success. (§4.3 is the stronger form of this rule; 4.7 is its floor.)

4.8 WAL `-wal` and `-shm` sidecars **MUST** stay with their database and **MUST NOT** be moved or
copied independently.

---

## 5. Cadence

5.1 A Job **MUST** declare its cadence and its trigger, and the record **MUST** carry the run time.
*Why:* off-cadence runs break the assumption that N runs ago is N intervals ago, which every trend
read against the record silently depends on.

---

## 6. Not yet enforceable

| Rule | Blocked on | Consequence today |
|---|---|---|
| §1.2 single-manager lease | no manager exists yet, so there is nothing to hold a lease | the singleton is declared and undetected — a wish by this repo's own standard |
| §4.3 restore rehearsal | no backup Job exists yet | nothing backs up `~/.local/state` at all |

---

## 7. Prohibitions

**MUST NOT**:

- run a second scheduled-work manager while another holds the schedule (§1.1)
- overlap old and new managers during a migration (§1.3)
- run an off-box Job on a self-hosted runner (§2.3)
- run an off-box Job from a public repository (§2.3)
- call an on-box-destination copy a backup (§4.2)
- report a backup successful without a restore rehearsal (§4.3)
- `cp`/`rsync` a live SQLite file (§4.5)
- move a `-wal`/`-shm` sidecar away from its database (§4.8)

---

## Couplings — stated, because colocation no longer holds them

- **§2.2 on-box timers × unit authoring.** Every absolute-path and specifier rule for a timer lives
  in `unit-authoring-standard.md`, which is also depended on by `serve-standard.md` for service
  tenants. If those two consumers ever need different rules, ADR 0002's split was wrong.
- **§4.1 backup subjects × serve.** What must be backed up is defined by `serve-standard.md` §1.3 —
  the state root. This standard does not get to redefine which data is irreplaceable.

---

## Open, and deliberately not ruled on

- **Where the lease lives** (§1.2): a lock file in the state root, a systemd unit's own
  single-instance guarantee, or an external coordinator. Not decided here, because the answer likely
  differs on the day the manager moves off this box — and that move is the reason the constraint
  exists.
