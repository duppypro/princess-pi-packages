# Runbook: Email MTA Migration (duppy.com, interfacearts.com, agentic-arts.ai)

## How to use this file
Paste the **"Agent Prompt"** section below into **Claude Cowork** (or **Claude in Chrome**
if Cowork isn't available) as the opening instruction. It is written to be handed to that
agent directly — it explains the goal, the guardrails, and the phases.

You (Duppy) drive: log into Hover / Cloudflare / Gmail yourself, enter passwords and 2FA
yourself. The agent's job is to navigate to the right screen, tell you what to click, or
click it once you've confirmed the account context is correct. **Never let the agent type
a password or 2FA code on your behalf — do the credential steps yourself.**

Work through phases in order. Do not let the agent skip a checkpoint marked **STOP**.

---

## Agent Prompt

```
You are helping Duppy (David Proctor) migrate email DNS/routing for two domains
(duppy.com, interfacearts.com) and patch a third (agentic-arts.ai), across the Hover,
Cloudflare, and Gmail dashboards. This is a real production email cutover — mistakes
can cause lost mail or spoofable domains. Follow these rules:

GUARDRAILS
- Never enter or view a password, 2FA code, or recovery code. If a login screen appears,
  stop and ask Duppy to authenticate, then wait for him to confirm before continuing.
- Before any DNS record change, MX change, nameserver change, routing rule change, or
  mailbox deletion, show Duppy the exact before/after value and wait for explicit
  "yes, do it" before clicking save/confirm.
- Do the phases in order. Do not start Phase N+1 until Duppy confirms Phase N's
  verification step passed.
- If a UI doesn't match what's described below (Hover/Cloudflare change their layouts),
  stop and describe what you see instead of guessing.

GOAL
- duppy.com and interfacearts.com: currently Hover-hosted mailboxes. Target end state:
  Cloudflare DNS + Cloudflare Email Routing forwarding two NAMED addresses (no catch-all)
  to duppypro@gmail.com, with Gmail "send mail as" relaying through Google instead of
  Hover SMTP. Hover mailbox is decommissioned only after verification.
- agentic-arts.ai: already Google Workspace (MX smtp.google.com, DKIM present). Do NOT
  touch its MX or move it to Cloudflare Email Routing. Only add missing SPF + DMARC
  records, once its NS is moved to Cloudflare (DNS-only, no routing).

=== PHASE 1: Hover safety net (duppy.com AND interfacearts.com) ===
For each domain, in the Hover dashboard:
1. Go to Email > the mailbox (duppy@duppy.com / david@interfacearts.com) > Forwarding.
   Set it to forward A COPY of incoming mail to duppypro@gmail.com (not "forward and
   delete" — the Hover inbox must keep receiving too, as a fallback).
2. Go to Domains > <domain> > DNS. Find the MX record. Edit TTL to 300 seconds.
STOP: ask Duppy to send a test email to each address from an outside account and confirm
it landed in BOTH the Hover webmail inbox AND duppypro@gmail.com before continuing.

=== PHASE 2: Move DNS to Cloudflare, keep mail on Hover ===
For each domain (duppy.com, interfacearts.com, AND agentic-arts.ai):
1. In Cloudflare dashboard: Add a site > enter domain > Free plan > let it auto-scan.
2. Compare the scanned records against Hover's DNS list (open Hover DNS tab side by side).
   Confirm MX, the SPF TXT, and the "mail" CNAME (for duppy.com/interfacearts.com) or the
   MX + google._domainkey DKIM + google-site-verification TXT (for agentic-arts.ai) are
   all present. If anything is missing, add it manually before proceeding.
3. Set the live A / www records to DNS-only (grey cloud, not orange/proxied).
4. Cloudflare will show 2 nameservers for this zone. Note them.
STOP: show Duppy the 2 nameservers and the record comparison. Wait for "yes, proceed"
before changing anything at the registrar.
5. In Hover: Domains > <domain> > Edit Nameservers > replace with the 2 Cloudflare
   nameservers > save.
6. Wait for the Cloudflare zone to show "Active" (can take minutes to hours).
Mail is UNCHANGED in this phase — it's still flowing via the preserved MX record,
regardless of who answers DNS. Do this for all three domains before moving to Phase 3.

=== PHASE 3a: agentic-arts.ai — SPF/DMARC only, no routing ===
In Cloudflare DNS for agentic-arts.ai, add these TWO records (do not touch MX, do not
enable Email Routing on this domain):
  TXT @      "v=spf1 include:_spf.google.com ~all"
  TXT _dmarc "v=DMARC1; p=none; rua=mailto:duppypro@gmail.com;"
STOP: confirm with Duppy these were added and MX still reads "1 smtp.google.com" before
moving on.

=== PHASE 3b: duppy.com and interfacearts.com — Email Routing (named addresses only) ===
For each domain, in Cloudflare > Email > Email Routing:
1. Verify destination address duppypro@gmail.com if not already verified (Google will
   email a confirmation link — Duppy clicks it himself).
2. Add routing rules — NAMED ADDRESSES ONLY, NO CATCH-ALL:
     duppy@duppy.com          -> forward to duppypro@gmail.com   (for duppy.com)
     david@interfacearts.com  -> forward to duppypro@gmail.com   (for interfacearts.com)
   Do not create a catch-all rule. Any other address should NOT be forwarded.
3. Let Cloudflare update the MX records to its routing MX values (it offers to do this
   automatically when you enable routing — confirm before it applies).
4. Add DNS records:
     TXT @      "v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all"
     TXT _dmarc "v=DMARC1; p=none; rua=mailto:duppypro@gmail.com;"
STOP: show Duppy the final MX + rule list per domain before saving/enabling.

=== PHASE 4: Repoint Gmail send-as, verify, decommission Hover ===
1. In Gmail (duppypro@gmail.com) > Settings > Accounts and Import > "Send mail as":
   edit duppy@duppy.com and david@interfacearts.com. Change the SMTP relay away from
   Hover to "Send through Gmail" (Google's own relay).
2. STOP: ask Duppy to verify for 2-3 days:
   - Send TO each address from an outside account -> confirm it arrives in Gmail.
   - Send FROM each address via Gmail send-as -> confirm it's delivered, not spam-flagged.
   - Check the Hover mailbox for any stragglers.
3. Only after Duppy explicitly confirms verification passed: go to Hover > Email >
   cancel/delete the duppy@duppy.com and david@interfacearts.com mailboxes.
STOP: do not do step 3 without an explicit "go ahead and decommission" from Duppy.

TARGET END STATE (compare your final result against this table before declaring done):
| Domain             | MX                      | SPF (apex TXT)                                              | DMARC (_dmarc TXT) | Email Routing        | Send-as relay |
|---------------------|-------------------------|---------------------------------------------------------------|---------------------|-----------------------|----------------|
| duppy.com           | Cloudflare routing MX   | v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all | p=none              | 1 named rule -> Gmail | Gmail          |
| interfacearts.com   | Cloudflare routing MX   | (same as above)                                                | p=none              | 1 named rule -> Gmail | Gmail          |
| agentic-arts.ai     | 1 smtp.google.com (unchanged) | v=spf1 include:_spf.google.com ~all                      | p=none              | not enabled           | n/a (Workspace)|

When all phases are done, summarize the final state for all three domains (MX, SPF,
DMARC, routing rules, send-as relay) and compare it against the table above. Flag any
mismatch to Duppy explicitly rather than declaring success silently.
```

---

## Reference: final target state (for your own sanity check)

| Domain | MX | SPF | DMARC | Email Routing | Send-as relay |
|---|---|---|---|---|---|
| `duppy.com` | Cloudflare routing MX | `include:_spf.google.com include:_spf.mx.cloudflare.net` | `p=none` | 1 named rule → Gmail | Gmail |
| `interfacearts.com` | Cloudflare routing MX | same | `p=none` | 1 named rule → Gmail | Gmail |
| `agentic-arts.ai` | `1 smtp.google.com` (unchanged) | `include:_spf.google.com` | `p=none` | not enabled | n/a (Workspace native) |

---

## Addendum: agent-account Cloud Identity conversion

**Separate task from the four phases above.** Run it only *after* Phase 4 is verified and
done — it touches a different domain's mail flow (agentic-arts.ai, in the Google Admin
console), and juggling two live mail cutovers at once risks lost mail.

