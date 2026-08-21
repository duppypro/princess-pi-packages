/**
 * Parity test for the git guardrails (#74; #301 commit-on-main + line-state cases).
 *
 * Runs every case in tests/fixtures/git-guardrails-cases.json against BOTH
 * implementations and asserts they agree with the fixture verdict:
 *   - extensions/git-guardrails.ts  → checkGitCommand() called directly
 *   - hooks/block-dangerous-git.sh  → spawned with hook-shaped JSON on stdin
 *     (exit 0 = allow, exit 2 = block — the Claude Code PreToolUse contract)
 *
 * Branch state is real, not mocked: each case gets throwaway `git init -b`
 * repos matching its declared branches. "/repo" in a command is a placeholder
 * replaced with the -C target repo's actual path.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { checkGitCommand, stripHeredocs as tsStripHeredocs } from "../extensions/lib/git-guardrails-core";
import fixture from "./fixtures/git-guardrails-cases.json";

const REPO_ROOT = join(import.meta.dir, "..");
const SH_HOOK = join(REPO_ROOT, "hooks", "block-dangerous-git.sh");

interface Case {
  id: string;
  command: string;
  verdict: "allow" | "block";
  branch?: string;
  cwd_branch?: string;
  c_path_branch?: string;
  c_path_rel?: string;
  /** Branches that must EXIST in the cwd repo (needs a root commit) — for the
   *  `checkout -b <existing>` fail-closed cases (PR #305 review). */
  extra_branches?: string[];
  why: string;
  /** What the frozen pre-#74 ancestor returned. Absent = no historical claim. */
  pre74?: "allow" | "block";
  /** Which documented defect this case demonstrates. Present iff pre74 is. */
  pre74_class?: "greedy-push-regex" | "cwd-only-branch" | "substring-checkout-dot";
}

// --- test doubles: real throwaway repos, real branches ---

function repoOnBranch(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrail-case-"));
  execSync(`git init -q -b "${branch}"`, { cwd: dir });
  return dir;
}

function nonRepoDir(): string {
  return mkdtempSync(join(tmpdir(), "guardrail-nonrepo-"));
}

/** Materialize a case's declared branch state into (command, cwd). */
function materialize(c: Case): { command: string; cwd: string } {
  let command = c.command;
  const cwdBranch = c.cwd_branch !== undefined ? c.cwd_branch : c.branch;
  const cwd = cwdBranch ? repoOnBranch(cwdBranch) : nonRepoDir();
  if (c.extra_branches?.length) {
    execSync(`git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`, { cwd });
    for (const b of c.extra_branches) execSync(`git branch "${b}"`, { cwd });
  }
  if (c.c_path_branch !== undefined) {
    if (c.c_path_rel !== undefined) {
      // relative -C target: a repo INSIDE the tool-call cwd, referenced by
      // its relative name — the command already says `-C <c_path_rel>`
      execSync(`git init -q -b "${c.c_path_branch}" "${c.c_path_rel}"`, { cwd });
    } else {
      const cRepo = repoOnBranch(c.c_path_branch);
      command = command.replaceAll("/repo", cRepo);
    }
  }
  return { command, cwd };
}

function shVerdict(command: string, cwd: string): "allow" | "block" {
  const input = JSON.stringify({ tool_input: { command, cwd } });
  const res = spawnSync("bash", [SH_HOOK], { input, encoding: "utf8" });
  if (res.status === 0) return "allow";
  if (res.status === 2) return "block";
  throw new Error(
    `hook exited ${res.status} (expected 0 or 2): ${res.stderr || res.stdout}`
  );
}

function tsVerdict(command: string, cwd: string): "allow" | "block" {
  return checkGitCommand(command, cwd) === null ? "allow" : "block";
}

// --- the parity gate ---

describe("git-guardrails parity (#74)", () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    test(`${c.id} → ${c.verdict}`, () => {
      const { command, cwd } = materialize(c);
      // fixture is the spec: both implementations must match it
      expect(tsVerdict(command, cwd), `ts: ${c.why}`).toBe(c.verdict);
      expect(shVerdict(command, cwd), `sh: ${c.why}`).toBe(c.verdict);
    });
  }
});

