#!/usr/bin/env bash
# Reproducible fixture for #238 — does CLAUDE.md import another file's content?
#
# Builds three scratch project directories and runs each harness's headless
# print mode against them, printing whether a magic code planted only in an
# imported/referenced file is visible in the loaded context.
#
# The magic code never appears in the prompt itself — only in the fixture
# file — so a model can't answer "yes" just by echoing back the question. A
# probe that got this wrong would pass for the wrong reason: the sentinel
# text is always present the moment it's asked about, so a prompt like "is
# TOKEN123 in your context?" is true of the current message regardless of
# whether the import expanded. (Caught by PR #239 review.)
#
# Re-run this after a Claude Code or Pi upgrade to re-check the answer in
# docs/research/claude-md-imports.md still holds.
set -euo pipefail

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

echo "== fixtures in $SCRATCH =="

# --- Fixture 1: basic relative @import -------------------------------------
mkdir -p "$SCRATCH/basic"
printf 'See @./imported.md for context.\n' > "$SCRATCH/basic/CLAUDE.md"
printf 'MAGIC CODE: FLAMINGO42\n' > "$SCRATCH/basic/imported.md"

# --- Fixture 2: import of a missing file ------------------------------------
mkdir -p "$SCRATCH/missing"
printf 'See @./missing-file-xyz.md for context.\n' > "$SCRATCH/missing/CLAUDE.md"

# --- Fixture 3: external (outside-cwd) absolute-path import -----------------
mkdir -p "$SCRATCH/external" "$SCRATCH/home-fixture"
printf 'MAGIC CODE: NARWHAL99\n' > "$SCRATCH/home-fixture/machine.md"
printf 'See @%s/home-fixture/machine.md for machine facts.\n' "$SCRATCH" > "$SCRATCH/external/CLAUDE.md"

# Fixed, generic prompt — never contains a magic code itself, so a truthful
# answer requires the file actually having been loaded, not just re-reading
# the question.
PROMPT='Search everything currently loaded into your context or instructions — NOT this message — for a line starting with "MAGIC CODE:". If you find one, reply with ONLY the code that follows it. If nothing in your loaded context has a magic code, reply with exactly: NONE'

# Runs $2.. in dir $1, never lets a nonzero exit kill the script (set -e-safe),
# and always prints an explicit outcome — a probe failure is reported, not
# silently swallowed into an empty, indistinguishable-from-"NONE" result.
run_probe() {
  local label="$1" dir="$2"
  shift 2
  local out status
  set +e
  out="$(cd "$dir" && "$@" 2>&1)"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "-- $label --"
    echo "⚠ probe exited status=$status — treat as NO RESULT, not as evidence of NONE:"
    echo "$out"
    return
  fi
  echo "-- $label --"
  echo "$out"
}

echo
echo "== Claude Code =="

run_probe "basic relative import (expect: FLAMINGO42)" "$SCRATCH/basic" claude -p "$PROMPT"
run_probe "import of a missing file (expect: no error, session proceeds)" "$SCRATCH/missing" claude -p "Just say OK."
run_probe "external absolute-path import, headless/non-interactive (expect: NONE — approval dialog can't fire, so the import stays disabled)" "$SCRATCH/external" claude -p "$PROMPT"

echo
echo "== Pi (@earendil-works/pi-coding-agent) =="
# --no-extensions: an unrelated pre-existing bug in this machine's wtft
# extension (a session-end timer touching a stale ctx) throws after the
# answer prints, turning a clean probe into a nonzero exit. Disabling
# extensions avoids it — CLAUDE.md/AGENTS.md loading doesn't involve them.
run_probe "same basic-import fixture (expect: NONE — Pi does not expand @path at all, confirmed by reading core/resource-loader.js's loadContextFileFromDir, which readFileSync()s the raw file with no import parsing)" "$SCRATCH/basic" pi --provider anthropic --no-extensions -p "$PROMPT"