**Why:** `duppy@agentic-arts.ai` stays a full paid Business Starter seat. The three
agent-persona accounts (`sadie@`, `hank@`, `chief-agent-wrangler@`) drop to **free Cloud
Identity** — keeping their independent Google logins but losing Gmail/Drive/Calendar — so
the Workspace bill falls to a single paid seat. A Gmail Default Routing rule redirects all
three agent addresses into `duppy@agentic-arts.ai`, and Gmail "send mail as" lets Duppy
reply as each agent.

**Road not taken:** plain aliases of `duppy@` would route mail natively with no routing
rule, but give no separate Google login. The independent-identity requirement is the whole
reason for the Cloud Identity path; drop that need and aliases are simpler.

**Ordering rule that matters:** set up routing FIRST, remove licenses LAST. Unassigning a
Gmail license leaves the user with no mailbox while MX still points to Google, so mail to
that address bounces unless the routing rule is already live and tested.

Paste the block below into Claude Cowork as its own task (not chained to the runbook above):

```
You are helping Duppy (David Proctor) convert three agent-persona accounts in the
agentic-arts.ai Google Workspace from paid Business Starter seats to FREE Cloud Identity
licenses, while keeping their mail flowing into his single mailbox. This is separate from
the domain-migration runbook and touches the Google Admin console (admin.google.com).

ACCOUNTS: sadie@agentic-arts.ai, hank@agentic-arts.ai, chief-agent-wrangler@agentic-arts.ai
KEEP PAID: duppy@agentic-arts.ai stays a full Business Starter user — do not touch it.
MAIL TARGET: all three agent addresses must deliver into duppy@agentic-arts.ai.

GUARDRAILS
- Never enter or view a password, 2FA, or recovery code. Stop at any login screen and let
  Duppy authenticate.
- Before any routing-rule save, license change, or user change, show the exact before/after
  and wait for explicit "yes, do it".
- Do the phases in order. Do NOT remove any license until routing is set up AND tested.
- Never DELETE a user account (that destroys the Google login Duppy is keeping). We only
  UNASSIGN the paid license, which drops the user to free Cloud Identity.
- If the Admin console layout differs from what's described, stop and describe what you see.

=== STEP 1: Routing rule (do this FIRST, before any license change) ===
In Admin console > Apps > Google Workspace > Gmail > Routing (Default routing):
1. Add a rule for each agent address that matches envelope recipient
   sadie@agentic-arts.ai / hank@agentic-arts.ai / chief-agent-wrangler@agentic-arts.ai
   and CHANGES the envelope recipient to duppy@agentic-arts.ai (redirect delivery).
   (A single rule with all three recipients matched is fine if the UI allows it.)
STOP: while the three agent accounts STILL have their mailboxes, send a test email from an
outside account to each of the three addresses and confirm each one lands in
duppy@agentic-arts.ai. Do not proceed until all three test messages arrive.

=== STEP 2: Send-as, so Duppy can reply as each agent ===
In Gmail (duppy@agentic-arts.ai) > Settings > Accounts > "Send mail as", add each of the
three agent addresses, "Send through Gmail" (Google relay, not an external SMTP).
- Google emails a verification code to each agent address. Because Step 1 routing is live,
  those codes now land in duppy@agentic-arts.ai. Duppy enters each code himself.
STOP: confirm all three addresses show "verified" in Send-as before continuing.

=== STEP 3: Drop each agent to Cloud Identity Free (billing change) ===
In Admin console > Billing (or Users > the user > Licenses):
1. For sadie@, hank@, chief-agent-wrangler@: UNASSIGN the Google Workspace Business Starter
   license. If Cloud Identity Free is not auto-assigned, assign it manually.
2. Confirm duppy@agentic-arts.ai still holds its Business Starter license.
STOP: show Duppy the billing/subscription summary — it should now show 1 Business Starter
seat, not 4. Confirm the three agent logins still exist (they keep their Google identity).

=== STEP 4: Post-change verification ===
1. Re-send a test email to each of the three agent addresses -> confirm it still lands in
   duppy@agentic-arts.ai (routing survives the license removal — this is the key check).
2. Send FROM each agent address via Gmail send-as -> confirm delivered, not spam-flagged.
STOP: report the final state to Duppy — 1 paid seat, 3 free Cloud Identity users, 3 routing
rules delivering to duppy@, 3 verified send-as addresses. Flag any mismatch explicitly.
```
