// --- pr-open: push decision must test equality, not containment (#223) ---
//
// Step 3 of pr-open decided whether the branch needed pushing with
// `git merge-base --is-ancestor HEAD "origin/$BRANCH"`. That predicate tests
// CONTAINMENT — local HEAD reachable from the remote tip — which is also true
// when local is BEHIND origin (another session already pushed there). The
// bug: pr-open read "contained in" as "already pushed", skipped the push, and
// opened a PR whose head ref carried the other session's commits under this
// session's PR description.
//
// The fix compares RESOLVED SHAS and pushes on any inequality, including a
// first push where `origin/<branch>` doesn't resolve at all. A genuinely
// diverged remote (behind, amended, or rebased — remote ref exists and is not
// an ancestor of HEAD) is refused BEFORE the push with pr-open's own message
// naming `--force-with-lease`, instead of `set -euo pipefail` surfacing git's
// raw non-fast-forward rejection.
//
// Fixture style follows tests/pr-cleanup-safety.test.ts and
// tests/pr-open-stacked-base.test.ts: a real bare remote + clone, a stubbed
// `gh` on PATH recording argv (no network), spawnSync so stderr is captured
// even on a non-zero exit.
//
// Run with: bun run test pr-open-push-state

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PR_OPEN = path.join(REPO_ROOT, "bin", "pr-open");
const REPO_BIN = path.join(REPO_ROOT, "bin");

// Every sandbox root, removed on normal exit AND on SIGINT/SIGTERM. `exit`
// alone does not fire on a signal — Node's default disposition terminates
// without emitting it — so Ctrl-C mid-run (each case now spawns pr-review
// with three stubbed lens calls) left a bare remote plus a clone per case
// under /tmp forever; the signal handlers close that gap and re-raise the
// conventional exit code afterward.
const SANDBOXES: string[] = [];
function cleanupSandboxes(): void {
	for (const root of SANDBOXES.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
process.on("exit", cleanupSandboxes);
process.on("SIGINT", () => { cleanupSandboxes(); process.exit(130); });
process.on("SIGTERM", () => { cleanupSandboxes(); process.exit(143); });

let failures = 0;
let checks = 0;

function check(cond: boolean, label: string, detail = ""): void {
	checks++;
	if (cond) {
		console.log(`  ✅ ${label}`);
	} else {
		console.error(`  ❌ ${label}${detail ? `\n     ${detail.split("\n").join("\n     ")}` : ""}`);
		failures++;
	}
}

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...GIT_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function commit(dir: string, file: string, body: string, msg: string): void {
	fs.writeFileSync(path.join(dir, file), body);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", msg]);
}

interface Sandbox {
	root: string;
	remote: string;
	clone: string;
	binDir: string;
	argvLog: string;
	branch: string;
	claudeMarker: string;
}

/**
 * A bare remote plus a clone on `main`, with a stub `gh` on PATH that records
 * its argv (so tests can assert whether/how `gh pr create` ran) and never
 * touches the network.
 */
function makeSandbox(branch: string): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-open-push-"));
	SANDBOXES.push(root);
	const remote = path.join(root, "remote.git");
	fs.mkdirSync(remote);
	git(remote, ["init", "-q", "--bare", "-b", "main"]);

	const clone = path.join(root, "clone");
	git(root, ["clone", "-q", remote, clone]);
	commit(clone, "README.md", "base\n", "base");
	git(clone, ["push", "-q", "origin", "main"]);

	git(clone, ["checkout", "-q", "-b", branch]);
	commit(clone, "a.txt", "a\n", "work");

	const binDir = path.join(root, "stubbin");
	fs.mkdirSync(binDir);
	const argvLog = path.join(root, "argv.log");
	fs.writeFileSync(argvLog, "");
	const gh = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}
echo "https://github.com/duppypro/princess-pi-packages/pull/999"
`;
	fs.writeFileSync(path.join(binDir, "gh"), gh);
	fs.chmodSync(path.join(binDir, "gh"), 0o755);
	// `claude` too, and for the same reason as `gh`: pr-open runs pr-review before
	// it creates a PR (#377), so an unstubbed PATH sent every case here to the
	// developer's real reviewer — measured at 196 real three-lens runs logged into
	// ~/.local/state/pr-review/clone/ from the test suite alone. The stub reports a
	// clean review, which is what these cases assume: they are about the push
	// decision, not the gate.
	//
	// Unlike `gh`, nothing else here proves the stub is the one that ran: every
	// case's assertions pass identically whether this stub answered or the
	// host's real reviewer did (both look like a clean review to pr-open), so a
	// future PATH change or a lost `chmod` could re-bill real calls silently
	// with the suite still green. `claudeMarker` closes that — runPrOpen()
	// asserts it after every run.
	const claudeMarker = path.join(root, "claude-called");
	fs.writeFileSync(path.join(binDir, "claude"),
		`#!/usr/bin/env bash\necho called >> ${JSON.stringify(claudeMarker)}\ncat >/dev/null\n` +
		`printf '%s' '{"is_error":false,"result":"{\\"findings\\":[]}"}'\n`,
		{ mode: 0o755 });

	return { root, remote, clone, binDir, argvLog, branch, claudeMarker };
}

