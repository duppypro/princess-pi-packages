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
// Heredoc delimiters are general shell WORDs, not identifiers — numeric and
// dashed/dotted names are valid (#74 review finding 13b).
const HEREDOC_DELIM_CHARS = /[A-Za-z0-9_.+-]/;

function stripHeredocs(command: string): string {
  const out: string[] = [];
  let delim: string | null = null;
  let dashed = false; // <<- : terminator may be tab-indented (#74 review finding 7)
  let q: "'" | '"' | null = null; // shell quotes span newlines — state persists across lines
  let arith = 0; // inside $(( )) a << is a bit-shift, never a heredoc opener
  for (const line of command.split("\n")) {
    if (delim !== null) {
      const probe = dashed ? line.replace(/^\t+/, "") : line;
      if (probe === delim) delim = null;
      continue;
    }
    // Char-scan for an UNQUOTED opener: '<<EOF' inside quotes is data — a
    // blind regex entered body mode and stripped the real commands after it,
    // failing open (#74 review finding 13a).
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q === "'") {
        if (ch === "'") q = null;
      } else if (q === '"') {
        if (ch === "\\") i++;
        else if (ch === '"') q = null;
      } else if (ch === "\\") {
        i++;
      } else if (ch === "'" || ch === '"') {
        q = ch;
      } else if (line.startsWith("$((", i)) {
        arith++;
        i += 2;
      } else if (arith > 0 && line.startsWith("))", i)) {
        arith--;
        i++;
      } else if (
        arith === 0 &&
        ch === "<" && line[i + 1] === "<" &&
        line[i + 2] !== "<" && line[i - 1] !== "<" // <<< herestring has no body
      ) {
        let j = i + 2;
        let d = false;
        if (line[j] === "-") { d = true; j++; }
        while (j < line.length && /\s/.test(line[j])) j++;
        if (line[j] === "'" || line[j] === '"') j++;
        let word = "";
        while (j < line.length && HEREDOC_DELIM_CHARS.test(line[j])) {
          word += line[j];
          j++;
        }
        if (word) {
          dashed = d;
          delim = word;
          break; // body starts on the next line
        }
        i = j - 1;
      }
    }
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
    if (colon >= 0 && dst === "") {
      // ':' is git's MATCHING refspec — pushes every branch that exists on
      // both sides, main included ('+:' force-updates them). An empty dst
      // never equals 'main', so it needs its own gate (#74 review finding 10)
      return "':' (matching refspec) pushes all matching branches including main/master.";
    }
    if (dst === "HEAD" || dst === "@") {
      // symbolic ref: 'git push origin HEAD' pushes the CURRENT branch to its
      // same-named remote ref — resolve it instead of matching the literal
      // string (#74 review finding 8)
      if (isMainRef(branchOf(cPath, hookCwd))) {
        return "pushes current branch (HEAD) to main/master.";
      }
      continue;
    }
    if (isMainRef(dst)) {
      return `pushes to main/master (ref '${rs}').`;
    }
  }
  return null;
}

