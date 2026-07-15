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

// Push options that consume a following argument
const PUSH_ARG_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);

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
    if (a === "--repo") {
      // --repo IS the remote (git's repository argument) — record it so the
      // following positionals are refspecs, not a remote (#74 review finding 4)
      remote = tokens[++i] ?? "-";
    } else if (a.startsWith("--repo=")) {
      remote = a.slice("--repo=".length) || "-";
    } else if (PUSH_ARG_OPTIONS.has(a)) {
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

// Wrapper binaries that pass execution straight through to git (#74 review finding 5)
const GIT_WRAPPERS = new Set([
  "command", "env", "nice", "nohup", "time", "timeout",
  "stdbuf", "setsid", "ionice", "sudo", "doas",
]);

// ---
// Quote-aware lexing (#74 review finding 6): separators inside quotes are
// data, not command boundaries — `printf "note\ngit push origin main\n"`
// must yield ONE printf command, never a synthetic git push. Tokens keep
// quoted content but drop the quote chars, so `git push origin "main"`
// is seen as pushing main (the old naive split let quoted refs slip).
// ---

/** Split at unquoted `&&`, `||`, `;`, `|`, `&`, and newlines. */
function splitOutsideQuotes(s: string): string[] {
  const subs: string[] = [];
  let cur = "";
  let q: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") {
      cur += ch;
      if (ch === "'") q = null;
    } else if (q === '"') {
      cur += ch;
      if (ch === "\\") cur += s[++i] ?? "";
      else if (ch === '"') q = null;
    } else if (ch === "\\") {
      cur += ch + (s[++i] ?? "");
    } else if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
    } else if (ch === "\n" || ch === ";") {
      subs.push(cur);
      cur = "";
    } else if (ch === "&" || ch === "|") {
      if (s[i + 1] === ch) i++; // && or ||
      subs.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  subs.push(cur);
  return subs;
}

/** Whitespace-split honoring quotes: quoted content is kept, quote chars dropped. */
function tokenize(sub: string): string[] {
  const toks: string[] = [];
  let cur = "";
  let q: "'" | '"' | null = null;
  let quoted = false; // saw quotes → emit token even if content is empty
  for (let i = 0; i < sub.length; i++) {
    const ch = sub[i];
    if (q === "'") {
      if (ch === "'") q = null;
      else cur += ch;
    } else if (q === '"') {
      if (ch === "\\") cur += sub[++i] ?? "";
      else if (ch === '"') q = null;
      else cur += ch;
    } else if (ch === "\\") {
      cur += sub[++i] ?? "";
    } else if (ch === "'" || ch === '"') {
      q = ch;
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (cur || quoted) {
        toks.push(cur);
        cur = "";
        quoted = false;
      }
    } else {
      cur += ch;
    }
  }
  if (cur || quoted) toks.push(cur);
  return toks;
}

function checkGitSubcommand(T: string[], hookCwd: string): string | null {

  // Skip a benign prefix — wrappers, their -options, VAR=val assignments,
  // bare numbers (nice/timeout values) — until 'git'. Anything else means
  // this is not a git invocation ('echo git push …' stays text).
  let i = 0;
  while (i < T.length && T[i] !== "git") {
    const t = T[i];
    if (
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(t) ||
      GIT_WRAPPERS.has(t) ||
      t.startsWith("-") ||
      /^[0-9]+[A-Za-z]*$/.test(t)
    ) {
      i++;
    } else {
      return null;
    }
  }
  if (i >= T.length) return null;
  i++;

  // git global options before the subcommand; capture -C <path>
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
    return null;
  }
  // Always blocked on any branch (discard uncommitted/untracked work).
  // Token-based (#74 review finding 3): whitespace-agnostic, catches the
  // '--' pathspec separator and split flag forms the old literal-space
  // regexes missed — and stops false-blocking dotfile pathspecs like
  // 'git checkout .gitignore' (only the bare '.' token wipes everything).
  if (cmd === "checkout" || cmd === "restore") {
    if (rest.includes(".")) {
      return `discards uncommitted work ('git ${cmd} .', always blocked).`;
    }
    return null;
  }
  if (cmd === "clean") {
    for (const t of rest) {
      if (t === "--force" || (t.startsWith("-") && !t.startsWith("--") && t.includes("f"))) {
        return "discards untracked files (forced git clean, always blocked).";
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

  // Split on shell separators; heredoc bodies already stripped.
  // One blocked sub-command blocks the whole command line (fail-safe).
  const subs = splitOutsideQuotes(stripped);
  for (const sub of subs) {
    const reason = checkGitSubcommand(tokenize(sub), hookCwd);
    if (reason) return reason;
  }
  return null;
}

