/**
 * Git Guardrails Extension
 *
 * Blocks dangerous git commands via Pi's bash-spawn-hook, branch-aware:
 *   Always block: checkout ., restore ., clean -f (discard work, any branch)
 *   Block on main/master only: push to main, reset --hard on main, branch -D main
 *
 * Shares the same logic as the Claude Code PreToolUse hook
 * (~/.claude/hooks/block-dangerous-git.sh).
 *
 * Usage:
 *   pi -e ./extensions/git-guardrails.ts
 *   # or auto-loaded via princess-pi-packages if registered in package manifest
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

// --- Helpers ---

function currentBranch(cwd: string): string {
  try {
    return execSync("git branch --show-current", { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function isMain(branch: string): boolean {
  return branch === "main" || branch === "master";
}

// --- Always-blocked patterns (discard uncommitted work, any branch) ---

const ALWAYS_BLOCKED: RegExp[] = [
  /\bgit\s+checkout\s+\.\b/,
  /\bgit\s+restore\s+\.\b/,
  /\bgit\s+clean\s+-fd\b/,
  /\bgit\s+clean\s+-f\b/,
];

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  const bashTool = createBashTool(cwd, {
    spawnHook: ({ command, cwd: hookCwd, env }) => {
      // --- Always-blocked ---
      for (const pattern of ALWAYS_BLOCKED) {
        if (pattern.test(command)) {
          throw new Error(
            `BLOCKED: '${command}' discards uncommitted work (always blocked).\nMatched: ${pattern}`
          );
        }
      }

      // --- Branch-aware: git push ---
      if (/\bgit\s+push\b/.test(command)) {
        const branch = currentBranch(hookCwd);

        // Explicit push to main/master
        if (/push\s+.*\b(main|master)\b/.test(command)) {
          throw new Error(
            `BLOCKED: '${command}' pushes to main/master.`
          );
        }

        // --force push to main/master
        if (/\bgit\s+push\b.*(--force|-f)\b/.test(command)) {
          if (/(--force|-f)\s+.*\b(main|master)\b/.test(command) ||
              /\b(main|master)\b.*(--force|-f)\b/.test(command)) {
            throw new Error(
              `BLOCKED: '${command}' force-pushes to main/master.`
            );
          }
          if (isMain(branch)) {
            throw new Error(
              `BLOCKED: '${command}' force-pushes to main/master (current branch).`
            );
          }
        }

        // Bare 'git push' — check current branch
        if (!/push\s+\S+\s+\S+/.test(command)) {
          if (isMain(branch)) {
            throw new Error(
              `BLOCKED: '${command}' pushes to main/master (current branch).`
            );
          }
        }
      }

      // --- Branch-aware: git reset --hard ---
      if (/\bgit\s+reset\s+--hard\b/.test(command)) {
        const branch = currentBranch(hookCwd);
        if (isMain(branch)) {
          throw new Error(
            `BLOCKED: '${command}' hard-resets on main/master.`
          );
        }
      }

      // --- Branch-aware: git branch -D ---
      if (/\bgit\s+branch\s+-D\b/.test(command)) {
        if (/branch\s+-D\s+(main|master)\b/.test(command)) {
          throw new Error(
            `BLOCKED: '${command}' deletes main/master branch.`
          );
        }
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
