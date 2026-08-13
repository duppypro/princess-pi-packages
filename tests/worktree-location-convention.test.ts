// Worktree location convention (#257)
//
// #257 moved worktrees back in-tree, to Claude Code's native
// `<clone>/.claude/worktrees/<branch>`, reversing the out-of-tree convention
// (`~/git-projects/worktrees/<repo>/<branch>`) that #139 introduced.
//
// In-tree has exactly one cost, and it is a footgun rather than an
// inconvenience: `git-checkpoint` runs `git add -A`, so an un-ignored worktree
// directory means committing an entire nested checkout — every file in the repo,
// twice, on a branch that never touched them. That is what these checks gate.
//
// The subtle part is WHERE the ignore lives. Before this change the pattern was
// already present on this machine — in `.git/info/exclude`, an untracked
// per-clone file that no other checkout inherits. It worked here and protected
// nobody else, which is indistinguishable from working until someone clones the
// repo on a second machine. So it is not enough to assert "the path is
// ignored": check 1 proves a FRESH repo carrying only this repo's tracked
// `.gitignore` ignores it, and check 2 proves the tracked file — not the local
// exclude — is what wins here.
//
// Run with: bun run test worktree-location-convention

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GITIGNORE = path.join(REPO_ROOT, ".gitignore");
const SPEC = path.join(REPO_ROOT, "docs", "dev-workflow-spec.md");

/** A representative in-tree worktree path, in the `<issue#>-<slug>` branch naming standard. */
const SAMPLE = ".claude/worktrees/257-worktrees-in-tree/tests/run.ts";

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

function git(args: string[], cwd: string): { status: number; out: string } {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
		return { status: 0, out };
	} catch (err: any) {
		return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

console.log("Worktree location convention (#257)");

// ---
// 1. A FRESH repo carrying only this repo's tracked .gitignore ignores the path.
//    No `.git/info/exclude`, no `core.excludesFile` — the tracked file alone.
//    This is the check that a second machine would have failed before #257.
// ---
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-location-"));
	try {
		git(["init", "-q"], tmp);
		fs.copyFileSync(GITIGNORE, path.join(tmp, ".gitignore"));
		// `core.excludesFile=/dev/null` neutralises any global ignore file the
		// developer running this happens to have. `info/exclude` is empty by
		// construction in a fresh `git init`.
		const r = git(["-c", "core.excludesFile=/dev/null", "check-ignore", "-v", SAMPLE], tmp);
		check(
			r.status === 0,
			"tracked .gitignore alone ignores an in-tree worktree path (fresh repo, no local excludes)",
			`git check-ignore exited ${r.status} for ${SAMPLE}\n${r.out}`,
		);
		check(
			r.out.startsWith(".gitignore:"),
			"the matching pattern comes from .gitignore",
			`check-ignore reported: ${r.out.trim()}`,
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

// ---
// 2. In THIS checkout, the tracked .gitignore is what wins — not a leftover
//    `.git/info/exclude` line. .gitignore outranks info/exclude in git's
//    precedence order, so a source of `.gitignore` here proves the local
//    exclude is redundant and can be deleted without losing the protection.
// ---
{
	const r = git(["check-ignore", "-v", SAMPLE], REPO_ROOT);
	check(r.status === 0, "in-tree worktree path is ignored in this checkout", `exited ${r.status}: ${r.out}`);
	check(
		r.out.includes("/.gitignore:") || r.out.startsWith(".gitignore:"),
		"this checkout's ignore comes from tracked .gitignore, not .git/info/exclude",
		`check-ignore reported: ${r.out.trim()}`,
	);
}

// ---
// 3. The property itself, end to end: a real worktree created at the standard
//    in-tree location leaves `git status` clean. This is the `git add -A` gate —
//    reasoning about ignore patterns is not the same as watching status stay
//    empty with a full nested checkout sitting on disk.
// ---
{
	const probe = path.join(REPO_ROOT, ".claude", "worktrees", "probe-257-location");
	const before = git(["status", "--porcelain", "-uall"], REPO_ROOT).out;
	let added = false;
	try {
		const add = git(["worktree", "add", "--detach", probe, "HEAD"], REPO_ROOT);
		added = add.status === 0;
		check(added, "git worktree add succeeds at <clone>/.claude/worktrees/<name>", add.out);
		if (added) {
			check(
				fs.existsSync(path.join(probe, "CLAUDE.md")),
				"the in-tree worktree is a real checkout (CLAUDE.md present)",
				probe,
			);
			const after = git(["status", "--porcelain", "-uall"], REPO_ROOT).out;
			check(
				after === before,
				"a populated in-tree worktree leaves `git status -uall` unchanged (git add -A is safe)",
				`before:\n${before || "(clean)"}\nafter:\n${after || "(clean)"}`,
			);
		}
	} finally {
		if (added) {
			const rm = git(["worktree", "remove", "--force", probe], REPO_ROOT);
			if (rm.status !== 0) fs.rmSync(probe, { recursive: true, force: true });
		}
	}
}

// ---
// 4. The ignore pattern must not swallow anything TRACKED. An ignore rule over a
//    directory that later gains a committed file is a silent trap: the file
//    stays in the index but every fresh `git add` skips its changes.
// ---
{
	const tracked = git(["ls-files", "--", ".claude/"], REPO_ROOT).out.trim();
	check(tracked === "", "no tracked file lives under .claude/ (the ignore hides nothing committed)", tracked);
}

// ---
// 5. The spec must not still route agents to the retired out-of-tree path.
//    dev-workflow-spec.md is an instruction surface, so a stale absolute path
//    there is not a stale comment — it is a wrong instruction an agent follows.
//    Scoped to this one file on purpose: the older spec-*.md documents record
//    the out-of-tree era as history, and history should not be rewritten.
//
//    One exemption, drawn on a structural boundary rather than on wording: the
//    subsection explaining WHY the rule reversed has to name the path it
//    reversed, or a reader whose memory says "out-of-tree" finds nothing to
//    correct it. So the retired path may appear under that heading and nowhere
//    else. Matching on a `###` heading keeps the rule mechanical — the
//    alternative, guessing from phrasing whether a line reads as history, is
//    the kind of prose-matching that has no contract behind it.
// ---
{
	const specSrc = fs.readFileSync(SPEC, "utf8");
	const HISTORY_HEADING = "### Why this reverses the out-of-tree rule";
	const lines = specSrc.split("\n");
	const start = lines.findIndex((l) => l.startsWith(HISTORY_HEADING));
	check(start !== -1, `spec keeps the '${HISTORY_HEADING}...' subsection (the exemption's anchor)`, SPEC);
	// The exempt span runs from that heading to the next heading of any level.
	const end = start === -1 ? -1 : lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
	const exemptFrom = start === -1 ? Infinity : start;
	const exemptTo = end === -1 ? lines.length : end;

	const stale = lines
		.map((l, i) => [i + 1, l] as const)
		.filter(([n, l]) => l.includes("git-projects/worktrees/") && !(n - 1 >= exemptFrom && n - 1 < exemptTo));
	check(
		stale.length === 0,
		"outside its history subsection, dev-workflow-spec.md never names the retired out-of-tree layout",
		stale.map(([n, l]) => `${SPEC}:${n}: ${l.trim()}`).join("\n"),
	);
	check(
		specSrc.includes(".claude/worktrees/"),
		"dev-workflow-spec.md names the in-tree .claude/worktrees/ layout",
		SPEC,
	);
}

console.log(`\n${failures === 0 ? "✅" : "❌"} worktree location convention: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
