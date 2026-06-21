#!/usr/bin/env bash
# --- Sandbox acceptance test for bin/merge.ts single-checkout fallback (issue #8).
# Builds a bare "remote" + single-checkout clone (NO main worktree), then drives the
# real merge tool through success + error paths. Throwaway: lives in /tmp.
set -u
MERGE="/home/princess-pi/git-projects/princess-pi-packages/bin/merge.ts"
RUN(){ node --experimental-strip-types "$MERGE" "$@"; }
ROOT=/tmp/merge-sandbox
PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
no(){ echo "  ❌ $1"; FAIL=$((FAIL+1)); }

fresh(){
  rm -rf "$ROOT/remote.git" "$ROOT/work"
  git init -q --bare "$ROOT/remote.git"
  git clone -q "$ROOT/remote.git" "$ROOT/work"
  cd "$ROOT/work"
  git config user.email t@t; git config user.name t
  git checkout -q -b main
  echo A > file.txt; git add -A; git commit -qm "init"
  git push -q -u origin main
  git checkout -q -b feature
}
step5(){ git commit -qm "Code and Spec Approved (Step 5): $1"; }

echo "=== TEST 1: happy path (single-checkout fallback) ==="
fresh
echo B > file.txt; git add -A; step5 "feature work"; git push -q -u origin feature
RUN HEAD >/tmp/merge-sandbox/t1.log 2>&1
git fetch -q origin
# main on origin must now contain feature's commit:
if git merge-base --is-ancestor feature origin/main; then ok "origin/main advanced to include feature"; else no "origin/main did NOT advance"; fi
[ "$(git rev-parse --abbrev-ref HEAD)" = "feature" ] && ok "returned to feature branch" || no "not back on feature (on $(git rev-parse --abbrev-ref HEAD))"
[ -z "$(git status --porcelain)" ] && ok "tree clean after" || no "tree dirty after"

echo "=== TEST 2: reject non-Step-5 HEAD ==="
fresh
echo B > file.txt; git add -A; git commit -qm "Code Draft: not approved"; git push -q -u origin feature
if RUN HEAD >/tmp/merge-sandbox/t2.log 2>&1; then no "should have failed"; else ok "exited non-zero"; fi
grep -q "not a Step 5" /tmp/merge-sandbox/t2.log && ok "Step-5 rejection message present" || no "missing Step-5 message"
[ "$(git rev-parse --abbrev-ref HEAD)" = "feature" ] && ok "still on feature" || no "left feature branch"

echo "=== TEST 3: reject dirty tree ==="
fresh
echo B > file.txt; git add -A; step5 "x"; git push -q -u origin feature
echo dirty >> file.txt   # uncommitted change
if RUN HEAD >/tmp/merge-sandbox/t3.log 2>&1; then no "should have failed on dirty"; else ok "exited non-zero on dirty"; fi
grep -q "not clean" /tmp/merge-sandbox/t3.log && ok "dirty message present" || no "missing dirty message"

echo "=== TEST 4: reject unpushed commit ==="
fresh
echo B > file.txt; git add -A; step5 "unpushed"   # NOT pushed
if RUN HEAD >/tmp/merge-sandbox/t4.log 2>&1; then no "should have failed on unpushed"; else ok "exited non-zero on unpushed"; fi
grep -q "has not been pushed" /tmp/merge-sandbox/t4.log && ok "unpushed message present" || no "missing unpushed message"

echo "=== TEST 5: merge conflict -> abort + return to feature, origin/main unchanged ==="
fresh
echo B > file.txt; git add -A; step5 "conflicting"; git push -q -u origin feature
# advance origin/main with a conflicting change via a second clone
git clone -q "$ROOT/remote.git" "$ROOT/work2"; cd "$ROOT/work2"
git config user.email t@t; git config user.name t; git checkout -q main
echo C > file.txt; git add -A; git commit -qm "other main change"; git push -q origin main
MAIN_BEFORE=$(git rev-parse origin/main)
cd "$ROOT/work"
if RUN HEAD >/tmp/merge-sandbox/t5.log 2>&1; then no "should have failed on conflict"; else ok "exited non-zero on conflict"; fi
[ "$(git rev-parse --abbrev-ref HEAD)" = "feature" ] && ok "returned to feature after conflict" || no "stranded off feature (on $(git rev-parse --abbrev-ref HEAD))"
[ -z "$(git status --porcelain)" ] && ok "no leftover merge state" || no "leftover merge/conflict state"
cd "$ROOT/work2"; git fetch -q origin
[ "$(git rev-parse origin/main)" = "$MAIN_BEFORE" ] && ok "origin/main NOT advanced on conflict" || no "origin/main wrongly advanced"

echo; echo "=== RESULT: PASS=$PASS FAIL=$FAIL ==="
exit $((FAIL>0))
