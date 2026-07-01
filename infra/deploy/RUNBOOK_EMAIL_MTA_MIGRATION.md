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

When all phases are done, summarize final state for all three domains (MX, SPF, DMARC,
routing rules, send-as relay) so Duppy can sanity-check against this runbook.
```

---

## Reference: final target state (for your own sanity check)

| Domain | MX | SPF | DMARC | Email Routing | Send-as relay |
|---|---|---|---|---|---|
| `duppy.com` | Cloudflare routing MX | `include:_spf.google.com include:_spf.mx.cloudflare.net` | `p=none` | 1 named rule → Gmail | Gmail |
| `interfacearts.com` | Cloudflare routing MX | same | `p=none` | 1 named rule → Gmail | Gmail |
| `agentic-arts.ai` | `1 smtp.google.com` (unchanged) | `include:_spf.google.com` | `p=none` | not enabled | n/a (Workspace native) |
