# WTFT "Other" Bloat Alerts — Spec (#17)

## Summary
Add proactive warnings when the "Other" category grows too large, and enhance `wtft-other` with semantic command sub-classification.

---

## Design

### 1. Proactive "Other" Bloat Warning

**Trigger (dual condition, both must be true):**
- `other` spend > 20% of total session cost
- AND absolute `other` spend > $6.00 (the "coffee/beer" index)

**Behavior:**
- Appended as a warning line to the widget output (in `buildWtftLines()`)
- Line format: `⚠️  "Other" category: X% of session cost ($Y.YY). Run wtft-other to drill down.`
- Also displayed in CLI mode as a stderr notice
- No interactive prompt, no automated suggestions — just a clear reminder to run `wtft-other`

**Implementation location:**
- `buildWtftLines()` in `extensions/lib/wtft-shared.ts` — computes total session cost and other percentage, appends warning line when threshold exceeded
- Pi widget: the line appears in the TUI widget (no change needed — just an extra line in the returned array)
- CLI: the line appears in stdout

### 2. Semantic Command Sub-Classification

**New function: `getSemanticCommandGroup(command: string): string | null`**

Maps bare command names to semantic groups:

| Group | Commands |
|---|---|
| Build & Bundling | npm run, npx, esbuild, webpack, vite, tsc, make, gcc, cargo build, go build, pnpm build, yarn build, bun build, node, tsx, ts-node |
| Dependency Management | npm install, npm ci, npm update, yarn, pnpm install, pip install, cargo add, go get, gem install, brew, apt-get, apt |
| Linting & Formatting | eslint, prettier, black, rustfmt, shfmt, biome, stylelint, shellcheck, ruff, flake8 |
| Testing | jest, vitest, pytest, cargo test, npm test, yarn test, pnpm test, go test, cypress, playwright, mocha |
| Database & Infrastructure | sqlite3, psql, mysql, docker, kubectl, aws, terraform, gh, git push, git clone, fly, railway |
| System & File Utilities | ls, mkdir, cp, rm, mv, chmod, chown, touch, cat, head, tail, wc, du, df, find, grep, rg, which, echo, pwd, cd, ln, stat |
| Git Operations | git commit, git add, git status, git diff, git log, git branch, git checkout, git stash, git rebase, git merge, git fetch, git pull, git remote, git config, git worktree, git rev-parse |
| Session & Agent | pi, node, python, bash, zsh, clear, exit |

**Modified `renderOtherHistogram()`:**
- Groups commands by semantic category
- Shows category headers with subtotals
- Within each category, shows individual commands sorted by count descending
- Falls back to flat list if no semantic group matches

**Output format:**
```
--- 'Other' Command Histogram ---

[Build & Bundling]  (12 calls, $1.2345)
  npm run    (8) : ########
  tsc        (3) : ###
  npx        (1) : #

[System & File Utilities]  (8 calls, $0.0567)
  ls         (5) : #####
  cat        (2) : ##
  mkdir      (1) : #

[Unclassified]  (3 calls, $0.1234)
  unknown-cmd (3) : ###
```

### 3. Edge Cases
- Empty "Other" category → no warning
- "Other" < 20% or absolute < $6.00 → no warning
- All "Other" commands match known groups → no [Unclassified] section
- No "Other" commands → "No 'Other' commands found" (existing behavior unchanged)

### 4. What is NOT in scope
- Automated suggestion mapping (the warning just says "run wtft-other")
- Expanding `classifyInteraction` to add new first-class categories
- Interactive prompts in the widget
- Updating `wtft-cmd.json` manifest (existing `--other` / `-o` flag unchanged)