/**
 * spawnSync, not execFileSync — the divergence message goes to stderr, and a
 * non-zero exit means execFileSync throws and discards stdout. Every
 * assertion here needs both the exit code AND the output on the same path.
 */
function runPrOpen(sb: Sandbox): { code: number; out: string; createdPr: boolean; pushArgs: string[] } {
	const r = spawnSync("bash", [PR_OPEN], {
		cwd: sb.clone,
		encoding: "utf8",
		// sb.binDir (the `claude`/`gh` stubs) and REPO_BIN are PREPENDED to the
		// host's own PATH, in that order, so the stub and the repo's own
		// pr-review shadow anything the host has installed. The host's PATH was
		// ALWAYS behind sb.binDir, before this diff too — the real `claude` used
		// to run not because of PATH ordering but because sb.binDir carried no
		// `claude` stub at all until now, so there was nothing there to shadow
		// it; the 196 real reviewer runs the comment on the `claude` stub above
		// measures are that gap, not a PATH-ordering bug. REPO_BIN is the actual
		// fix here: it makes `command -v pr-review` (bin/pr-open) resolve the
		// repo's own copy ahead of any `pr-review` installed to ~/bin. `pr-guard`
		// is unaffected either way — it is sourced by `readlink -f "$0"` from
		// beside pr-open itself, never resolved through PATH. The host's PATH is
		// kept, not replaced with a hardcoded list: pr-review also needs
		// `python3` and `timeout` resolvable, and a fixed "/usr/bin:/bin"
		// allowlist broke that on any host that installs them elsewhere
		// (homebrew, nix, asdf).
		env: {
			...process.env, ...GIT_ENV,
			PATH: [sb.binDir, REPO_BIN, process.env.PATH || ""].join(path.delimiter),
			// …and the review log stays in the sandbox rather than in the
			// developer's state dir, where 196 of them accumulated unnoticed.
			PR_REVIEW_LOG_DIR: path.join(sb.root, "review-logs"),
		},
	});
	const out = `${r.stdout || ""}${r.stderr || ""}`;
	const argv = fs.readFileSync(sb.argvLog, "utf8");
	const createdPr = argv.includes("pr create");
	// Gated on createdPr, not unconditional: several cases here refuse BEFORE
	// pr-open ever reaches pr-review (no origin remote, an undetermined or
	// diverged push state), and asserting the stub ran on those would be a
	// false failure. A created PR, though, cannot happen without pr-review
	// having run and reported clean — so this is a real canary for the gap
	// the `claude` stub's own comment describes, not a vacuous one.
	if (createdPr) {
		check(fs.existsSync(sb.claudeMarker),
			"pr created → the stubbed claude actually ran (not the host's real reviewer)",
			`missing ${sb.claudeMarker}`);
	}
	return { code: r.status ?? -1, out, createdPr, pushArgs: argv.split("\n") };
}

function remoteTip(sb: Sandbox): string {
	return git(sb.remote, ["rev-parse", `refs/heads/${sb.branch}`]);
}

function localTip(sb: Sandbox): string {
	return git(sb.clone, ["rev-parse", "HEAD"]);
}

// ---
// Cases
// ---

console.log("pr-open: push-state decision (#223)");

