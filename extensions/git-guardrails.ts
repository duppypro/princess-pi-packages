/**
 * Git Guardrails Extension
 *
 * Blocks dangerous git commands via Pi's bash-spawn-hook before execution.
 * Shares the same pattern list as the Claude Code PreToolUse hook
 * (~/.claude/hooks/block-dangerous-git.sh).
 *
 * Blocked commands:
 *   git push (all variants including --force)
 *   git reset --hard
 *   git clean -f / git clean -fd
 *   git branch -D
 *   git checkout .
 *   git restore .
 *
 * When blocked, returns an error message explaining the block.
 *
 * Usage:
 *   pi -e ./extensions/git-guardrails.ts
 *   # or auto-loaded via princess-pi-packages if registered in package manifest
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";

// --- Shared pattern list (keep in sync with ~/.claude/hooks/block-dangerous-git.sh) ---

const DANGEROUS_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fd\b/,
  /\bgit\s+clean\s+-f\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+checkout\s+\.\b/,
  /\bgit\s+restore\s+\.\b/,
  /\bpush\s+--force\b/,
  /\breset\s+--hard\b/,
];

const BLOCK_MESSAGE =
  "BLOCKED: This command matches a dangerous git pattern. " +
  "The user has configured git guardrails to prevent destructive operations " +
  "(push, reset --hard, clean -f, branch -D, checkout/restore .). " +
  "If you need to perform this operation, ask the user to run it manually.";

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  const bashTool = createBashTool(cwd, {
    spawnHook: ({ command, cwd, env }) => {
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          // Block execution by throwing — the tool's execute() will surface
          // this as a tool error visible to the agent.
          throw new Error(`${BLOCK_MESSAGE}\nMatched: ${pattern}\nCommand: ${command}`);
        }
      }
      // Pass through unchanged if no pattern matched
      return { command, cwd, env };
    },
  });

  pi.registerTool({
    ...bashTool,
    execute: async (id, params, signal, onUpdate, _ctx) => {
      return bashTool.execute(id, params, signal, onUpdate);
    },
  });
}
