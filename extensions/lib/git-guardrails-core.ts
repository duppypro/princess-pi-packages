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
// --git-dir selects the affected repo just like -C (finding 17): HEAD is read
// from it, so it decides the branch. git resolves --git-dir relative to the
// directory the -C chain established. (--work-tree does NOT move HEAD — the
// branch still comes from the discovered/declared git dir — so it is skipped,
// not captured.)
function branchOf(cPath: string, hookCwd: string, gitDir = ""): string {
  const dir = cPath ? resolve(hookCwd || ".", cPath) : hookCwd;
  if (gitDir) {
    try {
      return execSync("git branch --show-current", {
        cwd: dir || ".",
        encoding: "utf8",
        env: { ...process.env, GIT_DIR: resolve(dir || ".", gitDir) },
      }).trim();
    } catch {
      return "";
    }
  }
  return currentBranch(dir);
}

// ---
// Line-state (#301). The hook runs BEFORE the line executes, so every
// sub-command would otherwise be judged against the tool-call cwd and the
// branch that repo is on right now. Two things an earlier sub-command in the
// same line changes for the later ones:
//   cwd  — `cd`/`pushd <path>` moves the effective cwd; `cd -`/`popd`/bare
//          `pushd` reset it to the tool-call cwd (fail-safe: never guess).
//   lift — `checkout -b|-B|--orphan` / `switch -c|-C|--orphan <name>` mark
//          the repo they ran in as being on <name> for the rest of the line
//          (so `git checkout -b 301-slug && git commit` is allowed on main);
//          a plain `checkout main` / `switch main` marks it as on main (so
//          `git checkout main && git commit` is blocked from a feature branch).
//          A plain `checkout <other>` does NOT lift: the positional may be a
//          path (file restore) and guessing fails open.
// The lift is keyed to the repo that switched (-C/--git-dir/cwd resolved), so
// `git -C other checkout -b x && git commit` still judges the cwd repo.
// ---
export interface LineState {
  cwd: string;
  origCwd: string;
  liftKey: string;
  liftBranch: string;
}

function repoKey(cPath: string, cwd: string, gitDir: string): string {
  const dir = cPath ? resolve(cwd || ".", cPath) : cwd;
  return `${dir}|${gitDir ? resolve(dir || ".", gitDir) : ""}`;
}

/** Branch the sub-command acts on, honouring an earlier switch in the same line. */
function effectiveBranch(cPath: string, st: LineState, gitDir = ""): string {
  if (st.liftKey && st.liftKey === repoKey(cPath, st.cwd, gitDir)) return st.liftBranch;
  return branchOf(cPath, st.cwd, gitDir);
}