// 1. Up to date — local already pushed, sha for sha. Must not push again.
console.log("\nup to date:");
{
	const sb = makeSandbox("50-uptodate");
	git(sb.clone, ["push", "-q", "-u", "origin", sb.branch]);
	const before = remoteTip(sb);
	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 0, "exits 0", `got ${code}, output:\n${out}`);
	check(createdPr, "gh pr create ran", out);
	check(remoteTip(sb) === before, "remote tip unchanged — no redundant push", out);
	check(!/Pushing/.test(out), "no 'Pushing' message", out);
}

// 2. BEHIND — the bug. A second clone pushes past us; our local HEAD is
// CONTAINED IN origin/<branch> (the old, broken predicate reads that as
// "already pushed"). Must not silently reach `gh pr create` while
// local != remote — either push is refused, or corrected — but the old
// behavior (skip push, open PR anyway) must not happen.
console.log("\nbehind origin (another session pushed) — the bug:");
{
	const sb = makeSandbox("51-behind");
	git(sb.clone, ["push", "-q", "-u", "origin", sb.branch]);

	const other = path.join(sb.root, "other-clone");
	git(sb.root, ["clone", "-q", "-b", sb.branch, sb.remote, other]);
	commit(other, "b.txt", "b\n", "another session's work");
	git(other, ["push", "-q", "origin", sb.branch]);
	const otherTip = git(other, ["rev-parse", "HEAD"]);

	// sanity: our local HEAD is indeed behind — contained in the new remote tip.
	// Checked against the bare remote, not sb.clone: sb.clone has not fetched
	// the other clone's new commit object yet (that's the whole scenario), so
	// is-ancestor there would fail on a missing object, not a real ancestry
	// mismatch.
	const isAncestor = spawnSync(
		"git",
		["merge-base", "--is-ancestor", localTip(sb), otherTip],
		{ cwd: sb.remote },
	).status;
	check(isAncestor === 0, "fixture sanity: local HEAD is an ancestor of the new remote tip");

	const { code, out, createdPr } = runPrOpen(sb);
	// The bug under test: createdPr while local still != remote — a PR opened
	// on a head ref carrying commits this session never made. Whatever pr-open
	// does (push to reconcile, or refuse), it must not do THAT.
	const silentlyProceeded = createdPr && localTip(sb) !== remoteTip(sb);
	check(!silentlyProceeded, "does not silently proceed to gh pr create while local != remote", out);
	check(code === 6, "refuses — safety-gate-refused code (6)", `got ${code}, output:\n${out}`);
	check(!createdPr, "gh pr create did NOT run", out);
	check(/diverg/i.test(out), "message names the divergence", out);
	check(remoteTip(sb) === otherTip, "the other session's commit on origin is untouched", out);
}

// 3. Ahead — a normal, ordinary push. Must push, and the remote tip must land
// on local HEAD.
console.log("\nahead of origin (ordinary push):");
{
	const sb = makeSandbox("52-ahead");
	git(sb.clone, ["push", "-q", "-u", "origin", sb.branch]);
	commit(sb.clone, "c.txt", "c\n", "more work");

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 0, "exits 0", `got ${code}, output:\n${out}`);
	check(createdPr, "gh pr create ran", out);
	check(remoteTip(sb) === localTip(sb), "remote tip now equals local HEAD", out);
}

// 4. First push — origin/<branch> does not exist at all. Must push, no error
// about the missing ref.
console.log("\nfirst push (no origin/<branch> yet):");
{
	const sb = makeSandbox("53-firstpush");
	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 0, "exits 0", `got ${code}, output:\n${out}`);
	check(createdPr, "gh pr create ran", out);
	check(remoteTip(sb) === localTip(sb), "remote now has our branch at local HEAD", out);
	check(!/fatal|error/i.test(out), "no error about the missing remote ref", out);
}

