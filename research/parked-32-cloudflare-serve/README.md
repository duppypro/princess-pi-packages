# Parked: `32-cloudflare-serve` road-not-taken → see #116

Two ideas rescued from the superseded `32-cloudflare-serve` branch (an earlier #32 attempt,
~80% superseded by what shipped in **#64** teardown + **#66** per-slug automation) before the
branch was deleted. **These are archived drafts, not production code** — hence `research/`.

**Why / when to revive: [#116](https://github.com/duppypro/princess-pi-packages/issues/116).**

## What's here (original repo paths preserved)

- **`infra/terraform/`** — declarative IaC alternative to the shipped imperative reconciler.
  `core/` (account-wide once: IdPs + CI service token) + `machine/` (per host: tunnel +
  `for_each` shares → DNS + Access app + policy + ingress); state in Terraform Cloud. `serve`
  would write `serve-shares.auto.tfvars.json` and `terraform apply`. **Never tested; pinned to
  `cloudflare/cloudflare ~> 4.52` — provider v5 renamed resources to `cloudflare_zero_trust_*`.**
- **`extensions/lib/serve/acl-cascade.js`** (+ `tests/serve-acl-cascade.test.ts`) — a cascade
  `.serve-acl` resolver: effective allow-list = union of every `.serve-acl` from the served dir
  up to `$HOME`. Nicer than `main`'s flat per-dir model; independent of the Terraform idea.

## Trade-off in one line
Terraform buys **declarative / auditable / drift-correcting / multi-host** at the cost of a
**heavier toolchain + `terraform apply` latency per serve**. The shipped imperative path buys
**instant / dependency-light / single-VPS**. Revive when serve outgrows one box or the
reconciler keeps accreting edge cases (see #116 for the full trigger list).

## Provenance
Source branch `32-cloudflare-serve` @ `47a1c53` (deleted after parking). Superseded by
`infra/deploy/RUNBOOK_CLOUDFLARE_TUNNEL_SERVE.md` + the shipped `extensions/lib/serve/cloudflare.js`.
