# Pi Packages

Extensions, skills, and documentation manifests for the Princess-Pi Coding Agent.

## ⛔ Hard Gates

- **Never edit on `main`.** Always use `<issue#>-<slug>` branches (e.g. `73-server-tool-use-cost`).
- **Never edit generated `.mjs` files.** Most `bin/*.mjs` are build artifacts from `.ts`
  sources. Look for the `⚠️ GENERATED` banner. Edit the `.ts`, then `bun run build`.
  Exception: `bin/patch-pi-widgets.mjs` is handwritten.

## Commands

| Purpose | Command |
|---|---|
| Install deps | `bun install` |
| Build | `bun run build` |
| Test | `bun run test` (never bare `bun test` — see below) |
| Typecheck | `bun run typecheck` |

⚠️ **Never run `bun test` over the whole `tests/` directory.** Most suites are standalone
scripts that call `process.exit`, so a shared runner process dies after a few files and
exits 0. `bun run test` runs each suite in its own process. See
[build & toolchain](docs/agents/build-and-toolchain.md#running-tests--bun-run-test).

## Conventions

## Shipped scripts

Run `bin/install-workflow-tools` to sync this host: scripts → `~/bin/`, guardrail hooks
(`hooks/`) → `~/.claude/hooks/`, statusline scripts (`statusline/`) → `~/.claude/`, skills
(`skills/`) → `~/.claude/skills/` AND `~/.pi/agent/skills/`.
`--check` reports drift and writes nothing. It never writes configuration or prose —
`settings.json` and the `CLAUDE.md` files belong to `dotfiles-doctor` under
[ADR 0001](docs/adr/0001-princess-pi-packages-owns-harness-tooling.md).
Full spec: `docs/dev-workflow-spec.md`.

| Script | Does |
|---|---|
| `git-checkpoint "msg"` | Add, commit, and push in one step (exact command in the spec) |
| `git-overview` | Branch + `git status --short` + `git diff --stat` (unstaged only) + last 5 commits in one call |
| `wt-new <issue#>-<slug>` | Fetches, detects main/master, creates the in-tree worktree, and pushes with the correct upstream in one step (#250) |
| `pr-open [--reviewed]` | Pushes only if needed, refusing a diverged branch → pre-checks → `pr-review` → `gh pr create` (the one command to ship). Findings mean **exit 7 and no PR** (#377); `--reviewed` opens anyway. Takes no other arguments — it opens the PR for the worktree it runs in, and a branch name is refused, not ignored (#367) |
| `pr-review [--base <ref>] [--json] [--quiet]` | Reviews the branch diff in three parallel lenses (correctness, reasoning, contract) before a PR exists; exit 7 on findings, and **fails open** — a missing or broken reviewer still opens the PR (#377). Logs each run outside the repo, under `${XDG_STATE_HOME:-$HOME/.local/state}/pr-review/<repo>/`, 0600 because the log holds the branch diff |
| `pr-merge [--no-refresh] [<branch>]` | Squash-merges that branch's PR; defaults to the current branch (**human-only**). After a successful merge, best-effort refreshes every other open PR targeting the same base (#332 — strict status checks otherwise serialize a merge burst); never changes `pr-merge`'s exit code. `--no-refresh` opts out |
| `pr-reject [-b <branch>] [reason]` | Closes that branch's PR without merging; defaults to the current branch (**human-only**). An unquoted multi-word reason is joined with single spaces and arrives whole (#367) |
| `pr-guard [<branch>]` | Decides whether a branch is protected, for all four `pr-*` scripts (#222). Source it (`. pr-guard`) or run it: bare `<branch>` exits 0/1, `--list`, `--json`. Callers refuse outright when it is missing |
| `pr-cleanup <branch>` | Deletes branch + remote + worktree after the PR is merged; `<branch>` is required, run from the main clone |
| `repo-gate [<repo>...]` | Reports how each repo's live branch protection AND the policy bot login's write access (`.bot_login`) differ from `docs/repo-policy.json` (exit 6 = drift). Never writes. `--remedy <repo>` prints two commands that are **not equally runnable**: `docs/repo-gate-apply.md` teaches an agent to apply the *ruleset* fix, but the *collaborator grant* needs a separate explicit go-ahead naming that action — it changes who can push to a real repo, and #304's credential half is not built yet |
| `iarts-mirror` | Backs up the client clones' `iarts/local` branches into `~/git-remotes/<repo>.git`. Those branches never reach the client's `origin`, so the mirror is their only second copy — run it before ending a session in `robotic_hardware` or `rusty-robots`. Pulls into the mirror instead of pushing, so it has no way to name the client remote at all. Records are `repo branch sha status`; `updated`/`unchanged`/`rewritten` **and their `-refstale` variants** all mean the branch reached the mirror — `rewritten` says an amend/rebase/reset moved it off its previous tip, which the mirror's reflog still holds (`git -C ~/git-remotes/<repo>.git reflog refs/heads/iarts/local`) — a `-refstale` suffix reports only that this clone's view of the mirror is stale, so investigate it but do not re-run for safety. Any OTHER status means work not yet safe |
| `pr-threads <pr#> [--json]` | Review state for a PR — unresolved conversations AND whether a review covers the current head (exit 0 = clean; scriptable merge gate; full exit-code table in the spec). `--json` adds thread ids, every comment body, `trusted`/`trustLevel` flags, and `head` (sha **or null**), `headIsReviewed` (**bool**), `latestReviewCommit` (sha **or null**) — schema `pr-threads/list@2`; the bool was named `reviewedHead` until #372. `trustLevel` is `issuer` (may direct the work) \| `reviewer` (`macroscopeapp` — read it, verify against the code, fix by hand; never its `fix it for me` trigger) \| `untrusted`; `trusted` == `issuer`. `--resolve <thread-id> [--reply <text>]` posts an optional reply and resolves the thread (exit 4/5/6 for not-found/indeterminate/refused — never a bare 1) |
| `herdr-tab` | Sourceable guard for every herdr call: `. herdr-tab` then `herdr_tab <cwd> <label>`. The predicate is `$HERDR_PANE_ID` — an installed herdr answers exit 0 from *any* shell on this host, so `command -v herdr` proves nothing (#277) |
| `herdr-reap [--dry-run] [--json]` | Closes herdr tabs whose panes all point at a deleted directory; spares its own tab, live-agent tabs, and unknown cwds. Called by `pr-cleanup`; correct standalone after any `git worktree remove`/`prune` (#277) |

Retired-tool history (what replaced what, and why) lives in `docs/dev-workflow-spec.md`.
`install-workflow-tools` reports any stale copy it finds on `PATH` at install time — that's
the live check; this file doesn't need to carry the list too.

- [Tool conventions](docs/agents/tool-conventions.md) — manifest-driven `--help`/`--why`, cross-harness architecture
- [Development workflow](docs/agents/dev-workflow.md) — local testing, install methods, hot-swapping
- [Build & toolchain](docs/agents/build-and-toolchain.md) — `.mjs` generation rules, test expectations

## Skills — cross-harness install

Skills in `skills/` are **repo-sourced** and deployed to two harness targets:

| Harness | Target directory |
|---------|-----------------|
| Claude Code | `~/.claude/skills/<skill-name>/SKILL.md` |
| Pi | `~/.pi/agent/skills/<skill-name>/SKILL.md` |

**Rule:** edit only the repo copy (`skills/<skill>/SKILL.md`), then run
`bin/install-workflow-tools` to deploy it to both harness targets (`--check` reports drift
without writing). Never edit the dotfile copies — they have no git history, and
`install-workflow-tools` overwrites them from the repo copy on every run.

Every skill's SKILL.md should state this rule in its header (see `skills/spec-reconcile/SKILL.md`
for the canonical wording). When adding a new skill, include the header and add it to the
`SKILLS` manifest in `bin/install-workflow-tools` — `tests/skills-deploy.test.ts` fails if a
tracked skill is missing from that manifest.