/** `cd`/`pushd`/`popd` as the FIRST word of a sub-command moves the effective cwd. */
function applyCd(T: string[], st: LineState): boolean {
  const w = T[0]?.slice(T[0].lastIndexOf("/") + 1);
  if (w !== "cd" && w !== "pushd" && w !== "popd") return false;
  const home = process.env.HOME || "";
  const arg = T.slice(1).find((t) => !t.startsWith("-") || t === "-");
  if (w === "popd" || arg === "-" || (w === "pushd" && arg === undefined)) {
    st.cwd = st.origCwd; // previous directory is unknowable here — never guess
  } else if (arg === undefined || arg === "~") {
    st.cwd = home;
  } else if (arg.startsWith("~/")) {
    st.cwd = resolve(home, arg.slice(2));
  } else {
    st.cwd = resolve(st.cwd || ".", arg);
  }
  return true;
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
function checkPush(tokens: string[], cPath: string, st: LineState, gitDir: string): string | null {
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
    if (isMainRef(effectiveBranch(cPath, st, gitDir))) {
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
      if (isMainRef(effectiveBranch(cPath, st, gitDir))) {
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
  // long separate-argument forms included (finding 18): --user root etc.
  // (=-joined --user=root is a single '-' token and needs no entry)
  ["sudo", new Set([
    "-u", "-g", "-p", "-h", "-U", "-C", "-D", "-R", "-T", "-t", "-r",
    "--user", "--group", "--host", "--prompt", "--other-user",
    "--chdir", "--chroot", "--close-from", "--role", "--type", "--command-timeout",
  ])],
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
    } else if (ch === "\n" || ch === ";" || ch === "(" || ch === ")") {
      // '(' / ')' outside quotes open/close a subshell group — split there so
      // `(cd wt && git commit)` exposes both the cd and the commit (#301).
      // `$(…)` bodies were already inspected by checkSubstitutions.
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

// Both guarded programs. The benign-prefix walk stops at either, so a wrapper
// it knows how to skip cannot hide one and expose the other (#208/#189).
function isGuardedWord(t: string): boolean {
  const base = t.slice(t.lastIndexOf("/") + 1);
  return base === "git" || base === "gh";
}

// ---
// Command substitutions ($(...) and backticks) EXECUTE their bodies — `echo
// $(git push origin main)` runs the push, it isn't echo data. Single-quoted
// regions are literal and skipped; bodies recurse through the whole check
// (#105 / the command-substitution residual documented at findings 14+15).
// ---
function checkSubstitutions(s: string, hookCwd: string): string | null {
  // Double-quote state is load-bearing (#208/#105): inside "…" an apostrophe is
  // ORDINARY TEXT, not a quote delimiter, while $( ) and ` ` still expand. The
  // scan used to treat every ' as opening a literal region, so the first
  // apostrophe in `echo "it's $(git push)"` opened a skip that ran to the next
  // ' and swallowed the substitution — the tokenizer then saw only `echo`.
  let inDq = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
    } else if (ch === '"') {
      inDq = !inDq;
    } else if (ch === "'" && !inDq) {
      i++;
      while (i < s.length && s[i] !== "'") i++;
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

/**
 * Result of walking past a command's benign prefix.
 *  - "start": the prefix is stripped; T[i] is the real command word.
 *  - "verdict": the walk answered the question by itself — either the prefix was
 *    a nested shell string that has already been fully re-checked, or the line
 *    is not a guarded invocation at all. `reason` is the final answer.
 */
type PrefixScan =
  | { kind: "start"; i: number }
  | { kind: "verdict"; reason: string | null };

/**
 * Skip a benign prefix — wrappers, their -options, VAR=val assignments, bare
 * numbers (nice/timeout values) — and stop at the first real command word.
 * Anything unrecognized means this is not a guarded invocation at all
 * ('echo git push …' stays text).
 *
 * Shared by the git and gh checks on purpose (#208/#189). It used to live
 * inside checkGitSubcommand, so `gh` was matched against a raw T[0] and every
 * wrapper this function knows about — `sudo gh pr merge`, `env gh pr merge`,
 * `GH_HOST=… gh pr merge` — walked straight through the human-only merge gate.
 * One parser, two consumers: a wrapper learned here is understood by both.
 */
function skipBenignPrefix(T: string[], hookCwd: string): PrefixScan {
  let i = 0;
  let wrapperArgOpts: Set<string> | null = null; // arg-consuming options of the wrapper we're inside
  while (i < T.length && !isGuardedWord(T[i])) {
    const t = T[i];
    // Runners and wrappers must match by basename like git itself does —
    // /bin/sh and /usr/bin/env are still sh and env (finding 19)
    const base = t.slice(t.lastIndexOf("/") + 1);
    if (SHELL_RUNNERS.has(base)) {
      // bash -c '<string>' runs a full nested shell command — recurse the
      // whole check on the -c argument (#74 review finding 14). Without -c
      // it's a script-file invocation whose arguments are data.
      for (let j = i + 1; j < T.length; j++) {
        const a = T[j];
        if (a === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
          const nested = T[j + 1];
          return { kind: "verdict", reason: nested ? checkGitCommand(nested, hookCwd) : null };
        }
        if (!a.startsWith("-")) break;
      }
      return { kind: "verdict", reason: null };
    }
    if (t === "eval") {
      // eval concatenates and re-parses its arguments as a shell command
      return { kind: "verdict", reason: checkGitCommand(T.slice(i + 1).join(" "), hookCwd) };
    }
    const opts = GIT_WRAPPERS.get(base);
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
      return { kind: "verdict", reason: null };
    }
  }
  if (i >= T.length) return { kind: "verdict", reason: null };
  return { kind: "start", i };
}

// Sub-commands that create or move commits on the current branch (#301).
const COMMIT_LIKE = new Set(["commit", "merge", "rebase", "cherry-pick", "am", "pull"]);

/**
 * Record a branch switch for the rest of the line (#301 line-state).
 * Only an unambiguous NEW branch (-b/-B/-c/-C/--orphan <name>) lifts the gate;
 * a plain positional lowers it when it names main/master and is otherwise
 * ignored (it may be a pathspec — guessing would fail open). A `--` means
 * pathspecs follow: file restore, no switch at all.
 */
function applyLift(cmd: string, rest: string[], cPath: string, gitDir: string, st: LineState): void {
  if (rest.includes("--")) return;
  const createOpts = cmd === "checkout"
    ? new Set(["-b", "-B", "--orphan"])
    : new Set(["-c", "-C", "--create", "--force-create", "--orphan"]);
  let target = "";
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (createOpts.has(t)) { target = rest[i + 1] ?? ""; break; }
    if (t.startsWith("-")) continue;
    if (isMainRef(t)) { target = t; break; } // moving TO main lowers the gate
    return; // positional that is not main: could be a path — no line-state change
  }
  if (!target) return;
  st.liftKey = repoKey(cPath, st.cwd, gitDir);
  st.liftBranch = target;
}

/**
 * Inspect a git invocation. `start` indexes the `git` word itself — the benign
 * prefix before it has already been consumed by skipBenignPrefix.
 */
function checkGitSubcommand(T: string[], start: number, st: LineState): string | null {
  let i = start + 1;

  // git global options before the subcommand; capture -C <path> and
  // --git-dir <path> (both select the affected repo — finding 17).
  // --work-tree is skipped, not captured: it moves the worktree, but HEAD
  // (the branch) still comes from the git dir.
  let cPath = "";
  let gitDir = "";
  while (i < T.length) {
    const t = T[i];
    if (t === "-C") {
      // git chains -C options: each relative path resolves from the directory
      // established by the previous one (#74 review finding 9)
      const next = T[i + 1] ?? "";
      cPath = cPath && !next.startsWith("/") ? `${cPath}/${next}` : next;
      i += 2;
    } else if (t === "--git-dir") {
      gitDir = T[i + 1] ?? "";
      i += 2;
    } else if (t.startsWith("--git-dir=")) {
      gitDir = t.slice("--git-dir=".length);
      i += 1;
    } else if (t === "--work-tree" || t === "-c") {
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
    return checkPush(rest, cPath, st, gitDir);
  }
  if (cmd === "reset" && rest.includes("--hard")) {
    if (isMainRef(effectiveBranch(cPath, st, gitDir))) {
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
    if (cmd === "checkout") applyLift(cmd, rest, cPath, gitDir, st);
    return null;
  }
  if (cmd === "switch") {
    applyLift(cmd, rest, cPath, gitDir, st);
    return null;
  }
  // Commits on main are blocked, not just pushes (#301, btw#21): main advances
  // only through PRs, so every enforced check concentrates on PR review.
  // `git-checkpoint` already refuses on main (#225); this closes the raw-git
  // path. --abort/--quit undo (allowed); --ff-only creates no commit (allowed,
  // Duppy 2026-08-16); a plain `pull` is fetch+merge and can commit on a
  // diverged main, so it needs --ff-only. `checkout -b`/`switch -c` are not in
  // this set — the escape from main can never deadlock.
  if (COMMIT_LIKE.has(cmd)) {
    if (rest.includes("--abort") || rest.includes("--quit")) return null;
    if ((cmd === "merge" || cmd === "pull") && rest.includes("--ff-only")) return null;
    if (isMainRef(effectiveBranch(cPath, st, gitDir))) {
      const hint = cmd === "pull" || cmd === "merge"
        ? "use --ff-only to sync main, or"
        : "main advances only through PRs (#301) —";
      return `${cmd}s on main/master; ${hint} run 'wt-new <issue#>-<slug>' (or 'git checkout -b') first.`;
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
  // `worktree remove --force` discards uncommitted/untracked work in the
  // worktree unconditionally — same class as `clean -f` above (#225 gap 2).
  // Scoped to the `remove` subcommand only: `worktree add --force` overrides
  // git's "already checked out elsewhere" refusal, not a data-loss guard, so
  // it stays unblocked. Plain `worktree remove` (no force) also stays
  // allowed — git itself refuses on a dirty tree; that refusal is the
  // existing safeguard (#210's reasoning in pr-cleanup).
  if (cmd === "worktree" && rest.includes("remove")) {
    for (const t of rest) {
      if (t === "--force" || (t.startsWith("-") && !t.startsWith("--") && t.includes("f"))) {
        return "discards uncommitted work (forced git worktree remove, always blocked).";
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
  const st: LineState = { cwd: hookCwd, origCwd: hookCwd, liftKey: "", liftBranch: "" };
  const stripped = stripHeredocs(command);

  // Substitution bodies execute — inspect them before the main token walk
  const substReason = checkSubstitutions(stripped, hookCwd);
  if (substReason) return substReason;

  // Split on shell separators; heredoc bodies already stripped.
  // One blocked sub-command blocks the whole command line (fail-safe).
  const subs = splitOutsideQuotes(stripped);
  for (const sub of subs) {
    const toks = tokenize(sub);
    if (toks.length === 0) continue;
    if (applyCd(toks, st)) continue; // line-state only, nothing to block (#301)
    // Strip the benign prefix ONCE, then dispatch on what is actually being run.
    // Doing it once matters: the walk recurses into `bash -c` / `eval` bodies,
    // and running it per-checker would re-walk every nested string twice.
    const scan = skipBenignPrefix(toks, st.cwd);
    if (scan.kind === "verdict") {
      if (scan.reason) return scan.reason;
      continue;
    }
    const reason = isGitWord(toks[scan.i])
      ? checkGitSubcommand(toks, scan.i, st)
      : checkGhSubcommand(toks, scan.i);
    if (reason) return reason;
  }
  return null;
}

/**
 * Check for dangerous gh (GitHub CLI) commands. `start` indexes the `gh` word.
 * Separate from git guardrails because gh is not git — but gh pr merge
 * is the merge-to-main gate and must stay human-only.
 */
function checkGhSubcommand(T: string[], start: number): string | null {
  if (T[start + 1] === "pr" && T[start + 2] === "merge") {
    return "gh pr merge is human-only — merge PRs manually via GitHub or a separate shell.";
  }
  return null;
}

