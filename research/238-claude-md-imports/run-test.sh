#!/usr/bin/env bash
# Reproducible fixture for #238 — does CLAUDE.md import another file's content?
#
# Builds three scratch project directories and runs each harness's headless
# print mode against them, printing whether a token planted only in an
# imported/referenced file is visible in the loaded context.
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
printf 'DISTINCTIVE_TOKEN_ABC789 is present in the imported file.\n' > "$SCRATCH/basic/imported.md"

# --- Fixture 2: import of a missing file ------------------------------------
mkdir -p "$SCRATCH/missing"
printf 'See @./missing-file-xyz.md for context.\n' > "$SCRATCH/missing/CLAUDE.md"

# --- Fixture 3: external (outside-cwd) absolute-path import -----------------
mkdir -p "$SCRATCH/external" "$SCRATCH/home-fixture"
printf 'DISTINCTIVE_TOKEN_HOMEFILE_555 is present.\n' > "$SCRATCH/home-fixture/machine.md"
printf 'See @%s/home-fixture/machine.md for machine facts.\n' "$SCRATCH" > "$SCRATCH/external/CLAUDE.md"

ask() {
  echo "Is the string $1 anywhere in your loaded context/instructions? Answer with just yes or no, then quote the token if yes."
}

echo
echo "== Claude Code =="

echo "-- basic relative import (expect: yes) --"
(cd "$SCRATCH/basic" && claude -p "$(ask DISTINCTIVE_TOKEN_ABC789)")

echo "-- import of a missing file (expect: no error, session proceeds) --"
(cd "$SCRATCH/missing" && claude -p "Just say OK.")

echo "-- external absolute-path import, headless/non-interactive (expect: no — approval dialog can't fire, so the import stays disabled) --"
(cd "$SCRATCH/external" && claude -p "$(ask DISTINCTIVE_TOKEN_HOMEFILE_555)")

echo
echo "== Pi (@earendil-works/pi-coding-agent) =="
echo "-- same basic-import fixture (expect: no — Pi does not expand @path at all, confirmed by reading core/resource-loader.js's loadContextFileFromDir, which readFileSync()s the raw file with no import parsing) --"
(cd "$SCRATCH/basic" && pi --provider anthropic -p "$(ask DISTINCTIVE_TOKEN_ABC789)") || true
