/**
 * Git Guardrails Extension (#70, #74)
 *
 * Blocks dangerous git commands via Pi's bash-spawn-hook, branch-aware AND
 * push-target-aware:
 *   Always block: checkout ., restore ., clean -f (discard work, any branch)
 *   Block on main/master only: push whose DESTINATION ref is main/master,
 *     bare push / reset --hard when the affected repo is on main/master,
 *     branch -D main/master.
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

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

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
