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
import { execSync } from "node:child_process";

// --- Helpers ---

function currentBranch(cwd: string): string {
  try {
    return execSync("git branch --show-current", { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function isMainRef(ref: string): boolean {
  return (
    ref === "main" ||
    ref === "master" ||
    ref === "refs/heads/main" ||
    ref === "refs/heads/master"
  );
}

// Branch of the repo the sub-command acts on: -C path wins, else hook cwd (#74 under-block fix)
function branchOf(cPath: string, hookCwd: string): string {
  return currentBranch(cPath || hookCwd);
}

// ---
// Drop heredoc bodies so quoted text like `<<EOF\ngit push origin main\nEOF`
// is never mistaken for a command (#74 false-positive class 3).
// ---
function stripHeredocs(command: string): string {
  const open = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/;
  const out: string[] = [];
  let delim: string | null = null;
  for (const line of command.split("\n")) {
    if (delim !== null) {
      if (line === delim) delim = null;
      continue;
    }
    const m = open.exec(line);
    if (m) delim = m[1];
    out.push(line);
  }
  return out.join("\n");
}

// --- Always-blocked patterns (discard uncommitted work, any branch) ---

const ALWAYS_BLOCKED: RegExp[] = [
  /\bgit\s+checkout\s+\.\B/,
  /\bgit\s+restore\s+\.\B/,
  /\bgit\s+clean\s+-fd\b/,
  /\bgit\s+clean\s+-f\b/,
];

// Push options that consume a following argument
const PUSH_ARG_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

// ---
// Push-target parsing (#74): returns a block reason, or null to allow.
// ---
function checkPush(tokens: string[], cPath: string, hookCwd: string): string | null {
  let remote = "";
  const refspecs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (PUSH_ARG_OPTIONS.has(a)) {
      i++; // skip the option's argument
    } else if (a.startsWith("-")) {
      // flag, no argument consumed
    } else if (!remote) {
      remote = a;
    } else {
      refspecs.push(a);
    }
  }

  if (refspecs.length === 0) {
    // Bare push (at most a remote): the affected repo's current branch decides
    if (isMainRef(branchOf(cPath, hookCwd))) {
      return "pushes current branch main/master.";
    }
    return null;
  }

  for (let rs of refspecs) {
    if (rs.startsWith("+")) rs = rs.slice(1); // +refspec force marker
    const colon = rs.lastIndexOf(":");
    const dst = colon >= 0 ? rs.slice(colon + 1) : rs; // src:dst — destination decides
    if (isMainRef(dst)) {
      return `pushes to main/master (ref '${rs}').`;
    }
  }
  return null;
}

function checkGitSubcommand(sub: string, hookCwd: string): string | null {
  const T = sub.trim().split(/\s+/);
  if (T[0] !== "git") return null;

  // git global options before the subcommand; capture -C <path>
  let i = 1;
  let cPath = "";
  while (i < T.length) {
    const t = T[i];
    if (t === "-C") {
      cPath = T[i + 1] ?? "";
      i += 2;
    } else if (t === "-c") {
      i += 2;
    } else if (t.startsWith("-")) {
      i += 1;
    } else {
      break;
    }
  }
  const cmd = T[i] ?? "";
  const rest = T.slice(i + 1);

  if (cmd === "push") {
    return checkPush(rest, cPath, hookCwd);
  }
  if (cmd === "reset" && rest.includes("--hard")) {
    if (isMainRef(branchOf(cPath, hookCwd))) {
      return "hard-resets on main/master.";
    }
    return null;
  }
  if (cmd === "branch") {
    for (let j = 0; j < rest.length - 1; j++) {
      if (rest[j] === "-D" && isMainRef(rest[j + 1])) {
        return "deletes main/master branch.";
      }
    }
  }
  return null;
}

/**
 * Decide whether a shell command is a dangerous git operation.
 * Returns the block reason, or null to allow.
 * Exported so tests/git-guardrails-parity.test.ts can run the shared
 * fixture against this implementation directly.
 */
export function checkGitCommand(command: string, hookCwd: string): string | null {
  const stripped = stripHeredocs(command);

  for (const pattern of ALWAYS_BLOCKED) {
    if (pattern.test(stripped)) {
      return "discards uncommitted work (always blocked).";
    }
  }

  // Split on shell separators; heredoc bodies already stripped.
  // One blocked sub-command blocks the whole command line (fail-safe).
  const subs = stripped.split(/&&|\|\||;|\||\n/);
  for (const sub of subs) {
    const reason = checkGitSubcommand(sub, hookCwd);
    if (reason) return reason;
  }
  return null;
}

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
