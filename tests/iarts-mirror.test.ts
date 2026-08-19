// iarts-mirror: the record it prints must describe the branch it actually mirrored (#384)
//
// This script is the ONLY second copy of `iarts/local` — that branch never
// reaches the client's origin. Its stdout is therefore not a progress message
// but the evidence that the copy happened, read by a human at end of session and
// parsed by column per the Agent-First Output standard. A record that says
// `updated` when nothing was observed, or reports a sha that is not the branch
// tip, is worse than no record: it retires the reader's suspicion.
//
// Real sandbox, not mocks: the properties under test are what git actually does
// with ambiguous refnames and with a missing remote, which a mocked `git` cannot
// disprove. Same fixture shape as tests/git-checkpoint-guard.test.ts.
//
// The three cases below come from macroscopeapp on PR #385, each verified against
// git's behaviour before being adopted — and one of them extended, because the
// reported line was the harmless half of a pair.
//
// Run with: bun tests/iarts-mirror.test.ts

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const IARTS_MIRROR = path.join(REPO_ROOT, "bin", "iarts-mirror");

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

// Cut the developer's git config out of the sandbox (#228) — see the note in
// tests/git-checkpoint-guard.test.ts for why a shared global config made a
// suite measure the host instead of the script.
const GIT_ENV = {
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
	GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd, encoding: "utf8",
		env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

const BRANCH = "iarts/local";
// The script hard-codes both names and exits 1 if EITHER fails, so a fixture
// with only one clone made every run exit 1 on a `no-clone` for the other — the
// exit-code assertions were measuring the fixture, not the script.
const REPOS = ["robotic_hardware", "rusty-robots"] as const;
const REPO = REPOS[0];   // the one the assertions below inspect

interface Sandbox { root: string; mirrorRoot: string; cloneRoot: string; clone: string; bare: string }

/** A clone holding `iarts/local`, and an empty mirror root for it to be copied into. */
function makeSandbox(): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "iarts-mirror-"));
	const mirrorRoot = path.join(root, "git-remotes");
	const cloneRoot = path.join(root, "git-projects");
	fs.mkdirSync(mirrorRoot);
	fs.mkdirSync(cloneRoot);

	for (const repo of REPOS) {
		const c = path.join(cloneRoot, repo);
		fs.mkdirSync(c);
		git(c, ["init", "-q", "-b", "client-main"]);
		fs.writeFileSync(path.join(c, "client.txt"), `client source for ${repo}\n`);
		git(c, ["add", "-A"]);
		git(c, ["commit", "-q", "-m", "client base"]);
		git(c, ["checkout", "-q", "-b", BRANCH]);
		fs.mkdirSync(path.join(c, ".iarts"));
		fs.writeFileSync(path.join(c, ".iarts", "STATUS.md"), "our work\n");
		git(c, ["add", "-A"]);
		git(c, ["commit", "-q", "-m", "iarts work"]);
	}

	return { root, mirrorRoot, cloneRoot,
		clone: path.join(cloneRoot, REPO), bare: path.join(mirrorRoot, `${REPO}.git`) };
}