// 5. Stale remote ref — the --prune regression test. The branch is deleted
// directly on the bare remote WITHOUT pruning the clone's remote-tracking
// ref, so `origin/<branch>` still resolves locally to the old (now-gone) sha.
// Without --prune on fetch, that stale ref reads as "already pushed" and
// pr-open never re-pushes.
console.log("\nstale remote-tracking ref (prior pr-cleanup deleted it) — the --prune regression test:");
{
	const sb = makeSandbox("54-stale");
	git(sb.clone, ["push", "-q", "-u", "origin", sb.branch]);
	const staleTip = remoteTip(sb);

	// delete on the bare remote directly — the clone's origin/<branch> is left
	// stale until something fetches with --prune
	git(sb.remote, ["update-ref", "-d", `refs/heads/${sb.branch}`]);
	check(
		git(sb.clone, ["rev-parse", `origin/${sb.branch}`]) === staleTip,
		"fixture sanity: local origin/<branch> is still the stale sha before pr-open runs",
	);

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 0, "exits 0", `got ${code}, output:\n${out}`);
	check(createdPr, "gh pr create ran", out);
	check(remoteTip(sb) === localTip(sb), "re-pushed — remote now has our branch again, at local HEAD", out);
}

// 6. Diverged — amend after pushing. Must exit non-zero with pr-open's OWN
// message naming --force-with-lease, not a raw git non-fast-forward
// rejection (and not a `set -e` crash with no context).
console.log("\ndiverged (amended after pushing):");
{
	const sb = makeSandbox("55-diverged");
	git(sb.clone, ["push", "-q", "-u", "origin", sb.branch]);
	const originalRemoteTip = remoteTip(sb);

	git(sb.clone, ["commit", "-q", "--amend", "-m", "work (amended)"]);

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 6, "exits with the safety-gate-refused code (6)", `got ${code}, output:\n${out}`);
	check(!createdPr, "gh pr create did NOT run", out);
	check(out.includes("--force-with-lease"), "message names --force-with-lease", out);
	check(out.includes("pr-open:"), "message is pr-open's own, not a raw git rejection", out);
	check(
		!/error: failed to push some refs|Updates were rejected/i.test(out),
		"not git's raw non-fast-forward rejection text",
		out,
	);
	check(remoteTip(sb) === originalRemoteTip, "remote tip untouched — no destructive push attempted", out);
}

// 7. Push REJECTED by the remote at the actual `git push` call (step 3, not
// caught by the pre-check above — this is an ordinary fast-forward-able
// "ahead" push that the divergence check waves through, but a server-side
// hook then declines). Distinct from case 6: that one never reaches
// `git push` at all. This one does, and git itself exits 1 — the #224
// contract's determined "no", so pr-open must map it to 6, never leak git's
// raw exit status.
console.log("\npush rejected by the remote at the actual push call (protected-branch hook):");
{
	const sb = makeSandbox("56-hook-rejected");
	git(sb.clone, ["push", "-q", "-u", "origin", sb.branch]);
	const originalRemoteTip = remoteTip(sb);
	commit(sb.clone, "d.txt", "d\n", "more work, ahead — an ordinary push");

	fs.mkdirSync(path.join(sb.remote, "hooks"), { recursive: true });
	fs.writeFileSync(
		path.join(sb.remote, "hooks", "pre-receive"),
		"#!/bin/sh\necho 'remote: protected branch — rejecting all pushes' >&2\nexit 1\n",
	);
	fs.chmodSync(path.join(sb.remote, "hooks", "pre-receive"), 0o755);

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 6, "exits with the safety-gate-refused code (6), not git's raw exit 1", `got ${code}, output:\n${out}`);
	check(!createdPr, "gh pr create did NOT run", out);
	check(out.includes("pr-open:"), "message is pr-open's own, not a bare crash", out);
	check(out.includes("rejected"), "message says the push was rejected", out);
	check(remoteTip(sb) === originalRemoteTip, "remote tip untouched — the hook's rejection held", out);
}

// 8. Push destination unreachable — undetermined, not a rejection. Fetch
// still succeeds (separate fetch URL, untouched), so this isolates the push
// call itself failing for a reason other than the remote refusing it: git
// exits 128 ("fatal: ..."), never 1, and pr-open must map that to 5, not 6 —
// this is not a "safety gate", nothing was determined.
console.log("\npush destination unreachable (undetermined — not a rejection):");
{
	const sb = makeSandbox("57-unreachable");
	git(sb.clone, ["push", "-q", "-u", "origin", sb.branch]);
	commit(sb.clone, "e.txt", "e\n", "more work, ahead — an ordinary push");

	// Split fetch/push URLs: fetch still reaches the real bare remote (so
	// step 2 succeeds and the divergence pre-check has real data), only the
	// PUSH destination is broken.
	git(sb.clone, ["remote", "set-url", "--push", "origin", path.join(sb.root, "does-not-exist.git")]);

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 5, "exits with the remote/API-failure code (5), not 6", `got ${code}, output:\n${out}`);
	check(!createdPr, "gh pr create did NOT run", out);
	check(out.includes("pr-open:"), "message is pr-open's own", out);
	check(!/rejected/i.test(out), "message does not claim the remote rejected it — it never got that far", out);
}

