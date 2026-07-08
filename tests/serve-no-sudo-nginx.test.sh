#!/usr/bin/env bash
# Phase 6A (#64) zero-side-effect proof — ASSERTED, not eyeballed.
# A negative ("serve never calls sudo/nginx") is proven by instrumentation:
#   1. PATH shim: fake `sudo` and `nginx` first in PATH write a marker and exit 97.
#      Marker present after a full start/kill cycle => FAIL.
#   2. strace (if installed): no execve of sudo/nginx anywhere in the process tree.
#   3. /etc/nginx must be byte-identical before/after (hash), when it exists.
# Run: bash tests/serve-no-sudo-nginx.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TS() { date -u +"%Y-%m-%d %H:%M:%SZ"; }
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
MARKER="$WORK/forbidden-exec.marker"
SHIM="$WORK/shim"; mkdir -p "$SHIM"
for bin in sudo nginx; do
  printf '#!/bin/sh\necho "CALLED %s $*" >> "%s"\nexit 97\n' "$bin" "$MARKER" > "$SHIM/$bin"
  chmod +x "$SHIM/$bin"
done

SITE="$WORK/site"; mkdir -p "$SITE"; echo "phase6a" > "$SITE/index.html"
# NOTE: deliberately NO .serve-acl — Phase 6A serve must start without one.

etc_hash() { if [ -d /etc/nginx ]; then find /etc/nginx -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1; else echo "no-etc-nginx"; fi; }
BEFORE=$(etc_hash)

echo "[$(TS)] start/kill cycle under PATH shim..."
cd "$SITE"
timeout 60 env PATH="$SHIM:$PATH" node "$OLDPWD/bin/serve.mjs" . >/dev/null 2>&1 || { echo "FAIL: serve start errored/hung (must start without .serve-acl)"; exit 1; }
sleep 1
timeout 60 env PATH="$SHIM:$PATH" node "$OLDPWD/bin/serve.mjs" --kill all >/dev/null 2>&1 || true
cd "$OLDPWD"

if [ -f "$MARKER" ]; then echo "FAIL: forbidden executable invoked:"; cat "$MARKER"; exit 1; fi
echo "[$(TS)] ✓ PATH shim: no sudo/nginx execution"

if command -v strace >/dev/null 2>&1; then
  cd "$SITE"
  timeout 60 strace -f -qq -e trace=execve -o "$WORK/trace" node "$OLDPWD/bin/serve.mjs" . >/dev/null 2>&1 || true
  sleep 1
  timeout 60 strace -f -qq -e trace=execve -o "$WORK/trace2" node "$OLDPWD/bin/serve.mjs" --kill all >/dev/null 2>&1 || true
  cd "$OLDPWD"
  if grep -hE 'execve\("[^"]*(sudo|nginx)' "$WORK/trace" "$WORK/trace2" 2>/dev/null | grep -v ENOENT; then
    echo "FAIL: strace saw sudo/nginx execve"; exit 1
  fi
  echo "[$(TS)] ✓ strace: no execve of sudo/nginx"
else
  echo "[$(TS)] (strace not installed — shim + hash assertions still hold)"
fi

AFTER=$(etc_hash)
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL: /etc/nginx changed ($BEFORE -> $AFTER)"; exit 1; }
echo "[$(TS)] ✓ /etc/nginx unchanged ($BEFORE)"
echo "ZERO-SIDE-EFFECT PROOF PASSED"