// Wrapper binaries that pass execution straight through to git (#74 review
// finding 5), each mapped to its options that consume a SEPARATE argument —
// `sudo -u root git push` must skip 'root' with the '-u', or the unknown word
// bails the scan and the push escapes (#74 review finding 11). Attached
// (-uroot) and =-joined (--user=root) forms are single '-' tokens and need no
// entry here.
const GIT_WRAPPERS = new Map<string, Set<string>>([
  ["command", new Set()],
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["nohup", new Set()],
  ["time", new Set(["-f", "--format", "-o", "--output"])],
  ["timeout", new Set(["-k", "--kill-after", "-s", "--signal"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["setsid", new Set()],
  ["ionice", new Set(["-c", "-n", "-p", "-P", "-u"])],
  ["sudo", new Set(["-u", "-g", "-p", "-h", "-U", "-C", "-D", "-R", "-T", "-t", "-r"])],
  ["doas", new Set(["-u", "-C", "-t"])],
  // exec replaces the shell with the command (#74 review finding 15);
  // -a takes a separate argv[0] argument
  ["exec", new Set(["-a"])],
]);

// Shells whose -c argument is a full nested command string, and eval, which
// re-parses its arguments as a command — both must recurse through the whole
// check, not be skipped as opaque words (#74 review finding 14).
const SHELL_RUNNERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

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

// Path-based invocations (/usr/bin/git, ./git) are still git — match by
// basename, like bash's ${t##*/} (#105 / unified from Macroscope's .sh-only fix).
function isGitWord(t: string): boolean {
  return t.slice(t.lastIndexOf("/") + 1) === "git";
}

// ---
// Command substitutions ($(...) and backticks) EXECUTE their bodies — `echo
// $(git push origin main)` runs the push, it isn't echo data. Single-quoted
// regions are literal and skipped; bodies recurse through the whole check
// (#105 / the command-substitution residual documented at findings 14+15).
// ---
function checkSubstitutions(s: string, hookCwd: string): string | null {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      i++;
      while (i < s.length && s[i] !== "'") i++;
    } else if (ch === "\\") {
      i++;
    } else if (ch === "$" && s[i + 1] === "(") {
      let j = i + 2;
      let depth = 1;
      let q: "'" | '"' | null = null;
      while (j < s.length && depth > 0) {
        const c = s[j];
        if (q === "'") {
          if (c === "'") q = null;
        } else if (q === '"') {
          if (c === "\\") j++;
          else if (c === '"') q = null;
        } else if (c === "\\") {
          j++;
        } else if (c === "'" || c === '"') {
          q = c;
        } else if (c === "(") {
          depth++;
        } else if (c === ")") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      const reason = checkGitCommand(s.slice(i + 2, j), hookCwd);
      if (reason) return reason;
      i = j;
    } else if (ch === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== "`") {
        if (s[j] === "\\") j++;
        j++;
      }
      const reason = checkGitCommand(s.slice(i + 1, j), hookCwd);
      if (reason) return reason;
      i = j;
    }
  }
  return null;
}

function checkGitSubcommand(T: string[], hookCwd: string): string | null {

  // Skip a benign prefix — wrappers, their -options, VAR=val assignments,
  // bare numbers (nice/timeout values) — until 'git'. Anything else means
  // this is not a git invocation ('echo git push …' stays text).
  let i = 0;
  let wrapperArgOpts: Set<string> | null = null; // arg-consuming options of the wrapper we're inside
  while (i < T.length && !isGitWord(T[i])) {
    const t = T[i];
    if (SHELL_RUNNERS.has(t)) {
      // bash -c '<string>' runs a full nested shell command — recurse the
      // whole check on the -c argument (#74 review finding 14). Without -c
      // it's a script-file invocation whose arguments are data.
      for (let j = i + 1; j < T.length; j++) {
        const a = T[j];
        if (a === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
          const nested = T[j + 1];
          return nested ? checkGitCommand(nested, hookCwd) : null;
        }
        if (!a.startsWith("-")) break;
      }
      return null;
    }
    if (t === "eval") {
      // eval concatenates and re-parses its arguments as a shell command
      return checkGitCommand(T.slice(i + 1).join(" "), hookCwd);
    }
    const opts = GIT_WRAPPERS.get(t);
    if (opts) {
      wrapperArgOpts = opts;
      i++;
    } else if (wrapperArgOpts?.has(t)) {
      i += 2; // option + its separate argument (e.g. sudo -u root)
    } else if (
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(t) ||
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
      // git chains -C options: each relative path resolves from the directory
      // established by the previous one (#74 review finding 9)
      const next = T[i + 1] ?? "";
      cPath = cPath && !next.startsWith("/") ? `${cPath}/${next}` : next;
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
    // -D is shorthand for --delete --force: split (-d -f), long
    // (--delete --force), and clustered (-df) spellings force-delete just the
    // same — and EVERY positional is a deletion target, not only the token
    // after the flag (#74 review finding 12). Non-force -d stays allowed: it
    // refuses unless merged, so nothing unrecoverable is lost.
    let deleting = false;
    let forcing = false;
    const targets: string[] = [];
    for (const t of rest) {
      if (t === "--delete") deleting = true;
      else if (t === "--force") forcing = true;
      else if (t.startsWith("--")) {
        // other long option — no force-delete semantics
      } else if (t.startsWith("-") && t.length > 1) {
        if (t.includes("D")) { deleting = true; forcing = true; }
        if (t.includes("d")) deleting = true;
        if (t.includes("f")) forcing = true;
      } else {
        targets.push(t);
      }
    }
    if (deleting && forcing && targets.some(isMainRef)) {
      return "force-deletes main/master branch.";
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

  // Substitution bodies execute — inspect them before the main token walk
  const substReason = checkSubstitutions(stripped, hookCwd);
  if (substReason) return substReason;

  // Split on shell separators; heredoc bodies already stripped.
  // One blocked sub-command blocks the whole command line (fail-safe).
  const subs = splitOutsideQuotes(stripped);
  for (const sub of subs) {
    const reason = checkGitSubcommand(tokenize(sub), hookCwd);
    if (reason) return reason;
  }
  return null;
}

