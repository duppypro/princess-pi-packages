/**
 * @package princess-pi-packages
 * @tool tests/doc-claims-vs-hooks.test.ts — prose claims about the git guardrails,
 *   checked against the guardrails (#381)
 * @description Every document that tells a reader what `block-dangerous-git.sh`
 *   blocks is asserting something checkable. Until this suite existed, none of
 *   those assertions were checked, and one of them was false: the untracked
 *   `~/git-projects/CLAUDE.md` listed `git push` among commands blocked
 *   unconditionally, with the `main`/`master` qualifier attached only to the
 *   #301 additions. An agent read it, believed it, and wrote "the guardrails
 *   hook blocks agent `git push`" into four artifacts in another repo — during a
 *   session in which `pr-open` pushed a branch for it four times.
 *
 *   Two failure directions, and a probe-only suite catches just one of them:
 *
 *     1. The hook's behaviour changes and a doc still asserts the old one.
 *        Caught by the probes.
 *     2. A doc is reworded into a false claim while the hook stays put.
 *        Caught by pinning the sentence. This is the one that actually
 *        happened, and behaviour probes alone are blind to it.
 *
 *   So each claim carries BOTH a verbatim quote that must still appear in its
 *   document AND the probes that quote asserts. A reword fails loudly rather
 *   than silently dropping its verification.
 *
 *   Host-only documents (`~/git-projects/CLAUDE.md` is untracked by design —
 *   ADR 0001 leaves it to a future dotfiles-doctor) report `##SKIP##` when
 *   absent rather than passing. CI has no such file; a green run there must not
 *   read as "the host doc was checked".
 *
 * @usage bun run test doc-claims-vs-hooks
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkGitCommand } from "../extensions/lib/git-guardrails-core";
import { skip } from "./lib/skips";

const REPO_ROOT = join(import.meta.dir, "..");
const SH_HOOK = join(REPO_ROOT, "hooks", "block-dangerous-git.sh");

type Verdict = "allow" | "block";

interface Probe {
	/** Shell command as an agent would run it. */
	command: string;
	/** Branch the cwd repo is on when it runs. */
	branch: string;
	/** What the quoted sentence claims the guardrails do with it. */
	verdict: Verdict;
	/**
	 * Extra environment for the `.sh` hook run (#390). A probe that names one is
	 * about the HOOK's own dependencies, so it is checked against the `.sh` only —
	 * the TS twin is called in-process and has no separate environment, and no
	 * parse step to break. Recorded here rather than skipped silently.
	 */
	env?: Record<string, string>;
}

interface Claim {
	/** Path to the document. Relative paths resolve inside this repo. */
	doc: string;
	/** True when the document lives on the host and is tracked by no repo. */
	hostOnly?: boolean;
	/**
	 * Verbatim substring that carries the claim. Whitespace is normalised
	 * before matching, so a reflow is tolerated but a REWORD is not — and a
	 * reword is the event this pin exists to catch.
	 */
	quote: string;
	/** What the sentence commits the hook to, for the failure message. */
	asserts: string;
	probes: Probe[];
}

// ---
// The claims. Adding a document that describes the guardrails means adding it
// here — a guardrail-describing doc with no entry is a claim nobody checks.
// ---

const FEATURE = "381-doc-claims-vs-hooks";

const PUSH_PROBES: Probe[] = [
	// The claim that was false in ~/git-projects/CLAUDE.md, in both directions.
	{ command: `git push origin ${FEATURE}`, branch: FEATURE, verdict: "allow" },
	{ command: "git push", branch: FEATURE, verdict: "allow" },
	{ command: `git push -u origin ${FEATURE}`, branch: FEATURE, verdict: "allow" },
	{ command: "git push origin main", branch: FEATURE, verdict: "block" },
	{ command: "git push", branch: "main", verdict: "block" },
];

const ALWAYS_PROBES: Probe[] = [
	// The genuinely unconditional class — blocked on a feature branch too.
	{ command: "git clean -fd", branch: FEATURE, verdict: "block" },
	{ command: "git checkout .", branch: FEATURE, verdict: "block" },
	{ command: "git restore .", branch: FEATURE, verdict: "block" },
];

const ON_MAIN_PROBES: Probe[] = [
	{ command: "git commit -m x", branch: "main", verdict: "block" },
	{ command: "git commit -m x", branch: FEATURE, verdict: "allow" },
	{ command: "git pull", branch: "main", verdict: "block" },
	{ command: "git pull --ff-only", branch: "main", verdict: "allow" },
	{ command: "git switch -c 999-escape", branch: "main", verdict: "allow" },
];

