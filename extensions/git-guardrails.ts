/**
 * Git Guardrails Extension (#70, #74, #303)
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
 * Edit/Write gate (#303): Pi's `tool_call` event fires before a tool executes
 * and CAN block (`return { block: true, reason }`, event.toolName narrows to
 * "edit"/"write", event.input.path is the target file) — confirmed against
 * @earendil-works/pi-coding-agent's shipped .d.ts (ToolCallEvent/ToolCallEventResult
 * in dist/core/extensions/types.d.ts), not assumed. Bash-spawn-hook only sees
 * the Bash tool, so the file-edit hazard #301 explicitly left open ("mode 1":
 * uncommitted Bash-authored edits) needed a second seam. This registers a
 * `tool_call` handler alongside the bash-spawn-hook, wrapping
 * checkEditOnMain() in lib/edit-on-main-core.ts — the Pi twin of
 * hooks/block-edit-on-main.sh, same relationship as checkGitCommand() below.
 * Cross-harness twin: hooks/block-edit-on-main.sh (PreToolUse matcher
 * `Edit|Write|MultiEdit`). Parity: tests/block-edit-on-main-parity.test.ts.
 *
 * Usage:
 *   pi -e ./extensions/git-guardrails.ts
 *
 * Spec: https://github.com/duppypro/princess-pi-packages/issues/74 (supersedes #70 regexes)
 *       https://github.com/duppypro/princess-pi-packages/issues/303 (Edit/Write gate)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { checkGitCommand } from "./lib/git-guardrails-core";
import { checkEditOnMain } from "./lib/edit-on-main-core";
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
  // This fires once, before any tool call, so it stays even though #303 gave
  // Pi a real per-edit block below — an upfront nudge is cheaper than
  // discovering the gate on the first blocked Edit. Also persists a custom
  // entry to the session transcript so ax can surface the metric (ax recall
  // main-branch-warning, future signal).
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

  // Edit/Write gate (#303): the Pi twin of hooks/block-edit-on-main.sh.
  // `tool_call` fires before the tool executes and can block by returning
  // `{ block: true, reason }` — verified in @earendil-works/pi-coding-agent's
  // shipped .d.ts, not assumed (see file header). Only edit/write are gated,
  // matching the Claude Code hook's `Edit|Write|MultiEdit` matcher scope —
  // Pi has no MultiEdit tool, and gating Bash here would deadlock the escape
  // hatch (`git checkout -b <slug>` is itself a Bash command).
  //
  // ctx.cwd (not the module-load-time `cwd` captured above) is used
  // deliberately: it is Pi's per-call notion of "current working directory"
  // and is the closer analogue of the JSON `cwd` field Claude Code passes to
  // block-edit-on-main.sh on every invocation.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const filePath = (event.input as { path?: string }).path;
    if (!filePath) return;
    const reason = checkEditOnMain(filePath, ctx.cwd || cwd);
    if (reason) return { block: true, reason };
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