// --- regression witness (#260) ---
//
// Everything above asserts the two CURRENT implementations agree with the spec.
// None of it shows the guardrail catches anything a naive implementation would
// miss — 124 cases of mutual agreement are equally consistent with the rewrite
// having been unnecessary.
//
// hooks/block-dangerous-git.sh's header makes two historical claims: the old
// greedy regex `push\s+.*\b(main|master)\b` spanned the whole command line and
// over-blocked, and it resolved the branch from the hook cwd alone so
// `git -C <path> push` with <path> on main slipped through. Those claims were
// prose. The ancestor itself survived as a stray .bak (#257 cleanup) and is now
// frozen at tests/fixtures/block-dangerous-git.pre-74.sh, so they can be run.
//
// The fixture is EXECUTED, never sourced or deployed: it is a historical input,
// and the only thing that may ever change about it is deletion.
const PRE74_HOOK = join(REPO_ROOT, "tests", "fixtures", "block-dangerous-git.pre-74.sh");

function pre74Verdict(command: string, cwd: string): "allow" | "block" {
  const input = JSON.stringify({ tool_input: { command, cwd } });
  const res = spawnSync("bash", [PRE74_HOOK], { input, encoding: "utf8" });
  if (res.status === 0) return "allow";
  if (res.status === 2) return "block";
  throw new Error(
    `pre-74 hook exited ${res.status} (expected 0 or 2): ${res.stderr || res.stdout}`
  );
}

describe("git-guardrails regression witness (#260)", () => {
  const witnesses = (fixture as { cases: Case[] }).cases.filter((c) => c.pre74 !== undefined);

  // The artifact carries no "FROZEN — do not edit" banner on purpose: adding one
  // would edit it, and its whole evidentiary value is being the unmodified file
  // recovered from ~/.claude/hooks in the #257 cleanup. So the freeze is pinned
  // here instead, where it can be enforced rather than requested.
  test("the pre-74 artifact is unmodified (2810 bytes, 2026-07-15)", () => {
    const sha = createHash("sha256").update(readFileSync(PRE74_HOOK)).digest("hex");
    expect(sha, "tests/fixtures/block-dangerous-git.pre-74.sh must not be edited — it is a historical artifact, and the only valid change to it is deletion").toBe(
      "6596501671fb71a1a9dc920e054d990f69af6e16b41fb8fe4bbc1d43522a5f74"
    );
  });

  for (const c of witnesses) {
    test(`${c.id} — pre-74 answered ${c.pre74}, spec says ${c.verdict} [${c.pre74_class}]`, () => {
      const { command, cwd } = materialize(c);
      // The ancestor's recorded behaviour is pinned. This fails if the frozen
      // fixture is edited — which is the point of freezing it.
      expect(pre74Verdict(command, cwd), `pre-74: ${c.why}`).toBe(c.pre74!);
      // ...and it was WRONG, which is what makes this a witness rather than
      // a second spec. Guards against annotating a case the old hook got right.
      expect(c.pre74).not.toBe(c.verdict);
      // Both current implementations get it right. Without this the test would
      // prove only that something changed, not that it improved.
      expect(tsVerdict(command, cwd), `ts: ${c.why}`).toBe(c.verdict);
      expect(shVerdict(command, cwd), `sh: ${c.why}`).toBe(c.verdict);
    });
  }

  // Each documented claim must keep at least one live witness. Without this,
  // deleting the last case of a class would silently retire the evidence for a
  // bug the hook's header still asserts.
  for (const cls of ["greedy-push-regex", "cwd-only-branch", "substring-checkout-dot"]) {
    test(`class '${cls}' still has a witness`, () => {
      expect(witnesses.filter((c) => c.pre74_class === cls).length).toBeGreaterThan(0);
    });
  }

  // The cwd-only-branch defect was wrong in BOTH directions: it under-blocked a
  // push to a -C target on main, and over-blocked one whose --git-dir target was
  // on a feature branch while the shell cwd sat on main. A witness set holding
  // only under-blocks would misrepresent it as a missing rule rather than a
  // wrong input to an existing one.
  test("cwd-only-branch is witnessed in both directions", () => {
    const cwdOnly = witnesses.filter((c) => c.pre74_class === "cwd-only-branch");
    expect(cwdOnly.some((c) => c.pre74 === "allow" && c.verdict === "block")).toBe(true);
    expect(cwdOnly.some((c) => c.pre74 === "block" && c.verdict === "allow")).toBe(true);
  });
});

// --- input-parse dependency (#390) ---
//
// The .sh hook reads the tool call with `jq`. An empty result has two causes it
// could not tell apart — there was no command (benign), and the parser never ran
// (every guardrail is now absent) — and it reported the first, so a missing or
// broken `jq` silently removed the entire gate. Unknown state is protected
// state, the same rule the file already applies to an unresolvable `cd`.
//
// The TS twin has no such step: Pi's bash-spawn-hook hands checkGitCommand() the
// command string directly, so there is no parser to fail. Parity here is parity
// of OUTCOME — neither implementation has an input path that can disarm it
// without saying so — and the TS half is asserted as the ABSENCE of an external
// parser rather than as a second stub.

