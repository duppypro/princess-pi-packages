/**
 * Git Guardrails core decision logic (#70, #74) — harness-independent.
 *
 * Pure functions, no Pi imports, so tests/git-guardrails-parity.test.ts can
 * exercise this directly. The Pi extension (extensions/git-guardrails.ts)
 * wraps checkGitCommand() in a bash-spawn-hook; the Claude Code twin is
 * hooks/block-dangerous-git.sh (install target ~/.claude/hooks/).
 * Keep the .sh in sync — the parity test runs one fixture against both.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

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

// Branch of the repo the sub-command acts on: -C path wins, else hook cwd (#74 under-block fix).
// A relative -C is what git would see from the TOOL-CALL cwd — resolve it there,
// never against this process's own cwd (they differ when the guard runs out-of-repo).
function branchOf(cPath: string, hookCwd: string): string {
  const dir = cPath ? resolve(hookCwd || ".", cPath) : hookCwd;
  return currentBranch(dir);
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
    if (a === "--all" || a === "--branches" || a === "--mirror") {
      // push modes that inherently sweep in main/master (and --mirror can
      // force-update/delete every remote ref) — never safe, block outright
      return `'${a}' pushes/rewrites all refs including main/master.`;
    }
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