// 9. `git merge-base --is-ancestor` for the divergence pre-check fails with
// exit 128 (a bad/absent commit object — "could not check"), not exit 1
// ("checked, not an ancestor"). A `git` shim on PATH intercepts only that
// specific call and forces 128, delegating everything else (fetch, push,
// rev-parse) to the real git — isolating the merge-base check under test the
// same way tests/pr-cleanup-safety.test.ts's `failLsRemote` isolates
// `ls-remote` from the rest of `pr-cleanup`. Real corruption (a truncated
// loose object) was tried first and rejected: `git fetch` itself detects it
// during its own connectivity check and fails at exit 128 before pr-open
// ever reaches the merge-base call, so it can't isolate this path — verified
// empirically in a scratch sandbox, not assumed. Finding 1 (#268, ~line 91):
// a failed check must not be read as a confirmed divergence.
console.log("\nmerge-base check itself fails (128) — undetermined, not a confirmed divergence:");
{
	const sb = makeSandbox("58-mergebase-undetermined");
	git(sb.clone, ["push", "-q", "-u", "origin", sb.branch]);
	const originalRemoteTip = remoteTip(sb);
	// Any local change is enough to make LOCAL_SHA != REMOTE_SHA and reach the
	// merge-base pre-check — divergence direction doesn't matter here, the
	// shim intercepts the call before real ancestry is ever evaluated.
	commit(sb.clone, "f.txt", "f\n", "more work — reaches the pre-check");

	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const shim = `#!/usr/bin/env bash
if [ "$1" = "merge-base" ] && [ "$2" = "--is-ancestor" ]; then
  echo "fatal: Not a valid commit name (simulated corrupt/missing object)" >&2
  exit 128
fi
exec ${JSON.stringify(realGit)} "$@"
`;
	fs.writeFileSync(path.join(sb.binDir, "git"), shim);
	fs.chmodSync(path.join(sb.binDir, "git"), 0o755);

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 5, "exits with the remote/API-failure code (5), not 6", `got ${code}, output:\n${out}`);
	check(!createdPr, "gh pr create did NOT run", out);
	check(out.includes("pr-open:"), "message is pr-open's own", out);
	check(out.includes("could not check"), "message says the check could not run", out);
	check(
		!out.includes("history do not agree") && !out.includes("force-with-lease"),
		"message does NOT claim a confirmed divergence — the check never determined that",
		out,
	);
	check(remoteTip(sb) === originalRemoteTip, "remote tip untouched — no push was attempted on an undetermined state", out);
}

// 10. No `origin` remote configured at all. A determinate fact about local
// git config — #224 code 4 ("not found"), not code 5 ("could not determine
// remote state"). Must be caught BEFORE `git fetch origin` is even attempted
// (which would also fail, but at exit 128 either way — indistinguishable
// from an unreachable host without this separate, purely local check).
// Finding 2 (#268, ~lines 75-76).
console.log("\nno 'origin' remote configured — not-found, not undetermined:");
{
	const sb = makeSandbox("59-no-origin");
	git(sb.clone, ["remote", "remove", "origin"]);

	const { code, out, createdPr } = runPrOpen(sb);
	check(code === 4, "exits with the not-found code (4), not 5", `got ${code}, output:\n${out}`);
	check(!createdPr, "gh pr create did NOT run", out);
	check(out.includes("pr-open:"), "message is pr-open's own", out);
	check(/origin/i.test(out), "message names the missing 'origin' remote", out);
	check(!/Fetching/.test(out), "never attempted to fetch — the check runs before step 2's fetch", out);
}

// ---

console.log(
	`\n${failures === 0 ? "✅" : "❌"} pr-open push-state: ${checks - failures} of ${checks} checks passed.`,
);
process.exit(failures > 0 ? 1 : 0);
