/**
 * Git Guardrails Extension (#70, #74)
 *
 * Blocks dangerous git commands via Pi's bash-spawn-hook, branch-aware AND
 * push-target-aware:
 *   Always block: checkout ., restore ., clean -f (discard work, any branch)
 *   Block on main/master only: push whose DESTINATION ref is main/master,
 *     bare push / reset --hard when the affected repo is on main/master,
 *     branch -D main/master; and (#301) commit / merge / rebase / cherry-pick /
 *     am / pull when the affected repo is on main/master — main advances only
 *     through PRs. Allowed there: --ff-only (pull/merge), every --abort/--quit,
 *     checkout -b / switch -c (the escape; can never deadlock). Line-state for
 *     cd/pushd and checkout -b/switch -c lives in lib/git-guardrails-core.ts.
 *
 * Why token parsing (#74): the old greedy regex `push\s+.*\b(main|master)\b`
 * spanned the whole command line, so any co-occurrence of the words blocked
 * (compound `&& gh pr create --base main`, branch names like `main-refactor`,
 * heredocs merely mentioning both words). It ALSO under-blocked: the current
 * branch was resolved from the hook cwd only, so `git -C <path> push` with
 * <path> on main slipped through. Fix: strip heredoc bodies, split on shell
 * separators, inspect each `git … push` sub-command's refspec tokens, and
 * resolve the branch from `-C <path>` when present.
 *
 * Cross-harness twin: hooks/block-dangerous-git.sh (canonical source; install
 * target ~/.claude/hooks/). Keep logic in sync — tests/git-guardrails-parity.test.ts
 * runs the same fixture (tests/fixtures/git-guardrails-cases.json) against both.
 *
 * Usage:
 *   pi -e ./extensions/git-guardrails.ts
 *
 * Spec: https://github.com/duppypro/princess-pi-packages/issues/74 (supersedes #70 regexes)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { checkGitCommand } from "./lib/git-guardrails-core";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- Ax feedback log (#124): record sessions that start on main ---
const AX_LOG = path.join(os.homedir(), ".pi", "agent", "logs", "main-branch-sessions.jsonl");
function logMainBranchSession(cwd: string, branch: string) {
  try {
    const dir = path.dirname(AX_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      cwd,
      branch,
      harness: "pi",
      hook: "git-guardrails-session-start",
    }) + "\n";
    fs.appendFileSync(AX_LOG, entry);
  } catch { /* logging is best-effort */ }
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // Session-start branch check (#124): warn if cwd is on main/master.
  // Claude Code already blocks edits on main via PreToolUse hook
  // (block-edit-on-main.sh); this is the Pi-side equivalent — it can't
  // block, but it puts the reminder front-and-center before any work.
  // Also persists a custom entry to the session transcript so ax can
  // surface the metric (ax recall main-branch-warning, future signal).
  pi.on("session_start", async (_event, ctx) => {
    try {
      const inside = execSync("git rev-parse --is-inside-work-tree", { cwd, encoding: "utf8", timeout: 3000 }).trim();
      if (inside !== "true") return;
      const branch = execSync("git branch --show-current", { cwd, encoding: "utf8", timeout: 3000 }).trim();
      if (branch === "main" || branch === "master") {
        logMainBranchSession(cwd, branch);
        pi.appendEntry("main-branch-warning", { branch, cwd });
        ctx.ui.notify(
          `⛔ On branch '${branch}' — create a feature branch before editing.\n` +
          `   git checkout -b <issue#>-<slug>\n` +
          `   (CLAUDE.md HARD GATE — editing on main risks lossy stash/checkout recovery.)`,
          "warning"
        );
      }
    } catch { /* not a git repo, or git not available — silent */ }
  });

  const bashTool = createBashTool(cwd, {
    spawnHook: ({ command, cwd: hookCwd, env }) => {
      const reason = checkGitCommand(command, hookCwd);
      if (reason) {
        throw new Error(`BLOCKED: '${command}' — ${reason}`);
      }
      // Pass through unchanged if nothing matched
      return { command, cwd: hookCwd, env };
    },
  });

  pi.registerTool({
    ...bashTool,
    execute: async (id, params, signal, onUpdate, _ctx) => {
      return bashTool.execute(id, params, signal, onUpdate);
    },
  });
}
