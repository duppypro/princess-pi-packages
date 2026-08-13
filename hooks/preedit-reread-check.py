#!/usr/bin/env python3
# ---
# Pre-Edit exact-match verifier (ax hook__56ca752923612703).
# PreToolUse hook for Edit|MultiEdit. Converts a doomed exact-match edit into a
# single first-try-correct retry by returning an ACTIONABLE message instead of
# letting the model flail through the native tool's terse "not found" error.
#
# Design principle — near-zero false positives (fail-OPEN):
#   Blocks ONLY edits the native Edit tool would ALSO reject:
#     * old_string not present, not even whitespace-normalized  -> stale model
#     * old_string present >1x without replace_all              -> ambiguous
#   A whitespace-DRIFT case (exact miss but fuzzy-present) is ALLOWED through —
#   Claude's tolerant matcher may handle it, so we never false-block it.
#   Any parse/read error -> allow. It can only ever save a failed round-trip,
#   never break a would-succeed edit.
#
# Self-logging (why): backtest can't faithfully replay a content-match verdict
#   (historical old_string vs today's file = noise). So the FAITHFUL measurement
#   is live: every evaluated decision is appended to preedit.jsonl. Read the real
#   hit/false-positive rate at the next ax retro. Logging is fail-open — a broken
#   log never affects the allow/block verdict. ("Always be logging.")
#
# Disable: remove the Edit|MultiEdit matcher from ~/.claude/settings.json.
# ---
import sys, json, re, os, datetime

LOG_PATH = os.path.expanduser("~/.claude/hooks/logs/preedit.jsonl")

def allow():
    sys.exit(0)

def collapse(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()

def log_decision(decision: str, file_path, reasons):
    # Fail-open: a logging failure must NEVER change the verdict.
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        rec = {
            "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "hook": "hook__56ca752923612703",
            "file": file_path,
            "decision": decision,   # "block" | "allow"
            "reasons": reasons,     # e.g. ["absent"], ["ambiguous"], or []
        }
        with open(LOG_PATH, "a") as fh:
            fh.write(json.dumps(rec) + "\n")
    except Exception:
        pass

try:
    data = json.load(sys.stdin)
except Exception:
    allow()

ti = (data.get("tool_input") or {})
file_path = ti.get("file_path") or ti.get("path")
if not file_path or not os.path.isfile(file_path):
    allow()  # new-file Write, or unreadable target -> let the tool handle it

try:
    with open(file_path, "r", errors="replace") as fh:
        content = fh.read()
except Exception:
    allow()

collapsed_content = collapse(content)

def problem(old, replace_all, label=""):
    """Return (kind, message) iff this edit is DEFINITELY doomed, else None.
    kind is a short code for the log: 'absent' | 'ambiguous'."""
    if not old:
        return None
    n = content.count(old)
    if n == 1:
        return None                       # will succeed
    if n > 1:
        if replace_all:
            return None                   # replace_all handles multiplicity
        return ("ambiguous",
                f"{label}`old_string` matches {n}x in the file — not unique. Add a few "
                f"surrounding lines to make it unique, or set replace_all:true if you mean all.")
    # n == 0
    if collapse(old) in collapsed_content:
        return None                       # whitespace drift — let the tolerant matcher try
    return ("absent",
            f"{label}`old_string` is not in the file (not even ignoring whitespace) — the file "
            f"has changed since you last modeled it. Re-read {os.path.basename(file_path)} "
            f"(or the target region) and copy the exact current bytes before editing.")

msgs = []      # actionable stderr lines
kinds = []     # short codes for the log
evaluated = 0  # count of non-empty old_strings we actually checked

def consider(old, replace_all, label=""):
    global evaluated
    if old:
        evaluated += 1
    r = problem(old, replace_all, label)
    if r:
        kinds.append(r[0])
        msgs.append(r[1])

edits = ti.get("edits")
if isinstance(edits, list) and edits:            # MultiEdit
    for i, e in enumerate(edits):
        consider(e.get("old_string"), e.get("replace_all", False), label=f"edit[{i}]: ")
else:                                            # Edit
    consider(ti.get("old_string"), ti.get("replace_all", False))

if msgs:
    log_decision("block", file_path, kinds)
    print("Pre-Edit check — this edit will fail as written; fix it now to save a retry:",
          file=sys.stderr)
    for m in msgs:
        print("  - " + m, file=sys.stderr)
    sys.exit(2)

# Only log allows that actually evaluated a real old_string (skip Write / empty noise).
if evaluated:
    log_decision("allow", file_path, [])
allow()
