# ADR 0002 — VPS tenancy dissolves into serve and scheduled-work standards

- **Status:** proposed
- **Date:** 2026-08-14
- **Supersedes:** princess-pi-brain #2 (2026-08-09)
- **Relates to:** ADR 0001 (resolves part of its *Open boundary*), btw #20, princess-pi-packages #283

---

## Context

The **VPS Tenancy Standard** is 264 lines across 12 sections, living in
`princess-pi-brain/vps-tenancy/` alongside a 197-line glossary and a 248-line
`agent-job-standard.md`. It was promoted there on 2026-08-09 from btw (#20 closed).

**Why it went to brain.** The glossary states the reason: *"These are cross-repo rules, and the
standard alongside is a map of this box, so they live in a private repo shared across projects
rather than a side-quest repo capped at Spec Draft."* Three drivers — cross-repo, private,
and btw being ineligible.

Only one of those is about what the document *is*. `princess-pi-packages` is **public**; brain,
btw and dotfiles-doctor are private. Brain won because it was the only private cross-project repo
in the portfolio. **It was never argued that tenancy is memory** — the OKF frontmatter was applied
after placement, to fit brain's format.

**The document is an umbrella over four independently-bound concerns.** Topic density across its
sections:

| concern | sections | ~share | bound to | moves when |
|---|---|---|---|---|
| serve contract | §1 Placement, §2 Manifest, §3 Ports, §6 Deploy | 29% | the `serve` tool | never — travels with the tool |
| edge | §7 Health check, §8 Publishing/gates/zones | 17% | Cloudflare | you leave Cloudflare |
| process supervision | §4 Units, §5 Secrets (mechanism) | 19% | the init system | you change OS |
| scheduled work | §9 State/backup, §10 Jobs | 20% | a singleton long-lived host | the scheduler moves — independently |

"VPS" discriminates none of them. It names the accident that all four currently share a box. Only
scheduled work is genuinely host-shaped, and it is the piece most likely to move to a cloud service
on its own — which the umbrella would obstruct.

**The seam is already visible in the artifacts.** `agent-job-standard.md` split out on its own —
248 lines, twelve sections, its own trust boundary and lane selection. Jobs outgrew §10 and left;
§9–10 are the 44 lines still on the wrong side of the fracture. The glossary is already sectioned
as *Placement / The tenant / The perimeter / Deployment*. And `serve --pub` **is** what creates the
tunnel ingress rule and the Access application, with reap running on every `serve` invocation — so
§8 documents serve's behaviour, not Cloudflare's.

**Nothing is deployed against it yet.** Zero `.tenant.toml` manifests exist. One systemd user unit
exists (`cloudflared.service` — the tunnel, not a tenant). Zero crontab entries, zero job timers.
These are **pre-implementation specs**, so this is a restructuring of guidance, not a migration of
running systems.

---

## Decision

**"VPS tenancy" dissolves into three standards, each named for what it binds to. The glossary
follows the standards. `princess-pi-brain` keeps cross-harness memory and the tools to read and
write it; its `vps-tenancy/` empties.**

The dividing line is **what a rule is bound to**, never which host it currently runs on:

| standard | contents | bound to | owner |
|---|---|---|---|
| **serve** | §1, §2, §3, §6, §7, §8 + the policy half of §5 | the `serve` tool | the tools repo, beside `serve` |
| **scheduled work** | §9, §10 + all of `agent-job-standard.md` | a singleton long-lived host | the tools repo — written to stay liftable |
| **unit authoring** | §4 + the mechanism half of §5 | the init system | shared appendix, cited by both |
| **glossary** | all ~25 terms | the two standards above | follows them |

Three consequences of the line, stated so they are not re-litigated:

**Serve absorbs the edge.** Cloudflare is reached only through `serve --pub`, and reap is a serve
behaviour. A separate edge standard would document one tool's side effects in another document.

**Unit authoring is a shared dependency, not a section of either.** Every §4 rule derives from
systemd's behaviour with a measured failure attached — `ExecStart` must be absolute because a user
unit's `PATH` has no `~/bin` and no nvm; `%h` because systemd is not a shell. Scheduled work's
on-box lane already cites *"the same absolute-path rules as a unit"*. It is depended on from two
directions, so it belongs to neither.

**§5 splits unevenly and deliberately.** 5.2 (per-`Env` files, so a dev unit never receives live
credentials) and 5.3 (per-brand namespacing) are policy and hold on any platform — they go with
serve. 5.1 and 5.4 name `EnvironmentFile=` and forbid `Environment=` literals; they are systemd
mechanism and go with unit authoring.

**Exactly one scheduled-work manager is active at a time, portfolio-wide.** This is a **MUST** in
the scheduled-work standard, not a deployment preference. *Why:* Jobs have side effects that are
not idempotent — a second manager means two backups racing the same destination, two records for
one cadence with no way to tell which ran, and, for an **Agent Job**, a doubled LLM bill for work
whose output is non-deterministic. For this class of work, **at-most-once beats at-least-once**:
a missed run is visible and recoverable, a duplicated run may not be either.

The constraint binds hardest during the migration it exists to permit. Moving the manager to a
cloud service creates a window where the old and the new both hold the schedule, and that window
is precisely the failure mode — so the cutover is a **handoff, never an overlap**.

Declaring it is not enough. Per the rule that unenforced guidance is a wish, the standard **MUST**
name how a violation is *detected*, not only forbidden — a manager identity plus a heartbeat or
lease that a second manager cannot take while the first holds it. The specific mechanism is left
to the standard; the requirement that one exist is decided here.

---

## Consequences

- **princess-pi-brain #2 is superseded.** Brain's `vps-tenancy/` directory empties entirely —
  glossary, standard, agent-job-standard, `_index.md`, and the related `_rosetta.md` entries.
- **The `lane` collision dissolves.** Brain's rosetta records `lane` meaning both the OKF filename
  suffix (`slug--lane`) and a Job's execution lane. That collision exists *only* because the
  document was moved into brain; the ontology collided with the content it absorbed. It goes away
  with the content.
- **btw's three stale copies become pointers** to final destinations, landing last so they are not
  rewritten twice. btw's copy currently states that reap matches `ps aux`, which brain has since
  corrected — it is actively wrong today.
- **The five site-host repos repoint** their glossary copy headers. Privacy is unchanged: brain is
  private and the tools repo is intended to become private, so no consumer gains or loses access.
- **Cross-concern couplings must now be stated, not held by colocation.** Two are known and each
  split standard MUST name the ones it participates in:
  - **§3 port reservation** — declared service ports must be reserved against serve's static
    allocator (serve × supervision)
  - **§7 health check contract** — the deploy probe's success criterion is defined by the tenant's
    `gate` (deploy × edge)
- **One term does not follow the standards.** The *"domain means four different things"* ruling
  (DNS name / deployable thing / DDD bounded context / scope of engineering rules) binds across
  every repo and is why `~/git-projects/CLAUDE.md` says *scope*. It is genuinely cross-project
  knowledge and stays as memory. It is one entry, not a file.

---

## Open boundary — flagged for review, not decided here

**Whether `serve` on macOS is the same contract.** §1's four roots are XDG paths that exist on
macOS, but "release dir replaced wholesale by `rsync --delete`" and the port allocator assume a
server lifecycle. If MacBook-serve is local preview only, then `gate`, `zone` and `subdomain`
become optional manifest fields and the serve standard grows a conditional — the shape this ADR
is otherwise removing. Left open because it does not block the split, and the first implementation
will answer it.

**Whether unit authoring survives as a document.** Nothing generates unit files today; they are
hand-written. If the tools repo later grows a unit generator, §4 collapses into that tool's
implementation and the appendix disappears. Cheap to reverse in either direction.

---

## Amendment 1 (2026-08-15) — one contract; publishing is optional; `dev` is always gated

The first Open boundary above is **closed**, and the answer removes a conditional rather than adding
one.

**`serve` is the same contract on every machine.** A tenant is either **loopback-only** or
**published-with-a-gate**, and that choice is about **intent, not host**. There is no macOS variant
of the serve rules. The optionality lands in the manifest, not in a per-platform fork:

- `gate`, `zone` and `subdomain` are **optional** manifest fields. Absent means loopback-only.
- A **published** tenant **MUST** declare a `gate`. `gate = "public"` is itself a gate value meaning
  *open, and owns its own auth*, so no published tenant lacks an access policy. Calling such a tenant
  "ungated" is a category error — what it lacks is an **Access application**, which is the
  Gate-vs-Access-application distinction the glossary already draws.
- The health-check contract therefore applies **per mode**: gate-derived for a published tenant, a
  plain loopback `200` otherwise.

**A `dev` Env MUST be `gate = "access"`, even when its `prod` counterpart is `gate = "public"`.**
*Why:* a public prod tenant is a deliberate decision; a publicly reachable half-built dev instance
running against dev credentials is not. The promotion chain makes them the same codebase, so nothing
else stops dev inheriting prod's openness by default.

**`gate = "public"` verifies reachability, not authorization.** The platform can only see that the
tenant answers. If the app's own member auth breaks open and begins serving member-only routes to
guests, every edge check stays green. The tenant owns its auth and therefore owns testing it — stated
in the standard so a green deploy is never read as "auth works."

**Initial platform limit.** On macOS, `serve` supports `kind = "static"` only. This is not a second
contract but a **gap in supervision**: every rule for handing a long-running process to an init
system is systemd-specific, and macOS uses launchd. Lifting it is a launchd half of the
unit-authoring standard, not a change to serve's contract — tracked as **#287**.

*Consequence for the split:* this strengthens the placement decided above. A serve standard that
holds identically on a laptop and a server is genuinely portable, which is the property that made
the tools repo the right owner.

**The `princess-pi-packages` → `princess-pi-tools` rename and visibility flip.** This ADR names
destinations by **role** ("the tools repo"), not by repo name, so it survives the rename without
amendment. The rename is a separate decision and should be sequenced separately, so a bad outcome
in one is isolated from the other.

---

## Roads not taken

**Keep the umbrella.** It genuinely bought something: colocation held the cross-concern couplings
above, and four documents means four places for them to drift. Set aside because the umbrella names
an accident of deployment rather than a domain, and because it would drag serve and the edge along
if the scheduler ever moves to a cloud service — the one migration already anticipated.

**Move the standard whole to the tools repo.** Set aside because it would put the least portable
document in the portfolio — a map of one box — into the repo specifically intended to be forkable
by another developer on another machine.

**Route it to dotfiles-doctor**, per ADR 0001's *"prose, not tooling"* line, since the standard is
264 lines of prose with no executables. Set aside because the tools repo already holds normative
prose (`docs/dev-workflow-spec.md`, cited from `~/git-projects/CLAUDE.md` as authoritative), and
because ADR 0001's own *Open boundary* flagged exactly this reading as unresolved. Host-*specific*
bindings — this box's zones, ports and tenant inventory — do still belong to dotfiles-doctor; they
are simply not what the standard's normative rules are.

**Defer the restructure until subjects exist.** Set aside on the Spec Gate: these documents are the
specs that precede implementation, and a spec is clear only when there is a defined test. Waiting
for subjects inverts the order.

**Run more than one scheduled-work manager**, coordinated by leader election or a distributed lock.
Set aside as over-engineering for one operator: it buys availability — a dead manager no longer
stops the schedule — at the cost of a consensus mechanism to operate, debug, and reason about
during exactly the migration it would be introduced to smooth. The singleton's price is accepted
and named: while the manager is down, nothing runs. That failure is **visible**, where a
split-brain duplicate run is not.

---

## Verification

Each standard earns its boundary by a first implementation that **falsifies its `*Why:*` lines**.
Every MUST in these documents carries a stated reason; those reasons are currently a mix of measured
and speculative, and an implementation is what separates them.

| standard | first implementation | what it must exercise |
|---|---|---|
| serve | **portfolio-api** — `kind = "service"`, member-authored comments | four roots, manifest schema, port pinning, gated health check, publish + reap |
| scheduled work | **the backup Job** — success defined by **restore rehearsal**, not by backup completion | lane selection, cadence, the record, output-schema discipline |
| unit authoring | falls out of both — portfolio-api's `.service` and the backup's `.timer` | whether one appendix serves both, or they want different rules |
| glossary | the first `.tenant.toml` | the key is `subdomain`, never `slug` (rogue-savvy #46 is a live violator) |

The split is **wrong** if the two unit-authoring consumers need divergent rules, or if the serve
standard cannot be stated without reference to the scheduler.

Specific predictions, recorded so they can be checked rather than remembered:

- **§3 port reservation** is currently a known unimplemented gap. The first service tenant shows
  whether it bites in practice or is theoretical.
- **§7** is testable within minutes of the first publish: for `gate = "access"`, a 302 to
  `cloudflareaccess.com` is success and a bare 200 is a loud failure.
- **§4.2–4.4** are already phrased *"Why, measured:"* and should pass trivially. If they do not,
  something in the runtime changed.
- **§1 Placement** does not currently say whether it governs non-served things. `~/.local/state/`
  already holds `big-thoughts-discord`, which uses the state-root convention but is not a tenant.
- **The singleton constraint has no enforcement today** — nothing would prevent a second manager,
  and there is no manager to be second to. The first Job is what forces a lease or heartbeat to
  exist rather than stay declared. Until then it is a wish, by this repo's own standard.
- **The backup Job's success criterion is a restore rehearsal**, not a backup completion, and its
  destination MUST leave the source's failure domain — an on-box lane writing an off-box target.
  Neither is in §9/§10 today; both are expected additions the first implementation forces.
