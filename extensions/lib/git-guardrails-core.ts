/**
 * Git Guardrails core decision logic (#70, #74, #301) — harness-independent.
 *
 * Pure functions, no Pi imports, so tests/git-guardrails-parity.test.ts can
 * exercise this directly. The Pi extension (extensions/git-guardrails.ts)
 * wraps checkGitCommand() in a bash-spawn-hook; the Claude Code twin is
 * hooks/block-dangerous-git.sh (install target ~/.claude/hooks/).
 * Keep the .sh in sync — the parity test runs one fixture against both.
 */

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// --- Helpers ---

function currentBranch(cwd: string): string {
  try {
    return execSync("git branch --show-current", { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// Sentinel for "the effective cwd is UNKNOWN" (PR #305 round 4): a cd whose
// operand cannot be resolved here (`cd "$VAR"` set in an earlier tool call,
// `cd ~user`) may have moved the real shell into a main checkout, so the model
// does not stay put — it becomes unknown, and unknown is treated as protected by
// every branch-scoped check until a resolvable cd (or `cd -`/popd) restores it.
// A double-slash path is never a real directory, so it rides through the
// scope/snapshot plumbing as an ordinary cwd value.
const UNKNOWN_CWD = "//unknown";

function isMainRef(ref: string): boolean {
  return (
    ref === UNKNOWN_CWD || // unknown effective cwd is protected (fail-closed)
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
//          `pushd` reset it to the tool-call cwd; an unresolvable operand makes it
//          UNKNOWN, which every branch-scoped check treats as protected.
//   lift — `checkout -b|-B|--orphan` / `switch -c|-C|--create|--force-create|--orphan <name>` mark
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
  /** repo key → branch it was switched to earlier in the line — one entry per
   *  repo, so a two-repo line does not clobber itself (PR #305 review). */
  lifts: Map<string, string>;
  /** `(` pushes the effective cwd + vars, `)` pops them — nothing set inside a
   *  subshell group reaches the parent shell (PR #305 review, twice). Lifts are
   *  not scoped: a branch switch inside a group happened on disk. */
  scopeStack: { cwd: string; vars: Map<string, string> }[];
  /** Literal `NAME=value` assignments seen earlier in the line, so `cd "$WT"`
   *  and `checkout -b "$BRANCH"` can be resolved. Unresolvable = unknown, and
   *  unknown never moves the cwd or lifts the gate (fail-closed). */
  vars: Map<string, string>;
}

function newLineState(cwd: string): LineState {
  return { cwd, origCwd: cwd, lifts: new Map(), scopeStack: [], vars: new Map() };
}

type Snapshot = { cwd: string; vars: Map<string, string>; lifts: Map<string, string> };
function snapshot(st: LineState): Snapshot {
  return { cwd: st.cwd, vars: new Map(st.vars), lifts: new Map(st.lifts) };
}
function restore(st: LineState, sn: Snapshot): void {
  st.cwd = sn.cwd; st.vars = sn.vars; st.lifts = sn.lifts;
}

/**
 * Resolve $NAME / ${NAME} in a word from the line's assignments, then this
 * process's environment (HOME, PWD and other exported names are shared with
 * the tool's shell). Returns null when anything is left unresolved — command
 * substitution, an unknown variable — so the caller fails closed instead of
 * trusting a literal '$WT'.
 */
function expandWord(w: string, st: LineState): string | null {
  if (w.includes("`") || w.includes("$(")) return null;
  const out = w.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => {
    const v = st.vars.get(name) ?? process.env[name];
    return v === undefined ? "\u0000" : v;
  });
  if (out.includes("\u0000") || out.includes("$")) return null;
  return out;
}

/** `NAME=value` (or `export NAME=value`) STANDING ALONE as a sub-command. */
function recordAssignment(T: string[], st: LineState): boolean {
  let w = T[0];
  if (w === "export") { if (T.length !== 2) return false; w = T[1]; }
  else if (T.length !== 1) return false; // `VAR=x git commit` is a command with a prefix
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w);
  if (!m) return false;
  if (!m[2].includes("$") && !m[2].includes("`")) st.vars.set(m[1], m[2]);
  return true;
}

/** Does <ref> exist in the repo the sub-command acts on? Same -C/--git-dir resolution as branchOf. */
function refExists(cPath: string, st: LineState, gitDir: string, ref: string): boolean {
  const dir = cPath ? resolve(st.cwd || ".", cPath) : st.cwd;
  try {
    execSync(`git show-ref --verify --quiet ${JSON.stringify(ref)}`, {
      cwd: dir || ".",
      stdio: "ignore",
      env: gitDir ? { ...process.env, GIT_DIR: resolve(dir || ".", gitDir) } : process.env,
    });
    return true;
  } catch {
    return false;
  }
}

/** Configured remotes of the repo the sub-command acts on. Same -C/--git-dir
 *  resolution as refExists. */
function gitRemotes(cPath: string, st: LineState, gitDir: string): string[] {
  const dir = cPath ? resolve(st.cwd || ".", cPath) : st.cwd;
  try {
    return execSync("git remote", {
      cwd: dir || ".",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitDir ? { ...process.env, GIT_DIR: resolve(dir || ".", gitDir) } : process.env,
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * #389: a target that names a REMOTE ref does not create a branch by that name.
 * `git switch -t origin/main`, `--track origin/main`, `--track=direct
 * origin/main`, `--no-track origin/main` and `git checkout --track origin/main`
 * all answer "Switched to a new branch 'main'" (measured, git 2.43.0): the
 * branch git creates and lands you on is the LOCAL `main`. `refs/heads/origin/main`
 * never exists, so the pre-#389 test found no branch, recorded no lift, and the
 * #301 on-main gate judged the following `git commit` against the feature
 * branch — bypassed by the most idiomatic form there is.
 *
 * Returns the local branch name when <ref> is `<remote>/main` (or `/master`)
 * AND <remote> is a CONFIGURED remote of the affected repo, else null. Both
 * halves carry weight:
 *   - only a first segment that is a real remote is stripped, so a local branch
 *     literally named `feature/main` keeps its name — `feature` is no remote;
 *   - answering only for main/master keeps this TIGHTENING-ONLY: a
 *     `<remote>/<feature>` target can never turn a standing block into an
 *     allow, and main/master is the only question the gate asks.
 * The caller gates this on `hasTrackFlag`, so the neighbouring forms that do
 * NOT create a local branch are left alone: `git checkout origin/main` gives a
 * detached HEAD (a commit there does not advance main) and `git switch
 * origin/main` is fatal (no switch at all). Lifting those was a false block of
 * the #400 class, and a guardrail that cries wolf is one people route around.
 * The split is exact, not a guess: a tracking flag is present in every measured
 * form that creates a local branch and absent from every one that does not.
 */
/** Does this sub-command carry a tracking flag? That is what turns a
 *  `<remote>/<branch>` target into a NEW LOCAL branch instead of a detached
 *  HEAD (checkout) or a fatal error (switch) — verified against git 2.43.0.
 *  `--no-track` counts: the DWIM keys on the remote-named target, not on
 *  whether tracking is configured, so this set is flag-VALUE agnostic. */
function hasTrackFlag(rest: string[]): boolean {
  return rest.some(
    (t) => t === "-t" || t === "--track" || t === "--no-track" || t.startsWith("--track="),
  );
}

function dwimMainBranch(ref: string, cPath: string, st: LineState, gitDir: string): string | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const remote = ref.slice(0, slash);
  const branch = ref.slice(slash + 1);
  // Cheap test first — no subprocess for the overwhelmingly common target.
  if (!isMainRef(branch)) return null;
  return gitRemotes(cPath, st, gitDir).includes(remote) ? branch : null;
}

function repoKey(cPath: string, cwd: string, gitDir: string): string {
  const dir = cPath ? resolve(cwd || ".", cPath) : cwd;
  return `${dir}|${gitDir ? resolve(dir || ".", gitDir) : ""}`;
}

/** Branch the sub-command acts on, honouring an earlier switch in the same line. */
function effectiveBranch(cPath: string, st: LineState, gitDir = ""): string {
  // unknown cwd + a relative (or absent) -C target → the branch is unknowable
  if (st.cwd === UNKNOWN_CWD && (!cPath || !cPath.startsWith("/"))) return UNKNOWN_CWD;
  const lifted = st.lifts.get(repoKey(cPath, st.cwd, gitDir));
  if (lifted !== undefined) return lifted;
  return branchOf(cPath, st.cwd, gitDir);
}

/** `cd`/`pushd`/`popd` as the FIRST word of a sub-command moves the effective cwd. */
function applyCd(T: string[], st: LineState): boolean {
  const w = T[0]?.slice(T[0].lastIndexOf("/") + 1);
  if (w !== "cd" && w !== "pushd" && w !== "popd") return false;
  const home = process.env.HOME || "";
  if (w === "pushd" && T.includes("-n")) return true; // rotates the stack, no directory change (PR #305 round 3)
  const positionals = T.slice(1).filter((t) => !t.startsWith("-") || t === "-");
  if (positionals.length > 1) return true; // bash rejects `cd a b` — the real shell stays put (PR #305 round 4)
  const rawArg = positionals[0];
  if (w === "popd" || rawArg === "-" || (w === "pushd" && rawArg === undefined)) {
    st.cwd = st.origCwd; // previous directory is unknowable here — never guess
    return true;
  }
  let target: string;
  if (rawArg === undefined || rawArg === "~") {
    target = home;
  } else {
    const arg = expandWord(rawArg, st);
    if (arg === null) { st.cwd = UNKNOWN_CWD; return true; } // unresolvable → the cwd is UNKNOWN (protected)
    if (arg.startsWith("~/")) target = resolve(home, arg.slice(2));
    else if (arg.startsWith("~")) { st.cwd = UNKNOWN_CWD; return true; } // `~user` — not resolved here → unknown
    else if (arg.startsWith("/")) target = arg;
    else if (st.cwd === UNKNOWN_CWD) return true; // relative from unknown stays unknown
    else target = resolve(st.cwd || ".", arg);
  }
  // The cwd only moves to a directory that EXISTS: a failing `cd /nope; git
  // commit` leaves the real shell where it was, so the model must too.
  if (existsSync(target) && statSync(target).isDirectory()) st.cwd = target;
  return true;
}

// ---
// Drop heredoc bodies so quoted text like `<<EOF\ngit push origin main\nEOF`
// is never mistaken for a command (#74 false-positive class 3).
// ---
// Heredoc delimiters are general shell WORDs, not identifiers — numeric and
// dashed/dotted names are valid (#74 review finding 13b).
const HEREDOC_DELIM_CHARS = /[A-Za-z0-9_.+-]/;

// ---
// #400: `$( … )` starts a FRESH quoting context — the shell re-lexes inside it,
// so `--body "$(cat <<'EOF' … EOF)"` really does open a heredoc even though an
// enclosing `"` is still open. The scan used to stay in double-quote state
// across the `$(`, never saw the opener, and left the whole body for the outer
// walk; one unpaired `"` in the prose then ended the `--body` string and the
// remaining lines were split into sub-commands. That is how a bug report ABOUT
// a git command gets blocked for quoting it.
//
// A QUOTED delimiter (`<<'EOF'` / `<<"EOF"`) is inert by definition — no
// expansion, no substitution — so its body is dropped at any depth. An
// UNQUOTED `<<EOF` body still expands (`$(git push …)` inside it executes), so
// its handling is deliberately UNCHANGED: it is stripped only where no
// enclosing quote was open, which is exactly the set of positions the old
// top-level-only scan reached. `outerQuoted` counts those enclosing quotes.
// ---
// Exported for tests/git-guardrails-parity.test.ts (#400 finding 1): the
// end-to-end checkGitCommand() verdict stays correct today by coincidence —
// checkSubstitutions() independently re-derives $( ) boundaries with a
// correct paren counter and re-strips inside the recursion. A test must
// assert on stripHeredocs's OWN output, or it proves nothing.
export function stripHeredocs(command: string): string {
  const out: string[] = [];
  let delim: string | null = null;
  let dashed = false; // <<- : terminator may be tab-indented (#74 review finding 7)
  let q: "'" | '"' | null = null; // shell quotes span newlines — state persists across lines
  let arith = 0; // inside $(( )) a << is a bit-shift, never a heredoc opener
  // Quote state saved at each `$(`, or the sentinel "GROUP" for a bare `(...)`
  // subshell group (#400 finding 1 review): a bare `(` doesn't open a fresh
  // quoting context the way `$(` does, but its `)` still has to be popped by
  // its OWN closer, not mistaken for the closer of an enclosing `$(`. Without
  // counting it, `$(true; (true); cat <<'EOF' ...)` popped the `$(`'s saved
  // quote state on the FIRST `)` — the one closing `(true)` — leaving the real
  // closer to be treated as ordinary text and the heredoc never entered.
  const substStack: ("'" | '"' | null | "GROUP")[] = [];
  let outerQuoted = 0; // how many of those saved states had a quote open
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
      // `$(` — enter the substitution's own quoting context (not `$((`, which
      // is arithmetic and handled below). A single-quoted region is literal,
      // so no substitution starts there.
      //
      // `arith === 0` is REQUIRED, and its absence was a bug: the matching pop
      // below is arith-guarded, so a `$(` opened inside an active `$(( … ))`
      // pushed a frame whose own `)` — still inside the arithmetic — the pop
      // skipped. The orphan frame was then consumed by a later, unrelated `)`,
      // restoring the wrong quote state for the rest of the line. Push and pop
      // must agree on their guards; the bare-`(` push below already did.
      if (q !== "'" && arith === 0 && ch === "$" && line[i + 1] === "(" && line[i + 2] !== "(") {
        substStack.push(q);
        if (q !== null) outerQuoted++;
        q = null;
        i++;
        continue;
      }
      if (q === null && arith === 0 && ch === ")" && substStack.length > 0) {
        const frame = substStack.pop() ?? null;
        if (frame !== "GROUP") {
          if (frame !== null) outerQuoted--;
          q = frame;
        }
        continue;
      }
      // Bare `(` — a subshell/grouping paren, not a `$(` (that case already
      // `continue`d above). It doesn't touch `q`, but it MUST be counted so
      // its own `)` doesn't get mistaken for the closer of an enclosing `$(`.
      if (q === null && arith === 0 && ch === "(") {
        substStack.push("GROUP");
        continue;
      }
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
        // #389: the delimiter is a shell WORD, and a word is the
        // CONCATENATION of its adjacent quoted and unquoted pieces — `<<'END'x`
        // is delimited by `ENDx`, `<<x'END'` by `xEND`, `<<E'ND'` by `END`
        // (verified against bash: a line `ENDx` terminates the first, a bare
        // `END` does not). Recording only the first piece left a delimiter that
        // never arrives: the scan stayed in body mode to end-of-input and ate
        // every real command AFTER the heredoc — a fail-open on every gate
        // downstream. Keep collecting pieces until an unquoted word boundary.
        // Shell rule: if ANY piece is quoted, the WHOLE delimiter is quoted, so
        // the body is inert text and is dropped at any depth.
        let quotedDelim = false;
        let word = "";
        while (j < line.length) {
          const c = line[j];
          if (c === "'") {
            quotedDelim = true;
            j++;
            while (j < line.length && line[j] !== "'") word += line[j++];
            if (j < line.length) j++; // closing quote
          } else if (c === '"') {
            quotedDelim = true;
            j++;
            while (j < line.length && line[j] !== '"') {
              if (line[j] === "\\" && j + 1 < line.length) j++;
              word += line[j++];
            }
            if (j < line.length) j++; // closing quote
          } else if (c === "\\" && j + 1 < line.length) {
            // `<<\EOF` — a backslash quotes the next character, and quoting any
            // piece quotes the whole delimiter.
            quotedDelim = true;
            j++;
            word += line[j++];
          } else if (HEREDOC_DELIM_CHARS.test(c)) {
            word += line[j++];
          } else {
            break; // unquoted word boundary ends the delimiter
          }
        }
        // Quoted delimiter → inert body, drop it wherever it is. Unquoted →
        // only where nothing quoted encloses it, i.e. exactly the pre-#400 set.
        if (word && (quotedDelim || outerQuoted === 0)) {
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
    } else if (ch === "\n" || ch === ";") {
      // Separators become standalone MARKER entries so the walk can model
      // control flow (PR #305 review round 2): ';' ends a chain, '&&'/'||'
      // make what follows conditional, '|' and a single '&' put the adjacent
      // sub-command in a subshell, '(' / ')' open/close a scope. `$(…)`
      // bodies were already inspected by checkSubstitutions.
      subs.push(cur, ";");
      cur = "";
    } else if (ch === "(" || ch === ")") {
      subs.push(cur, ch);
      cur = "";
    } else if (ch === "&" || ch === "|") {
      if (s[i + 1] === ch) { i++; subs.push(cur, "&&"); } // && or || — conditional
      else subs.push(cur, ch);
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
function checkSubstitutions(s: string, st: LineState): string | null {
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
      const reason = checkChild(s.slice(i + 2, j), st);
      if (reason) return reason;
      i = j;
    } else if (ch === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== "`") {
        if (s[j] === "\\") j++;
        j++;
      }
      const reason = checkChild(s.slice(i + 1, j), st);
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
function skipBenignPrefix(T: string[], st: LineState): PrefixScan {
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
          return { kind: "verdict", reason: nested ? checkChild(nested, st) : null };
        }
        if (!a.startsWith("-")) break;
      }
      return { kind: "verdict", reason: null };
    }
    if (t === "eval") {
      // eval concatenates and re-parses its arguments as a shell command
      // eval runs in the SAME shell: its cd and lifts persist — share the state
      return { kind: "verdict", reason: checkWithState(T.slice(i + 1).join(" "), st) };
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
// `revert` joined the set in #391: it writes a commit on the current branch,
// which is the exact act the set exists to prevent, and its absence made
// `git revert HEAD` on main advance main without a PR.
const COMMIT_LIKE = new Set(["commit", "merge", "rebase", "cherry-pick", "am", "pull", "revert"]);
const UNDOABLE = new Set(["merge", "rebase", "cherry-pick", "am", "revert"]);
// Options whose SEPARATE next word is an argument. Over-skipping is safe (a
// missed --abort/--ff-only only blocks); under-skipping is the fail-open case.
const ARG_OPTIONS = new Set([
  "-m", "-F", "-C", "-c", "-s", "-X", "-S", "-x", "--message", "--file", "--strategy",
  "--strategy-option", "--onto", "--exec", "--author", "--date", "--template", "--fixup",
  "--squash", "--reuse-message", "--reedit-message", "--gpg-sign", "--cleanup",
  "--into-name", "--patch-format", "--whitespace", "--directory", "--exclude", "--include",
  "--mainline",
]);

/**
 * Options that make a `checkout`/`switch` a RESTORE or otherwise NO-SWITCH
 * form. Every one of these leaves HEAD where it was, so the lone positional
 * beside it is a tree-ish or a pathspec, never a branch to lift.
 *
 * #399 fallout: `--` was the only terminator, and `--pathspec-from-file` starts
 * with `-`, so it was skipped by the positional count — `git checkout feature
 * --pathspec-from-file=paths` left `feature` as the lone positional, lifted,
 * and the `git commit` after it ran unguarded on main. Measured against git
 * 2.43.0, each entry below with `feature` as its positional and HEAD on main:
 *   `--pathspec-from-file=<f>` / `--pathspec-from-file <f>` → "Updated 1 path
 *     from …", HEAD=main; `--pathspec-file-nul` → "requires
 *     --pathspec-from-file"
 *   `-p` / `--patch` → "No changes.", HEAD=main (restores hunks, never switches)
 *   `--ours` / `--theirs` → "fatal: '--ours/--theirs' cannot be used with
 *     switching branches"; `--overlay` / `--no-overlay` → the same fatal for
 *     '--[no]-overlay'
 * The list is measured, not guessed, and stays that way: `--conflict=<style>`
 * looks equally path-ish and DOES switch ("Switched to branch 'feature'"), so
 * it is deliberately absent. Terminating on every unknown option would make
 * that a false block — the #400 class of defect.
 */
const RESTORE_FORM_OPTS = new Set([
  "--", "-p", "--patch", "--pathspec-from-file", "--pathspec-file-nul",
  "--ours", "--theirs", "--overlay", "--no-overlay",
]);

function isRestoreForm(rest: string[]): boolean {
  return rest.some((t) => RESTORE_FORM_OPTS.has(t) || t.startsWith("--pathspec-from-file="));
}

/**
 * Record a branch switch for the rest of the line (#301 line-state).
 *
 * Two ways a sub-command moves the line onto another branch:
 *   create — `-b`/`-B`, `-c`/`-C`/`--create`/`--force-create`, `--orphan <name>`.
 *   switch — a LONE positional that names an existing branch (or main/master).
 *
 * #399: the switch case used to be recorded only when the ref did NOT exist,
 * which meant `git checkout main` — the only way to reach main, and the most
 * ordinary command an agent could type — never registered, and the #301
 * commit-like gate never fired. "Does the ref exist" answers whether git would
 * SUCCEED, and that question belongs to the create case alone (`checkout -b
 * <existing>` fails and leaves the repo where it was, PR #305 review). For a
 * plain switch, an existing ref is precisely the evidence that it IS a branch
 * switch rather than a pathspec.
 *
 * Still fail-closed where the answer is a guess: a RESTORE-FORM option means no
 * switch (see RESTORE_FORM_OPTS), more than one positional is the
 * `git checkout <tree-ish> <path>…` restore form (which does not switch either),
 * a name that is neither main/master nor an existing branch is a pathspec or a
 * detached checkout, and an unresolved `$BRANCH` is nothing at all. main/master
 * lifts whether or not the ref exists — if the switch fails, the line stays
 * where it was, and treating the rest of it as protected is the safe direction.
 */
function applyLift(cmd: string, rest: string[], cPath: string, gitDir: string, st: LineState): void {
  if (isRestoreForm(rest)) return; // no switch happens: nothing to lift
  const createOpts = cmd === "checkout"
    ? new Set(["-b", "-B", "--orphan"])
    : new Set(["-c", "-C", "--create", "--force-create", "--orphan"]);
  const positionals = rest.filter((t) => !t.startsWith("-"));
  let target = "";
  let created = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (createOpts.has(t)) { target = rest[i + 1] ?? ""; created = true; break; }
    if (t.startsWith("-")) continue;
    if (positionals.length !== 1) return; // <tree-ish> <path>… restore: no switch
    target = t;
    break;
  }
  if (!target) return;
  let resolved = expandWord(target, st);
  if (resolved === null) return; // '$BRANCH' unresolved → no lift (fail-closed)
  if (created) {
    // -B / -C / --force-create reset-or-create and always land; the plain
    // create forms fail on an existing name and leave the repo where it was.
    // (The create forms name the local branch outright, so no `<remote>/…`
    // DWIM applies here — `switch -c foo origin/main` creates `foo`.)
    const force = rest.some((t) => t === "-B" || t === "-C" || t === "--force-create");
    if (!force && refExists(cPath, st, gitDir, `refs/heads/${resolved}`)) return;
  } else {
    // #389: `<remote>/main` lands on a NEW LOCAL `main` — lift the LOCAL name.
    // Only when a tracking flag is present. Measured against git 2.43.0: the
    // DWIM that creates a local branch from a remote-named target requires one
    // of -t / --track / --track=<mode> / --no-track. WITHOUT one,
    // `git checkout origin/main` DETACHES — a commit there does not advance
    // main — and `git switch origin/main` is fatal. Neither lands on a branch,
    // so lifting them was a false block, the #400 class of defect.
    const dwim = hasTrackFlag(rest) ? dwimMainBranch(resolved, cPath, st, gitDir) : null;
    if (dwim !== null) {
      resolved = dwim;
    } else if (!isMainRef(resolved) && !refExists(cPath, st, gitDir, `refs/heads/${resolved}`)) {
      return; // not a branch: pathspec or detached checkout — no line-state change
    }
  }
  st.lifts.set(repoKey(cPath, st.cwd, gitDir), resolved);
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
  // path. `revert` is here too (#391) — it commits like the rest.
  // --abort/--quit undo (allowed); --ff-only creates no commit (allowed,
  // Duppy 2026-08-16); a plain `pull` is fetch+merge and can commit on a
  // diverged main, so it needs --ff-only. `checkout -b`/`switch -c` are not in
  // this set — the escape from main can never deadlock.
  if (COMMIT_LIKE.has(cmd)) {
    // Option ARGUMENTS are not options: `git commit -m --abort` is a commit
    // whose message is '--abort' (PR #305 review). Skip the word after any
    // argument-taking option, stop at `--`, and honour --abort/--quit only
    // for the sub-commands that have them.
    let ffOnly = false;
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (t === "--") break;
      if (ARG_OPTIONS.has(t)) { k++; continue; }
      if ((t === "--abort" || t === "--quit") && UNDOABLE.has(cmd)) return null;
      if (t === "--ff-only") ffOnly = true;
    }
    if (ffOnly && (cmd === "merge" || cmd === "pull")) return null;
    const eb = effectiveBranch(cPath, st, gitDir);
    if (eb === UNKNOWN_CWD) {
      return `${cmd}s with an UNKNOWN effective cwd — an earlier cd in this line could not be resolved ($VAR from another call, ~user); use a literal path or run the cd on its own line.`;
    }
    if (isMainRef(eb)) {
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
  return checkWithState(command, newLineState(hookCwd));
}

/**
 * A child shell (`bash -c`, `$(…)`, backticks) sees the current state, but
 * NOTHING it sets comes back — not cwd, not vars, and not lifts either:
 * substitutions are inspected before the walk, so a lift from one would apply
 * to sub-commands that ran EARLIER (PR #305 review round 2). Cost: `bash -c
 * 'git checkout -b x' && git commit` false-blocks; the child's own
 * sub-commands still see the lift.
 */
function checkChild(command: string, st: LineState): string | null {
  const child: LineState = { ...st, scopeStack: [], vars: new Map(st.vars), lifts: new Map(st.lifts) };
  return checkWithState(command, child);
}

function checkWithState(command: string, st: LineState): string | null {
  const stripped = stripHeredocs(command);

  // Substitution bodies execute — inspect them before the main token walk
  const substReason = checkSubstitutions(stripped, st);
  if (substReason) return substReason;

  // Split on shell separators; heredoc bodies already stripped.
  // One blocked sub-command blocks the whole command line (fail-safe).
  // Walk the split with control flow modelled fail-closed (PR #305 review round 2):
  //   ';'        ends a &&/|| chain — state changes made under a condition are
  //              REVERTED (`false && git checkout -b x; git commit` is judged on
  //              main). The FIRST sub-command of a chain is unconditional, so
  //              `cd wt && git commit; git push` keeps its cd.
  //   '&&' '||'  everything after the first one in a chain is conditional.
  //   '|' '&'    the adjacent sub-command runs in a subshell: its cd/vars/lifts
  //              are dropped (`cd x | cat; git commit`).
  //   '(' ')'    scope: cwd and vars restored at ')'.
  const subs = splitOutsideQuotes(stripped);
  let chainSnap: Snapshot | null = null;
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    if (sub === "(") { st.scopeStack.push({ cwd: st.cwd, vars: new Map(st.vars) }); continue; }
    if (sub === ")") {
      const sc = st.scopeStack.pop();
      if (sc) { st.cwd = sc.cwd; st.vars = sc.vars; }
      continue;
    }
    if (sub === ";") { if (chainSnap) { restore(st, chainSnap); chainSnap = null; } continue; }
    if (sub === "&&") { if (!chainSnap) chainSnap = snapshot(st); continue; }
    if (sub === "|" || sub === "&") continue;
    const prev = i > 0 ? subs[i - 1] : "";
    const next = subs[i + 1] ?? "";
    const subshell = prev === "|" || next === "|" || next === "&";
    const before = subshell ? snapshot(st) : null;
    const reason = checkOneSub(sub, st);
    if (before) restore(st, before); // pipeline element / background job: nothing persists
    if (reason) return reason;
  }
  return null;
}

/** One sub-command: line-state changes (assignment, cd, lift) or a check. */
function checkOneSub(sub: string, st: LineState): string | null {
  const toks = tokenize(sub);
  if (toks.length === 0) return null;
  if (recordAssignment(toks, st)) return null; // NAME=value alone: remembered, nothing to block
  if (applyCd(toks, st)) return null; // line-state only, nothing to block (#301)
  // Strip the benign prefix ONCE, then dispatch on what is actually being run.
  // Doing it once matters: the walk recurses into `bash -c` / `eval` bodies,
  // and running it per-checker would re-walk every nested string twice.
  const scan = skipBenignPrefix(toks, st);
  if (scan.kind === "verdict") return scan.reason;
  return isGitWord(toks[scan.i])
    ? checkGitSubcommand(toks, scan.i, st)
    : checkGhSubcommand(toks, scan.i);
}

// gh's GLOBAL options that consume a SEPARATE value (#389). Everything else
// beginning with '-' is a boolean flag or a =-joined pair and consumes only
// itself, so it can be skipped without swallowing the sub-command.
const GH_GLOBAL_ARG_OPTIONS = new Set(["-R", "--repo", "--hostname"]);

/**
 * The first two POSITIONAL words after `gh` — its command and sub-command.
 * Positional, not adjacent: `gh -R owner/repo pr merge 5` puts `pr` three
 * tokens after `gh`, and cobra accepts flags interleaved anywhere, so
 * `gh pr --repo o/r merge` is the same command too.
 */
function ghSubcommandWords(T: string[], start: number): string[] {
  const words: string[] = [];
  for (let i = start + 1; i < T.length && words.length < 2; i++) {
    const t = T[i];
    if (GH_GLOBAL_ARG_OPTIONS.has(t)) { i++; continue; } // option + its value
    if (t.startsWith("-") && t !== "-") continue; // boolean flag / --key=value
    words.push(t);
  }
  return words;
}

/**
 * Check for dangerous gh (GitHub CLI) commands. `start` indexes the `gh` word.
 * Separate from git guardrails because gh is not git — but gh pr merge
 * is the merge-to-main gate and must stay human-only.
 *
 * #389: this used to test positional ADJACENCY (T[start+1] === "pr"), so any
 * global gh flag shifted the gate out of view — and `-R owner/repo` is the
 * ordinary way an agent addresses a repo it is not standing in. The gate is
 * the merge-to-main gate; it now finds the sub-command instead of a position,
 * the way skipBenignPrefix already finds the command word past its wrappers.
 */
function checkGhSubcommand(T: string[], start: number): string | null {
  const words = ghSubcommandWords(T, start);
  if (words[0] === "pr" && words[1] === "merge") {
    return "gh pr merge is human-only — merge PRs manually via GitHub or a separate shell.";
  }
  return null;
}