function run(sb: Sandbox) {
	try {
		const out = execFileSync("bash", ["-c", `"$@" 2>&1`, "_", IARTS_MIRROR], {
			cwd: sb.root, encoding: "utf8",
			env: { ...process.env, ...GIT_ENV,
				IARTS_MIRROR_ROOT: sb.mirrorRoot, IARTS_CLONE_ROOT: sb.cloneRoot },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}

/** The record for our repo, split into its documented columns. */
function record(out: string): string[] {
	const line = out.split("\n").find(l => l.startsWith(REPO));
	return line ? line.split(/\s+/) : [];
}

/** Point every clone at its mirror the way the .iarts convention does. */
function addMirrorRemote(sb: Sandbox): void {
	for (const repo of REPOS) {
		git(path.join(sb.cloneRoot, repo), ["remote", "add", "mirror", path.join(sb.mirrorRoot, `${repo}.git`)]);
	}
}

// ---
// The sha in the record is the branch tip — never a same-named tag
// ---
// `git rev-parse iarts/local` resolves refs/tags/ BEFORE refs/heads/
// (gitrevisions), so a tag of that name wins. Measured directly: with branch
// 3343477 and tag e35fd13 present, both `rev-parse iarts/local` and
// `rev-parse --verify --quiet iarts/local` returned the TAG — and `--quiet`
// suppressed the ambiguity warning, making the `before` read the silent half.
//
// Both reads are covered, in one case, deliberately: fixing only the reported
// `after` would leave before=tag and after=branch permanently unequal, so every
// run would report `updated`. A partial fix here is worse than none.
console.log("\na same-named tag never displaces the branch in the record:");
{
	const sb = makeSandbox();
	addMirrorRemote(sb);

	const first = run(sb);
	check(record(first.out)[3] === "updated", "first run reports updated", first.out);

	const tip = git(sb.clone, ["rev-parse", `refs/heads/${BRANCH}`]);
	// A tag of the same name on a DIFFERENT commit, inside the mirror. The branch's
	// own parent, because the mirror fetched only `refs/heads/iarts/local` — an
	// object from elsewhere in the clone is not there to be tagged.
	const decoy = git(sb.bare, ["rev-parse", `refs/heads/${BRANCH}^`]);
	git(sb.bare, ["tag", BRANCH, decoy]);
	check(decoy !== tip, "the decoy tag really points somewhere else (fixture is honest)",
		`tag ${decoy} vs branch ${tip}`);

	const second = run(sb);
	const cols = record(second.out);
	check(cols[2] === tip, "the sha reported is the branch tip, not the tag",
		`got ${cols[2]}, branch ${tip}, tag ${decoy}\n${second.out}`);
	check(cols[3] === "unchanged", "nothing moved, so the status is unchanged",
		`got '${cols[3]}' — a partial fix (only 'after' qualified) reports 'updated' here\n${second.out}`);
	check(!/ambiguous/.test(second.out), "no ambiguous-refname warning leaks into the record", second.out);
}

// ---
// A clone that cannot observe its mirror says so
// ---
// With no `mirror` remote the clone has no upstream at all: `git status -sb`
// prints a bare `## iarts/local` and the prompt reports NOTHING, rather than
// reporting drift (verified against both live clones, which track
// `mirror/iarts/local`). The reason to mark it is stronger than a lying prompt —
// such a clone cannot see the mirror in either direction, so the one property
// this tool gives the reader is unavailable, and a bare `updated` would claim a
// completeness the run does not have.
console.log("\na clone with no mirror remote is reported refstale:");
{
	const sb = makeSandbox();   // deliberately NO mirror remote
	const { code, out } = run(sb);
	const cols = record(out);

	check(cols[3] === "updated-refstale", "no mirror remote → updated-refstale", `got '${cols[3]}'\n${out}`);
	check(code === 0, "the copy succeeded, so the exit code stays 0", `got ${code}: ${out}`);
	// The mirror really does hold the work — refstale is about the clone's view.
	const mirrored = git(sb.bare, ["rev-parse", `refs/heads/${BRANCH}`]);
	const tip = git(sb.clone, ["rev-parse", `refs/heads/${BRANCH}`]);
	check(mirrored === tip, "refstale still means THE WORK IS SAFE — the mirror holds the tip",
		`mirror ${mirrored} vs clone ${tip}`);
}

console.log("\na clone WITH a working mirror remote is not marked refstale:");
{
	const sb = makeSandbox();
	addMirrorRemote(sb);
	const { code, out } = run(sb);
	const cols = record(out);
	check(cols[3] === "updated", "working mirror remote → bare updated (no false refstale)",
		`got '${cols[3]}'\n${out}`);
	check(code === 0, "exit 0", `got ${code}: ${out}`);
	// The point of #384: the clone's own view moved too.
	const seen = git(sb.clone, ["rev-parse", `refs/remotes/mirror/${BRANCH}`]);
	const tip = git(sb.clone, ["rev-parse", `refs/heads/${BRANCH}`]);
	check(seen === tip, "the clone's refs/remotes/mirror/* was refreshed — the #384 property",
		`mirror-view ${seen} vs branch ${tip}`);
}

// ---
// The documented statuses are the ones it can actually emit
// ---
// The record is parsed by column, so `status` is a contract. A status the script
// emits but the usage text does not list is a silent breaking change waiting to
// happen for anything exact-matching it.
console.log("\nevery status the script emits is documented:");
{
	const src = fs.readFileSync(IARTS_MIRROR, "utf8");
	const emitted = new Set<string>();
	for (const m of src.matchAll(/\\t([a-z][a-z-]*)\\n'/g)) emitted.add(m[1]);
	// The two composed forms are built from $status$refstale, not printed literally.
	for (const m of src.matchAll(/status=([a-z]+)/g)) emitted.add(m[1]);
	const usage = src.slice(0, src.indexOf("USAGE\n"));
	const undocumented = [...emitted].filter(st => !usage.includes(st));
	check(emitted.size >= 5, "the scan found the statuses at all", [...emitted].join(", "));
	check(undocumented.length === 0, "no status is emitted without being documented",
		undocumented.join(", "));
	check(/-refstale/.test(usage) && /SAFE|safe/.test(usage),
		"the usage text says a -refstale run is still safe", "");
}

console.log(`\n${failures === 0 ? "✅" : "❌"} iarts-mirror: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);
