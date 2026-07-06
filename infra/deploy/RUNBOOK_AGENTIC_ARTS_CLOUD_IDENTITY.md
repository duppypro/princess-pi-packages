# Runbook: agentic-arts.ai agent accounts → Cloud Identity Free

Convert three agent-persona accounts (Sadie, Hank, Chief-Agent-Wrangler) in the
`agentic-arts.ai` Google Workspace from paid **Business Starter** seats to free
**Cloud Identity Free** licenses — dropping the Workspace bill to a single paid seat
(`duppy@agentic-arts.ai`) — while all three agents keep an independent Google login and
their inbound mail still lands in the single `duppy@agentic-arts.ai` mailbox.

## Why this shape (the one gotcha to understand first)
An address can be a **login identity** OR an **alias of your mailbox**, not both. Giving each
agent its own Google Auth means each agent address is owned by *its own user object*, so it
**cannot** be an alias of `duppy@`. A Cloud Identity Free user has **no Gmail inbox**, so mail
to `sadie@` would hard-bounce — *unless* a Gmail **Default Routing** rule rewrites the
envelope recipient to `duppy@agentic-arts.ai`. That routing rule is the mechanism that lands
all agent mail in your single box. It works because Gmail is enabled org-wide (via your one
paid seat), even though the three agent users don't have Gmail themselves.

## Assumptions baked into this runbook (flip these if wrong)
- **Send-as: YES.** You want to send/reply *as* each agent address from `duppy@`, not just
  receive. (If receive-only, skip Phase 4 entirely.)