// #389: "regardless of flags" is a claim about gh's GLOBAL options, and it was
// false — check_gh_command tested positional adjacency, so `-R owner/repo`
// (the ordinary way an agent addresses a repo it is not standing in) shifted
// `pr merge` out of view and walked the human-only gate.
const GH_MERGE_PROBES: Probe[] = [
	{ command: "gh pr merge 5", branch: FEATURE, verdict: "block" },
	{ command: "gh -R o/r pr merge 5", branch: FEATURE, verdict: "block" },
	{ command: "gh --repo o/r pr merge 5", branch: FEATURE, verdict: "block" },
	{ command: "gh --repo=o/r pr merge 5", branch: FEATURE, verdict: "block" },
	{ command: "gh --hostname github.com pr merge", branch: FEATURE, verdict: "block" },
	{ command: "sudo gh pr merge --squash", branch: FEATURE, verdict: "block" },
	{ command: "GH_HOST=github.com gh pr merge", branch: FEATURE, verdict: "block" },
	{ command: "gh pr create --base main", branch: FEATURE, verdict: "allow" },
	{ command: "gh -R o/r pr view 42", branch: FEATURE, verdict: "allow" },
];

// #390: a PATH whose only entries are the named real binaries, plus whatever
// `extra` writes in. Anything not listed is genuinely missing for that run.
function stubPath(extra: (dir: string) => void, keep = ["bash", "cat", "git", "realpath"]): string {
	const dir = mkdtempSync(join(tmpdir(), "doc-claim-stubpath-"));
	for (const bin of keep) {
		symlinkSync(execSync(`command -v ${bin}`, { encoding: "utf8" }).trim(), join(dir, bin));
	}
	extra(dir);
	return dir;
}

const JQ_BROKEN = stubPath((d) => writeFileSync(join(d, "jq"), "#!/bin/sh\nexit 127\n", { mode: 0o755 }));
const JQ_MISSING = stubPath(() => {});
const JQ_UNREADABLE = stubPath((d) => writeFileSync(join(d, "jq"), "#!/bin/sh\nexit 0\n", { mode: 0o644 }));

const JQ_PROBES: Probe[] = [
	{ command: "git push origin main", branch: FEATURE, verdict: "block", env: { PATH: JQ_BROKEN } },
	{ command: "git push origin main", branch: FEATURE, verdict: "block", env: { PATH: JQ_MISSING } },
	{ command: "git push origin main", branch: FEATURE, verdict: "block", env: { PATH: JQ_UNREADABLE } },
	// ...and a working jq still decides on the merits, in both directions.
	{ command: "git push origin main", branch: FEATURE, verdict: "block" },
	{ command: `git push origin ${FEATURE}`, branch: FEATURE, verdict: "allow" },
];

const CLAIMS: Claim[] = [
	{
		doc: "hooks/block-dangerous-git.sh",
		quote: "Block on main/master only: push whose DESTINATION ref is main/master",
		asserts: "push is gated on destination, not blocked outright",
		probes: PUSH_PROBES,
	},
	{
		doc: "extensions/git-guardrails.ts",
		quote: "Block on main/master only: push whose DESTINATION ref is main/master",
		asserts: "the Pi twin makes the same destination-aware claim",
		probes: PUSH_PROBES,
	},
	{
		doc: "hooks/block-dangerous-git.sh",
		quote: "Always block: checkout ., restore ., clean -f/-fd, worktree remove --force",
		asserts: "these discard work and are blocked on any branch",
		probes: ALWAYS_PROBES,
	},
	{
		doc: "docs/dev-workflow-spec.md",
		quote: "`block-dangerous-git.sh` is **destination-aware, not a flat block list**",
		asserts: "the tracked spec denies a flat block list",
		probes: PUSH_PROBES,
	},
	{
		doc: "docs/dev-workflow-spec.md",
		quote: "it blocks by push *destination*, and a feature branch is not `main`",
		asserts: "a feature-branch push is allowed, and wt-new's recovery step depends on it",
		probes: [
			{ command: `git push -u origin ${FEATURE}`, branch: FEATURE, verdict: "allow" },
		],
	},
	{
		doc: "docs/dev-workflow-spec.md",
		quote: "**`gh pr merge` in any form is human-only**, regardless of flags",
		asserts: "no gh global option can shift the merge gate out of view (#389)",
		probes: GH_MERGE_PROBES,
	},
	{
		doc: "docs/dev-workflow-spec.md",
		quote: "A `jq` that is missing, not executable, or exits non-zero now\n**blocks (exit 2)** and names the dependency",
		asserts: "the hook fails CLOSED when it cannot read the tool call (#390)",
		probes: JQ_PROBES,
	},
	{
		doc: join(homedir(), "git-projects", "CLAUDE.md"),
		hostOnly: true,
		quote: "Pushing a feature branch to a non-main ref is allowed, and always was",
		asserts: "the host's domain rules no longer claim push is blocked outright (#381)",
		probes: [...PUSH_PROBES, ...ALWAYS_PROBES, ...ON_MAIN_PROBES],
	},
];