/** A PATH whose only entries are the named real binaries — plus whatever `extra`
 *  writes into it. Anything not listed is genuinely missing for that run. */
function stubPath(extra: (dir: string) => void, keep = ["bash", "cat", "git", "realpath"]): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrail-stubpath-"));
  for (const bin of keep) {
    const real = execSync(`command -v ${bin}`, { encoding: "utf8" }).trim();
    symlinkSync(real, join(dir, bin));
  }
  extra(dir);
  return dir;
}

function runHook(command: string, cwd: string, env: Record<string, string>) {
  const input = JSON.stringify({ tool_input: { command, cwd } });
  return spawnSync("bash", [SH_HOOK], { input, encoding: "utf8", env: { ...process.env, ...env } });
}

describe("git-guardrails input-parse dependency (#390)", () => {
  const cwd = repoOnBranch("390-feat");
  const DANGEROUS = "git push origin main";

  test("a jq that exits non-zero blocks and names the dependency", () => {
    const dir = stubPath((d) => {
      writeFileSync(join(d, "jq"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    });
    const res = runHook(DANGEROUS, cwd, { PATH: dir });
    expect(res.status, "a broken parser must not read as 'nothing to check'").toBe(2);
    expect(res.stderr).toContain("jq");
  });

  test("a jq missing from PATH blocks and names the dependency", () => {
    const dir = stubPath(() => {});
    const res = runHook(DANGEROUS, cwd, { PATH: dir });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("jq");
  });

  test("a jq that is not executable blocks and names the dependency", () => {
    const dir = stubPath((d) => {
      writeFileSync(join(d, "jq"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    });
    const res = runHook(DANGEROUS, cwd, { PATH: dir });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("jq");
  });

  test("a genuinely empty command on a SUCCESSFUL parse still exits 0", () => {
    const res = spawnSync("bash", [SH_HOOK], {
      input: JSON.stringify({ tool_input: { cwd } }),
      encoding: "utf8",
    });
    expect(res.status, "no command is not the same as no parser").toBe(0);
  });

  test("a working jq still gates normally", () => {
    expect(shVerdict(DANGEROUS, cwd)).toBe("block");
    expect(shVerdict("git push origin 390-feat", cwd)).toBe("allow");
  });

  test("the TS twin has no external input parser to lose", () => {
    for (const f of ["extensions/lib/git-guardrails-core.ts", "extensions/git-guardrails.ts"]) {
      const src = readFileSync(join(REPO_ROOT, f), "utf8");
      expect(src, `${f} must not shell out to parse the tool call`).not.toContain("jq ");
    }
    // The command arrives as an argument, so there is no parse step between the
    // tool call and the decision: the same string that reaches the .sh via jq
    // reaches this directly.
    expect(checkGitCommand(DANGEROUS, cwd)).not.toBeNull();
    expect(checkGitCommand("", cwd)).toBeNull();
  });
});

// ---
// #400 finding 1 (pr-review on #389/#390/#391/#399/#400): substStack pops on the
// FIRST `)` after a `$(` with q===null, whether or not that `)` actually closes
// the `$(` — a bare `(...)` subshell group nested inside is never counted, so its
// `)` prematurely restores the quote state meant for the real closer. This is
// masked end-to-end today because checkSubstitutions() independently re-finds
// `$( )` boundaries with a correct paren counter and recurses — so a test must
// assert on stripHeredocs's OWN output, never only the checkGitCommand verdict.
// ---
function shStripHeredocs(command: string): string {
  const fnSrc = readFileSync(SH_HOOK, "utf8");
  const m = fnSrc.match(/\nstrip_heredocs\(\) \{[\s\S]*?\n\}\n/);
  if (!m) throw new Error("could not locate strip_heredocs() in hooks/block-dangerous-git.sh");
  const res = spawnSync("bash", ["-c", `${m[0]}\nstrip_heredocs "$1"`, "--", command], {
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`strip_heredocs failed: ${res.stderr}`);
  return res.stdout.replace(/\n$/, "");
}

describe("git-guardrails stripHeredocs — nested bare subshell group (#400 finding)", () => {
  // `(true)` is a bare subshell group nested inside the `$( )` — its `)` must
  // not be mistaken for the closer of the outer `$(`.
  const command = "echo \"$(true; (true); cat <<'EOF2'\ngit push origin main\nEOF2\n)\"";

  test("ts: the quoted heredoc body is dropped even with a nested bare ( ) group inside $( )", () => {
    const out = tsStripHeredocs(command);
    expect(out, "heredoc body must be stripped at any depth for a QUOTED delimiter").not.toContain(
      "git push origin main",
    );
  });

  test("sh: the quoted heredoc body is dropped even with a nested bare ( ) group inside $( )", () => {
    const out = shStripHeredocs(command);
    expect(out, "heredoc body must be stripped at any depth for a QUOTED delimiter").not.toContain(
      "git push origin main",
    );
  });
});

// ---
// #400 finding 2 (pr-review round 2 on this same branch): the `$(` PUSH was not
// arith-guarded while its `)` POP was. A `$(` opened inside an active `$(( … ))`
// therefore pushed a frame whose own `)` — still inside the arithmetic — the pop
// skipped. The orphan frame was later consumed by an unrelated `)`, leaving the
// wrong quote state for the REST OF THE SCAN, which is where the damage lands:
// the corrupted `q` makes the closing `"` read as a fresh OPENING quote, and
// every heredoc after it stops being recognised at all. Same class as finding 1
// (guards that disagree about what counts as a closer), left uncovered for the
// arithmetic case — which is exactly the "fixed at 1 of N sites" shape of #412.
// State persists across lines, so the assertion is on a LATER line's heredoc.
// ---
describe("git-guardrails stripHeredocs — $( ) nested inside $(( )) (#400 finding, round 2)", () => {
  // The orphan frame is created by `$(echo 1)` inside `$(( … ))`. It corrupts
  // `q` at the outer closer, so the `<<'EOF3'` on the following line — a QUOTED
  // delimiter, which the contract says is dropped at any depth — is missed.
  const command = "echo \"$(echo $(( $(echo 1) + 1 )))\"\ncat <<'EOF3'\ngit push origin main\nEOF3";

  test("ts: a quoted heredoc AFTER a $( ) nested in $(( )) is still stripped", () => {
    const out = tsStripHeredocs(command);
    expect(
      out,
      "an orphan substStack frame from arithmetic must not corrupt quote state for later lines",
    ).not.toContain("git push origin main");
  });

  test("sh: a quoted heredoc AFTER a $( ) nested in $(( )) is still stripped", () => {
    const out = shStripHeredocs(command);
    expect(
      out,
      "an orphan substStack frame from arithmetic must not corrupt quote state for later lines",
    ).not.toContain("git push origin main");
  });
});

// ---
// pr-review finding on #389/#390/#391/#399/#400: the #390 fix checked the exit
// status of the FIRST jq read (.tool_input.command) but not the SECOND
// (.tool_input.cwd) — a jq that fails on that second call silently leaves
// HOOK_CWD/ORIG_CWD as "" instead of the existing UNKNOWN_CWD sentinel. "" is
// not protected the way UNKNOWN_CWD is: branch_of() with an empty dir falls
// through to a bare `git branch --show-current`, which reads whatever
// directory the HOOK PROCESS itself happens to be running in — not the tool
// call's declared cwd. This is the same shape as #412 (one of N identical jq
// reads gets the fail-closed check, the rest do not).
// ---
describe("git-guardrails cwd-read fail-closed (#390 finding — second jq read)", () => {
  test("a jq failure on the .cwd read fails closed to UNKNOWN_CWD, not '' resolved against the hook process's own cwd", () => {
    // The hook PROCESS's cwd (spawnSync `cwd`) is on a feature branch. If the
    // broken .cwd read falls through to a bare `git branch --show-current`
    // instead of UNKNOWN_CWD, it reads THIS branch and wrongly allows a
    // commit that must be protected because the real cwd is unknown.
    const processCwdRepo = repoOnBranch("412-shape-feat");
    const realJq = execSync("command -v jq", { encoding: "utf8" }).trim();
    const dir = stubPath((d) => {
      // Real jq for the .command read; fail only the .cwd read (its filter is
      // the only one of the two containing ".cwd").
      writeFileSync(
        join(d, "jq"),
        `#!/bin/sh\ncase "$*" in\n  *.cwd*) exit 5 ;;\nesac\nexec "${realJq}" "$@"\n`,
        { mode: 0o755 },
      );
    });
    const res = spawnSync("bash", [SH_HOOK], {
      input: JSON.stringify({ tool_input: { command: "git commit -m x", cwd: "/somewhere/else" } }),
      encoding: "utf8",
      cwd: processCwdRepo,
      env: { ...process.env, PATH: dir },
    });
    expect(
      res.status,
      "an unreadable cwd must fail closed like the command read does, not silently resolve against the hook's own process cwd",
    ).toBe(2);
  });
});