- **Data safety: INSPECT FIRST.** We assume the agent mailboxes *might* hold mail/Drive worth
  keeping, so Phase 1 is a STOP to check/export before anything is unassigned. (If you know
  they're empty, you can approve past that STOP immediately.)
- Collection mailbox = **`duppy@agentic-arts.ai`** (in-domain, DKIM-aligned) — NOT
  `duppypro@gmail.com`. This is independent of the duppy.com/interfacearts.com MTA runbook,
  which keeps forwarding to `duppypro@gmail.com`.

## How to use this file
Paste the **"Agent Prompt"** block below into a **fresh Claude Cowork** session (do not add it
to the MTA-migration session). You (Duppy) drive all logins, passwords, and 2FA yourself.

---

## Agent Prompt

```
You are helping Duppy (David Proctor) reconfigure Google Workspace for the domain
agentic-arts.ai in the Google Admin console (admin.google.com) and Gmail. The goal is to
convert three agent-persona accounts from paid seats to free Cloud Identity Free, while
keeping their mail flowing into one mailbox. This touches licensing and mail routing on a
live domain — a wrong step can delete a mailbox or drop inbound mail. Follow these rules:

GUARDRAILS
- Never enter or view a password, 2FA code, or recovery code. If a login screen appears,
  stop and ask Duppy to authenticate, then wait for his confirmation before continuing.
- Before unassigning any license, changing any routing rule, or adding any send-as, show
  Duppy the exact before/after and wait for explicit "yes, do it" before clicking save.
- Do the phases in order. Do not start Phase N+1 until Duppy confirms Phase N passed.
- If the Admin console UI doesn't match what's described (Google moves things), stop and
  describe what you see instead of guessing.

ACCOUNTS IN SCOPE
- KEEP PAID (do not touch its license): duppy@agentic-arts.ai (Business Starter).
- CONVERT TO FREE: sadie@agentic-arts.ai, hank@agentic-arts.ai,
  chief-agent-wrangler@agentic-arts.ai   (confirm the exact usernames with Duppy first;
  the wrangler address may be spelled differently).

=== PHASE 1: Data safety check (STOP before any change) ===
For each of the three agent accounts, in Admin console > Directory > Users > (user), and/or
by having Duppy open the account, determine whether it holds any Gmail messages or Drive
files worth keeping.
STOP: report per account what you find. If ANY account has data to keep, ask Duppy to run
Google Takeout / export it FIRST and confirm the export completed before you go on. Do not
unassign any license until Duppy explicitly says the data is safe (or that there's nothing
to keep).

=== PHASE 2: Stop future auto-licensing (do this BEFORE unassigning) ===
Admin console > Billing > Subscriptions (or Billing > License settings) > find the
automatic licensing setting for Google Workspace Business Starter. Turn OFF automatic
license assignment for new users, so newly created agent accounts default to Cloud
Identity Free instead of silently consuming a paid $8.40 seat.
STOP: show Duppy the setting's before/after state and confirm.

=== PHASE 3: Unassign Workspace licenses (the actual conversion) ===
For EACH of the three agent accounts (one at a time, verifying after each):
1. Admin console > Directory > Users > (agent user) > Licenses.
2. Turn OFF / unassign "Google Workspace Business Starter". The user should fall back to
   "Cloud Identity Free" automatically. If Cloud Identity Free is not offered, stop and
   tell Duppy (the org may need Cloud Identity enabled first).
3. Confirm the user still exists and can still be a login identity (Cloud Identity Free =
   login yes, Gmail/Drive no).
STOP after each account: show Duppy the license state before moving to the next.
NOTE: at this point mail to these three addresses will BOUNCE until Phase 3b routing is in
place. Keep the gap short — do Phase 3b immediately after.

=== PHASE 3b: Route agent mail into duppy@agentic-arts.ai (Default Routing) ===
Admin console > Apps > Google Workspace > Gmail > Routing (Default routing / Recipient
address map). Add a rule (or recipient-address-map entries) so that mail whose envelope
recipient is any of:
     sadie@agentic-arts.ai
     hank@agentic-arts.ai
     chief-agent-wrangler@agentic-arts.ai
is delivered to duppy@agentic-arts.ai (change/redirect envelope recipient to duppy@).
Do NOT add a catch-all. Only these three named addresses route.
STOP: show Duppy the rule(s). Then have him send a test message from an outside account TO
each of the three agent addresses and confirm each lands in the duppy@agentic-arts.ai
inbox (and does NOT bounce) before continuing.

=== PHASE 4: Send-as for each agent address (in duppy@'s Gmail) ===
In Gmail as duppy@agentic-arts.ai > Settings > Accounts > "Send mail as" > Add another
email address, for each of:
     sadie@agentic-arts.ai
     hank@agentic-arts.ai
     chief-agent-wrangler@agentic-arts.ai
Use "Send through Gmail" (not an external SMTP). Google emails a confirmation link to each
address; because Phase 3b routes those addresses to duppy@, the link lands in this same
inbox — Duppy clicks it to verify.
STOP: after all three verify, have Duppy send a test FROM each agent address and confirm it
delivers and is not spam-flagged.

TARGET END STATE (compare against this before declaring done):
| Account                         | License              | Gmail inbox | Inbound mail          | Send-as from duppy@ |
|---------------------------------|----------------------|-------------|-----------------------|---------------------|
| duppy@agentic-arts.ai           | Business Starter (paid) | yes      | own mailbox           | n/a (it's the box)  |
| sadie@agentic-arts.ai           | Cloud Identity Free  | no          | routed -> duppy@      | yes                 |
| hank@agentic-arts.ai            | Cloud Identity Free  | no          | routed -> duppy@      | yes                 |
| chief-agent-wrangler@a-a.ai     | Cloud Identity Free  | no          | routed -> duppy@      | yes                 |
Billing target: exactly ONE paid Business Starter seat. Auto-licensing OFF for new users.

When all phases pass, summarize the final license + routing + send-as state for all four
accounts and compare against the table above. Flag any mismatch to Duppy explicitly rather
than declaring success silently.
```

---

## Reference: final target state (human sanity check)

| Account | License | Gmail | Inbound | Send-as |
|---|---|---|---|---|
| `duppy@agentic-arts.ai` | Business Starter (paid, $8.40) | yes | own box | — |
| `sadie@agentic-arts.ai` | Cloud Identity Free ($0) | no | routed → `duppy@` | yes |
| `hank@agentic-arts.ai` | Cloud Identity Free ($0) | no | routed → `duppy@` | yes |
| `chief-agent-wrangler@agentic-arts.ai` | Cloud Identity Free ($0) | no | routed → `duppy@` | yes |

**Bill:** 4 paid seats → 1 paid seat. **Auto-licensing:** OFF (so new agents don't silently eat a seat).

## Notes / roads not taken
- **Plain aliases** (add `sadie@` as an alias on `duppy@`) — simplest for mail, $0, but the
  address then has *no independent Google login*. Road not taken because you want each agent
  to authenticate to Google as itself.
- **Keep paying** — no routing complexity, full Gmail per agent. Road not taken on cost
  ($8.40 × 3 = $25.20/mo for inboxes you consolidate into one anyway).
- The unassign is **sticky**: once a user drops to Cloud Identity Free, the identity persists
  and the free license can't be cleanly removed later. Acceptable here — these are permanent
  personas.