// ---
// Harness
// ---

let failures = 0;
let checks = 0;
let skipped = 0;

function check(cond: boolean, label: string, detail = ""): void {
	checks++;
	if (cond) {
		console.log(`  ✅ ${label}`);
		return;
	}
	console.error(`  ❌ ${label}${detail ? `\n     ${detail.split("\n").join("\n     ")}` : ""}`);
	failures++;
}

/** Collapse runs of whitespace so a reflowed paragraph still matches. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

function repoOnBranch(branch: string): string {
	const dir = mkdtempSync(join(tmpdir(), "doc-claim-"));
	execSync(`git init -q -b "${branch}"`, { cwd: dir });
	return dir;
}

function shVerdict(command: string, cwd: string, env?: Record<string, string>): Verdict {
	const input = JSON.stringify({ tool_input: { command, cwd } });
	const res = spawnSync("bash", [SH_HOOK], {
		input,
		encoding: "utf8",
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
	if (res.status === 0) return "allow";
	if (res.status === 2) return "block";
	throw new Error(`hook exited ${res.status} (expected 0 or 2): ${res.stderr || res.stdout}`);
}

const tsVerdict = (command: string, cwd: string): Verdict =>
	checkGitCommand(command, cwd) === null ? "allow" : "block";

// One throwaway repo per branch, reused across probes — branch state is real,
// not mocked, exactly as tests/git-guardrails-parity.test.ts materializes it.
const repos = new Map<string, string>();
const repoFor = (branch: string): string => {
	let dir = repos.get(branch);
	if (!dir) {
		dir = repoOnBranch(branch);
		repos.set(branch, dir);
	}
	return dir;
};

// ---
// Run
// ---

console.log("doc claims vs the git guardrails (#381)\n");

let probesRun = 0;
let probesExpected = 0;

for (const claim of CLAIMS) {
	const path = claim.doc.startsWith("/") ? claim.doc : join(REPO_ROOT, claim.doc);
	const label = claim.hostOnly ? claim.doc.replace(homedir(), "~") : claim.doc;

	if (!existsSync(path)) {
		if (claim.hostOnly) {
			skip(`no ${label} on this machine — the claim "${claim.asserts}" went unchecked`);
			skipped++;
			continue; // and its probes are NOT expected — see the floor check below
		}
		check(false, `${label} exists`, `tracked document is missing: ${path}`);
		continue;
	}
	probesExpected += claim.probes.length;

	// 1. The sentence still says what the probes below assert.
	const body = flat(readFileSync(path, "utf8"));
	check(
		body.includes(flat(claim.quote)),
		`${label} still states: ${claim.asserts}`,
		`pinned sentence not found:\n  "${claim.quote}"\n` +
			"The document was reworded, so this claim lost its verification.\n" +
			"Re-verify the new wording against the hook, then update the quote here —\n" +
			"do not delete the entry.",
	);

	// 2. Both hook implementations agree with what the sentence claims.
	for (const p of claim.probes) {
		const cwd = repoFor(p.branch);
		const sh = shVerdict(p.command, cwd, p.env);
		// An env probe is about the .sh's own dependencies — the TS twin runs
		// in-process, so there is no environment to give it and nothing to check.
		const ts = p.env ? "n/a" : tsVerdict(p.command, cwd);
		probesRun++;
		check(
			sh === p.verdict && (ts === "n/a" || ts === p.verdict),
			`${label}: \`${p.command}\`${p.env ? ` [env: ${Object.keys(p.env).join(",")}]` : ""} on ${p.branch} → ${p.verdict}`,
			`sh hook said ${sh}, ts core said ${ts}; the document claims ${p.verdict}.\n` +
				"Either the guardrails changed and the document is now false,\n" +
				"or this expectation was wrong. Read the hook before editing either.",
		);
	}
}

// No silent caps: a wiring slip that skips probes must not read green. The floor
// is derived from the claims that were actually checkable on this host, never a
// constant — a constant turns CI's legitimate host-doc skip into a red run, which
// is how a suite gets its threshold quietly lowered until it asserts nothing.
check(
	probesRun === probesExpected,
	`ran every probe the checkable claims declare (${probesRun}/${probesExpected})`,
	"a probe was declared but never run — check the wiring",
);
check(
	probesExpected > 0,
	"at least one claim was checkable on this host",
	"every document in the claim table was missing; this run asserted nothing",
);

console.log(
	`\n${failures === 0 ? "✅" : "❌"} doc claims vs hooks: ${checks - failures} of ${checks} checks passed` +
		`, ${probesRun} probes${skipped ? `, ${skipped} host document(s) skipped` : ""}.`,
);
process.exit(failures > 0 ? 1 : 0);
